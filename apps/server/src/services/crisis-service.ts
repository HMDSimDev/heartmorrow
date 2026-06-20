import {
  DESPAIR,
  despairStage,
  despairEligible,
  isMemorialized,
  CrisisTextSchema,
  TextMessageSchema,
  DEFAULT_PLAYER_ID,
  CHARACTER_LINK_LABELS,
  linkTo,
  type Character,
  type CharacterLinkKind,
  type Relationship,
} from '@dsim/shared';
import { charactersRepo, relationshipsRepo, textMessagesRepo } from '../db/repositories';
import { getRelationship, ensureRelationship } from './relationship-service';
import { setRelationshipFlag } from './stat-service';
import { getLlmSettings } from './settings-service';
import { addMemoriesFromEvaluation } from './memory-service';
import { appendChronicleLine } from './chronicle-service';
import { getOrCreateThread, hasDated } from './text-message-service';
import { getOrCreatePlayer } from './player-service';
import { callStructuredLlm } from '../llm/structured';
import { buildDespairTextMessages, buildFriendConcernMessages } from '../prompt/prompt-builder';
import { newId, playerIdForWorldOrDefault } from '../lib/ids';
import { recordEvent } from './event-service';

export { isMemorialized };

/**
 * The OPT-IN tragic-outcome system (see packages/shared/src/crisis.ts for the
 * design + the safety principles). Everything here is a no-op unless
 * settings.tragicOutcomesEnabled is on AND the character was deeply attached.
 * The act is never depicted; only its aftermath (a kept memorial). The terminal
 * NOTICE is fully templated (no LLM); only the earlier off-ramp texts use the
 * model, under strict guardrails.
 */

function enabled(): boolean {
  const s = getLlmSettings();
  // Requires BOTH flags — so a stale tragic flag can never run with adult content
  // off (also closes a direct-PATCH bypass of the UI's NSFW gate).
  return s.tragicOutcomesEnabled === true && s.nsfwEnabled === true;
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

export function getDespair(rel: Relationship): number {
  return num(rel.flags['harm:despair']);
}

/** Character ids that have been memorialized (for greying them out in the UI). */
export function listMemorialCharacterIds(worldId?: string, playerId: string = DEFAULT_PLAYER_ID): string[] {
  return (worldId ? charactersRepo.listByWorld(worldId) : charactersRepo.list())
    .filter((c) => {
      const rel = relationshipsRepo.getByCharacter(c.id, playerId);
      return rel ? isMemorialized(rel) : false;
    })
    .map((c) => c.id);
}

/**
 * Add (or, with a negative delta, heal) despair for a character. No-op unless the
 * mechanic is enabled AND they were deeply attached. Never triggers the outcome
 * itself — that only happens via the daily arc after a sustained crisis.
 */
export function adjustDespair(characterId: string, delta: number, reason: string, day = 0): number {
  if (!enabled()) return 0;
  const rel = getRelationship(characterId);
  if (isMemorialized(rel)) return getDespair(rel);
  if (delta > 0 && !despairEligible(rel)) return getDespair(rel); // only the deeply-attached can be devastated

  const next = Math.max(0, Math.min(DESPAIR.max, getDespair(rel) + delta));
  setRelationshipFlag(characterId, 'harm:despair', next, { source: 'crisis', detail: { reason, day } });
  if (delta > 0) setRelationshipFlag(characterId, 'harm:attached', true, { source: 'crisis' });
  return next;
}

/** Convenience for the despair caused by a breakup (worse the more you've done it). */
export function despairFromBreakup(characterId: string, priorBreakups: number, day = 0): void {
  adjustDespair(characterId, DESPAIR.breakupBase + DESPAIR.breakupPerPrior * Math.max(0, priorBreakups), 'breakup', day);
}

function clearArcFlags(characterId: string): void {
  setRelationshipFlag(characterId, 'state:despairing', false, { source: 'crisis' });
  setRelationshipFlag(characterId, 'harm:pending', '', { source: 'crisis' });
  setRelationshipFlag(characterId, 'harm:crisisSince', 0, { source: 'crisis' });
  setRelationshipFlag(characterId, 'harm:friendNotifiedSince', 0, { source: 'crisis' });
}

/**
 * Run the per-character despair arc for one day. Heals naturally (the off-ramp),
 * escalates the visible stage, queues warning texts, and — ONLY after a sustained
 * crisis with continued harm — reaches the memorial outcome. Called from the
 * day-advance neglect pass. Best-effort; gated.
 */
export function evaluateDespairArc(characterId: string, ctx: { day: number }): void {
  if (!enabled()) return;
  const rel = getRelationship(characterId);
  if (isMemorialized(rel)) return;

  let despair = getDespair(rel);
  const hasArc = despair > 0 || rel.flags['state:despairing'] === true || num(rel.flags['harm:crisisSince']) > 0;
  if (despair <= 0 && !hasArc) return;

  // Heal each day on its own — the off-ramp. Simply STOPPING (or leaving them be)
  // pulls them back: passive neglect never deepens despair. Only ACTIVE, repeated
  // harm — breakups/cheating/hostility bursts added via adjustDespair — can climb
  // the spiral, exactly as the crisis.ts design principles promise.
  despair = Math.max(0, despair - DESPAIR.decayPerDay);
  setRelationshipFlag(characterId, 'harm:despair', despair, { source: 'crisis', detail: { day: ctx.day } });

  const stage = despairStage(despair);
  if (stage === 'stable') {
    clearArcFlags(characterId);
    return;
  }

  setRelationshipFlag(characterId, 'state:despairing', true, { source: 'crisis' });

  if (stage === 'withdrawn') {
    if (!rel.flags['harm:pending']) setRelationshipFlag(characterId, 'harm:pending', 'withdrawn', { source: 'crisis' });
    setRelationshipFlag(characterId, 'harm:crisisSince', 0, { source: 'crisis' });
    setRelationshipFlag(characterId, 'harm:friendNotifiedSince', 0, { source: 'crisis' });
    return;
  }

  // stage === 'crisis'
  let crisisSince = num(rel.flags['harm:crisisSince']);
  if (crisisSince <= 0) {
    crisisSince = ctx.day;
    setRelationshipFlag(characterId, 'harm:crisisSince', crisisSince, { source: 'crisis' });
  }
  setRelationshipFlag(characterId, 'harm:pending', 'crisis', { source: 'crisis' });

  // The point of no return — ONLY after a sustained crisis with continued harm.
  if (despair >= DESPAIR.terminal && ctx.day - crisisSince >= DESPAIR.crisisDaysBeforeTerminal) {
    memorialize(characterId, ctx.day);
  }
}

/**
 * The tragic outcome: permanently memorialize the character (kept, not deleted).
 * Sober + non-graphic. Templated — the act is never described. Surfaces a notice
 * to the player (a friend/family text + a recap event); the UI greys the portrait
 * and shows real crisis resources.
 */
export function memorialize(characterId: string, day: number): void {
  const c = charactersRepo.get(characterId);
  if (!c) return;
  if (isMemorialized(getRelationship(characterId))) return; // idempotent — never double-memorialize
  setRelationshipFlag(characterId, 'harm:memorial', true, { source: 'crisis' });
  setRelationshipFlag(characterId, 'harm:memorialDay', day, { source: 'crisis' });
  setRelationshipFlag(characterId, 'status', 'none', { source: 'crisis' });
  setRelationshipFlag(characterId, 'state:despairing', false, { source: 'crisis' });
  setRelationshipFlag(characterId, 'harm:pending', '', { source: 'crisis' });
  setRelationshipFlag(characterId, 'harm:crisisSince', 0, { source: 'crisis' });

  const first = c.name.split(/\s+/)[0] || c.name;
  addMemoriesFromEvaluation(
    characterId,
    [{ text: `${first} is gone. The weight of how I treated them stays with me.`, importance: 5, tags: ['memorial'] }],
    null,
  );
  try {
    appendChronicleLine(characterId, day, 'date', `🕯️ In memoriam — ${c.name}.`, { bumpSession: false });
  } catch {
    /* best-effort */
  }
  recordEvent('tragic_outcome', { characterId, day });
  if (c.worldId) queueMemorialNotice(c, day);
}

/** True for someone who would grieve the subject (a close, non-romantic-rival tie). */
const GRIEVING_KINDS: CharacterLinkKind[] = ['friend', 'family', 'partner'];

/** Find a linked friend/family of the subject who can text the player (has dated). */
function grievingFriendOf(subject: Character): Character | null {
  if (!subject.worldId) return null;
  const world = charactersRepo.listByWorld(subject.worldId);
  for (const g of world) {
    if (g.id === subject.id || !hasDated(g.id)) continue;
    const out = linkTo(g.links, subject.id);
    const incoming = linkTo(subject.links, g.id);
    const kind = out?.kind ?? incoming?.kind;
    if (kind && GRIEVING_KINDS.includes(kind)) return g;
  }
  return null;
}

/** A TEMPLATED, non-graphic notice from a grieving friend/family member. */
function queueMemorialNotice(subject: Character, day: number): void {
  const friend = grievingFriendOf(subject);
  if (!friend) return; // the memorial state + recap still convey it
  const first = subject.name.split(/\s+/)[0] || subject.name;
  const body =
    `I don't really know how to send this. We lost ${first}. ` +
    `They'd been in so much pain these last days... I just wanted you to hear it from someone who cared about them. ` +
    `Please look after yourself. 🕯️`;
  const thread = getOrCreateThread(friend.id);
  const now = Date.now();
  textMessagesRepo.insert(
    TextMessageSchema.parse({
      id: newId('txt'),
      threadId: thread.id,
      sender: 'character',
      body,
      status: 'queued',
      dayNumber: day,
      scheduledPhase: 'morning',
      attachment: null,
      deliveredAt: null,
      createdAt: now,
    }),
  );
  recordEvent('memorial_notice_sent', { characterId: subject.id, friendId: friend.id, day });
}

/**
 * At day start, deliver the spiral's warning texts: the struggling character's own
 * withdrawn/crisis message, and — once per crisis episode — a worried friend's
 * intervention. Both are off-ramps. Gated + best-effort. Mirrors gossip delivery.
 */
export async function deliverCrisisTextsForDay(worldId: string, day: number, playerId: string = DEFAULT_PLAYER_ID): Promise<void> {
  if (!enabled()) return;
  const settings = getLlmSettings();
  const playerName = getOrCreatePlayer(playerIdForWorldOrDefault(worldId)).name;

  for (const character of charactersRepo.listByWorld(worldId)) {
    const rel = ensureRelationship(character.id, playerId);
    if (isMemorialized(rel)) continue;

    // 1. The character's own distress text (a queued beat, bypasses cadence).
    const pending = rel.flags['harm:pending'];
    if ((pending === 'withdrawn' || pending === 'crisis') && hasDated(character.id)) {
      const result = await callStructuredLlm(
        CrisisTextSchema,
        buildDespairTextMessages({ character, relationship: rel, stage: pending, playerName }),
        { settings, task: `Write ${character.name}'s ${pending} text.`, schemaName: 'CrisisText' },
      );
      // Re-check after the await; clear only on success so a failure retries.
      if (result.ok && getRelationship(character.id).flags['harm:pending'] === pending) {
        setRelationshipFlag(character.id, 'harm:pending', '', { source: 'crisis' });
        const thread = getOrCreateThread(character.id, playerId);
        textMessagesRepo.insert(
          TextMessageSchema.parse({
            id: newId('txt'),
            threadId: thread.id,
            sender: 'character',
            body: result.data.body,
            status: 'queued',
            dayNumber: day,
            scheduledPhase: 'evening',
            attachment: null,
            deliveredAt: null,
            createdAt: Date.now(),
          }),
        );
        recordEvent('despair_text_sent', { characterId: character.id, stage: pending, day });
      }
    }

    // 2. A worried friend's intervention — once per crisis episode.
    const crisisSince = num(rel.flags['harm:crisisSince']);
    if (despairStage(getDespair(rel)) === 'crisis' && crisisSince > 0 && num(rel.flags['harm:friendNotifiedSince']) !== crisisSince) {
      const friend = grievingFriendOf(character);
      if (friend) {
        const link = linkTo(friend.links, character.id) ?? linkTo(character.links, friend.id);
        const linkKind = link ? CHARACTER_LINK_LABELS[link.kind].toLowerCase() : 'friend';
        const result = await callStructuredLlm(
          CrisisTextSchema,
          buildFriendConcernMessages({ friend, subjectName: character.name, linkKind, playerName }),
          { settings, task: `Write ${friend.name}'s worried check-in.`, schemaName: 'CrisisText' },
        );
        if (result.ok && getRelationship(character.id).flags['harm:friendNotifiedSince'] !== crisisSince) {
          setRelationshipFlag(character.id, 'harm:friendNotifiedSince', crisisSince, { source: 'crisis' });
          const thread = getOrCreateThread(friend.id, playerId);
          textMessagesRepo.insert(
            TextMessageSchema.parse({
              id: newId('txt'),
              threadId: thread.id,
              sender: 'character',
              body: result.data.body,
              status: 'queued',
              dayNumber: day,
              scheduledPhase: 'evening',
              attachment: null,
              deliveredAt: null,
              createdAt: Date.now(),
            }),
          );
          recordEvent('crisis_intervention_sent', { characterId: character.id, friendId: friend.id, day });
        }
      }
    }
  }
}
