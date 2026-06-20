import {
  ExFactExtractionSchema,
  CanonFactSchema,
  type Character,
  type Message,
  type ConversationSession,
  type CanonFact,
} from '@dsim/shared';
import { charactersRepo, canonFactsRepo, npcKnowledgeRepo, eventsRepo } from '../db/repositories';
import { getLlmSettings } from './settings-service';
import { callStructuredLlm } from '../llm/structured';
import { buildExFactMessages } from '../prompt/prompt-builder';
import { recordEvent } from './event-service';
import { newId } from '../lib/ids';

/**
 * Ex-canonization: when a character REVEALS a fact about their ex on a date, that
 * fact becomes reactive canon about the ex — but ONLY if the ex is authored
 * opt-in (`allowsExCanonization`), and only after a stack of model-independent
 * safety checks. Facts are written to the DERIVED `canon_facts` table, NEVER the
 * authored character row; they are append-only, reversible, and wiped by reset.
 */

export const EX_CANON = {
  maxFactsPerDate: 4, // also bounded by ExFactExtractionSchema.facts.max(4)
  maxPerSubject: 12, // lifetime cap of facts about one character
  maxPerWorldDay: 6, // anti-grief: total new canonizations per in-world day
  llmTimeoutMs: 20000,
} as const;

// Model-INDEPENDENT safety backstop: reject any value touching crime/violence/
// medical/sexual/demeaning content regardless of what the model returned. Not
// exhaustive — it sits behind the guardrail + the restricted category enum.
const DENYLIST =
  /\b(kill|killed|murder|assault|rape|abus|stalk|stole|steal|theft|fraud|arrest|prison|jail|cancer|hiv|aids|std|sti|overdose|suicid|self[- ]?harm|diagnos|disorder|depress|anorexi|bulimi|addict|slut|whore|retard)\w*/i;

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Server-owned sensitivity: 'habit' is touchy by default; the model may UPGRADE
 *  others to touchy but can never DOWNGRADE a baseline-touchy category. */
function sensitivityFor(category: string, llm: 'neutral' | 'touchy'): 'neutral' | 'touchy' {
  return category === 'habit' || llm === 'touchy' ? 'touchy' : 'neutral';
}

/** Active canon facts ABOUT a character (the subject), for the date reaction block. */
export function listCanonFactsForPrompt(
  characterId: string,
): Array<{ category: string; value: string; sensitivity: string }> {
  return canonFactsRepo
    .listBySubject(characterId, { status: 'active' })
    .slice(0, 3)
    .map((f) => ({ category: f.category, value: f.value, sensitivity: f.sensitivity }));
}

/** All canon facts about a character (every status) — for creator/dev inspection. */
export function listCanonFactsForCharacter(characterId: string): CanonFact[] {
  return canonFactsRepo.listBySubject(characterId);
}

/** Reverse a canonization: mark it rejected AND let its gossip residue go stale. */
export function rejectCanonFact(id: string): void {
  canonFactsRepo.reject(id);
  npcKnowledgeRepo.markStaleByCanon(id);
  recordEvent('exfact_rejected', { canonId: id });
}

/** Soft anti-grief cap: count canonizations across the world on an in-world day. */
function canonizedOnDay(day: number): number {
  return eventsRepo
    .list(400)
    .filter((e) => e.type === 'exfact_canonized' && (e.payload as Record<string, unknown>).day === day).length;
}

/**
 * Extraction hook (called from endSession, after eval+memories, before milestone).
 * Gated FOUR ways so it usually does zero LLM: (0/1) the speaker has an ex-link to
 * an opted-in same-world subject; (2) a cheap pre-screen finds an ex mention in the
 * speaker's OWN lines; (3) idempotent per session. The transcript fed to the model
 * is CHARACTER-spoken lines only — a player can never type a "fact" into existence.
 */
export async function maybeExtractExFacts(
  session: ConversationSession,
  messages: Message[],
  speaker: Character,
  day: number,
): Promise<void> {
  if (!speaker.worldId) return;

  // Gate 0+1: ex-link to an OPTED-IN, same-world subject.
  const eligibleExes = speaker.links
    .filter((l) => l.kind === 'ex')
    .map((l) => charactersRepo.get(l.targetId))
    .filter((c): c is Character => !!c && c.allowsExCanonization && c.worldId === speaker.worldId);
  if (eligibleExes.length === 0) return;

  // Gate 3: idempotent per session.
  const already = eventsRepo
    .listByCharacter(speaker.id, 100)
    .some((e) => e.type === 'exfact_extracted' && (e.payload as Record<string, unknown>).sessionId === session.id);
  if (already) return;

  // CRITICAL anti-injection: the character's OWN spoken lines, never the player's.
  const charLines = messages.filter((m) => m.role === 'character').map((m) => m.text);
  if (charLines.length === 0) return;

  // Gate 2: cheap deterministic pre-screen — did the character mention an ex at all?
  if (!mentionsEx(charLines, eligibleExes)) return;

  const result = await callStructuredLlm(ExFactExtractionSchema, buildExFactMessages(speaker.name, charLines), {
    settings: getLlmSettings(),
    task: 'Extract concrete facts the character stated about their ex (conservative).',
    schemaName: 'ExFactExtraction',
    maxRetries: 1,
    signal: AbortSignal.timeout(EX_CANON.llmTimeoutMs),
  });
  recordEvent('exfact_extracted', { sessionId: session.id, characterId: speaker.id, ok: result.ok });
  if (!result.ok) return;

  let written = 0;
  for (const fact of result.data.facts) {
    if (written >= EX_CANON.maxFactsPerDate) break;
    if (applyExFact({ fact, exName: result.data.exName, eligibleExes, speaker, charLines, sessionId: session.id, day })) {
      written += 1;
    }
  }
}

const EX_RE = /\b(ex|ex-?(girlfriend|boyfriend|partner|wife|husband)|former (girlfriend|boyfriend|partner|wife|husband))\b/i;

/** Cheap, deterministic: the character's lines say "my ex" or name an eligible ex. */
function mentionsEx(charLines: string[], eligibleExes: Character[]): boolean {
  const blob = charLines.join('\n');
  if (EX_RE.test(blob)) return true;
  const lower = blob.toLowerCase();
  return eligibleExes.some((ex) => lower.includes(ex.name.toLowerCase()));
}

/** Resolve which eligible ex a fact is about: a unique named match, or the sole ex if unnamed. */
function resolveEx(exName: string | null, eligibleExes: Character[]): Character | null {
  if (exName) {
    const hit = eligibleExes.filter((e) => norm(e.name) === norm(exName) || norm(e.name).startsWith(norm(exName)));
    return hit.length === 1 ? hit[0]! : null; // zero or ambiguous → skip
  }
  return eligibleExes.length === 1 ? eligibleExes[0]! : null; // unnamed resolves only if there's exactly one ex
}

interface ApplyArgs {
  fact: { category: string; value: string; sensitivity: 'neutral' | 'touchy'; sourceQuote: string };
  exName: string | null;
  eligibleExes: Character[];
  speaker: Character;
  charLines: string[];
  sessionId: string;
  day: number;
}

/** Validate one extracted fact; write it to canon_facts if it passes. Returns true if written. */
function applyExFact(args: ApplyArgs): boolean {
  const { fact, exName, eligibleExes, speaker, charLines, sessionId, day } = args;

  const subject = resolveEx(exName, eligibleExes);
  if (!subject || !subject.worldId) {
    recordEvent('exfact_unresolved', { speakerId: speaker.id, exName });
    return false;
  }

  // The quote MUST be a verbatim substring of a real character-spoken line.
  const quote = fact.sourceQuote.trim();
  if (!quote || !charLines.some((line) => line.includes(quote))) {
    recordEvent('exfact_quote_unverified', { subjectId: subject.id });
    return false;
  }

  // Content denylist (model-independent).
  if (DENYLIST.test(fact.value)) {
    recordEvent('exfact_denied', { subjectId: subject.id, category: fact.category });
    return false;
  }

  // Caps: lifetime per subject + per-world-day global (anti-grief).
  if (canonFactsRepo.listBySubject(subject.id).length >= EX_CANON.maxPerSubject) return false;
  if (canonizedOnDay(day) >= EX_CANON.maxPerWorldDay) return false;

  // Single-valued category: a contradicting second value is parked as 'shadow'
  // (stored + auditable) rather than letting two "truths" both reach the prompt.
  const activeInCategory = canonFactsRepo
    .listBySubject(subject.id, { status: 'active' })
    .filter((f) => f.category === fact.category);
  if (activeInCategory.some((f) => norm(f.value) === norm(fact.value))) return false; // already canon
  const status = activeInCategory.length > 0 ? 'shadow' : 'active';

  canonFactsRepo.insert(
    CanonFactSchema.parse({
      id: newId('canon'),
      worldId: subject.worldId,
      subjectId: subject.id,
      category: fact.category,
      value: fact.value,
      sensitivity: sensitivityFor(fact.category, fact.sensitivity),
      sourceSessionId: sessionId,
      sourceEventId: null,
      sourceCharId: speaker.id,
      day,
      status,
      createdAt: Date.now(),
    }),
  );
  recordEvent('exfact_canonized', { subjectId: subject.id, category: fact.category, status, speakerId: speaker.id, day });
  return true;
}
