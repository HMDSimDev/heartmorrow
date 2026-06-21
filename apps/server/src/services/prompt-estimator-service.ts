import {
  ConversationSessionSchema,
  MessageSchema,
  PROMPT_LIMITS,
  type Character,
  type Message,
  type PromptEstimate,
  type PromptEstimateRequest,
  type PromptEstimateResult,
} from '@dsim/shared';
import { getAdapter } from '../llm/provider';
import type { ChatMessage } from '../llm/types';
import { getLlmSettings } from './settings-service';
import { getCharacter, listCharacters } from './character-service';
import { buildPromptContextForSession } from './conversation-service';
import { sessionsRepo, messagesRepo } from '../db/repositories';
import {
  buildDialogueMessages,
  buildEvaluatorMessages,
  buildSummaryMessages,
  buildDayRecapMessages,
  buildTurnReactionMessages,
  buildWalkoutReactionMessages,
  buildDtrReactionMessages,
  buildPlayerBreakupMessages,
  buildPlayerFarewellMessages,
  buildTextReplyMessages,
  buildTextJudgeMessages,
  buildDailyTextPlanMessages,
  estimatePromptChars,
  type PromptContext,
} from '../prompt/prompt-builder';

/**
 * Prompt-size estimator (Debug page).
 *
 * Assembles the REAL prompt for each of the game's common LLM interactions —
 * using the same builders and the same real DB data the runtime sends — and
 * reports how big each one is. Token counts are the model's EXACT
 * `usage.prompt_tokens` when `live` is set (each prompt is sent with
 * max_tokens: 1, which only triggers prefill), or a chars/4 estimate otherwise.
 *
 * The point is to answer "have any of my prompts blown past the context window?"
 * without guessing: the numbers come from the actual loaded model.
 */

/** The crude offline fallback when the model isn't measuring tokens for us. */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** Pick the character to build prompts around: the requested one, else the first
 *  one that exists (the estimator is about prompt SHAPE, so any real character works). */
function resolveCharacter(characterId: string | null): Character | null {
  if (characterId) {
    try {
      return getCharacter(characterId);
    } catch {
      /* fall through to a representative pick */
    }
  }
  return listCharacters()[0] ?? null;
}

/** The character's most recent real transcript (capped like the runtime does), or
 *  [] when they've never been talked to. */
function latestTranscript(characterId: string): Message[] {
  for (const s of sessionsRepo.listByCharacter(characterId)) {
    const msgs = messagesRepo.listBySession(s.id);
    if (msgs.length) return msgs.slice(-PROMPT_LIMITS.recentMessages);
  }
  return [];
}

/** A representative spoken line (~180 chars) — near a real chatty turn. */
const FILLER_LINE =
  'Honestly that reminds me of something I have been turning over all week — I keep meaning to tell you about it but it never feels like the right moment, so maybe now is as good a time as any, right?';

/** A full conversation window of filler, for the worst-case (simulateFull) estimate. */
function fillerMessages(sessionId: string, characterName: string): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < PROMPT_LIMITS.recentMessages; i++) {
    const role = i % 2 === 0 ? 'player' : 'character';
    out.push(
      MessageSchema.parse({
        id: `estimate-msg-${i}`,
        sessionId,
        role,
        text: role === 'character' ? `${characterName}: ${FILLER_LINE}` : FILLER_LINE,
        metadata: {},
        createdAt: i + 1,
      }),
    );
  }
  return out;
}

/** A full recent-texts thread of filler (worst-case phone-prompt history). */
function fillerTexts(characterName: string): PromptContext['recentTexts'] {
  const out: PromptContext['recentTexts'] = [];
  for (let i = 0; i < 8; i++) {
    out.push({
      sender: i % 2 === 0 ? 'player' : 'character',
      body: FILLER_LINE.slice(0, 220),
      day: 1 + Math.floor(i / 2),
    });
  }
  return out;
}

/** A representative rolling-summary blob (worst-case). */
const FILLER_SUMMARY =
  'Over several evenings together they have grown noticeably closer: shared a long talk about family and old fears, ' +
  'discovered a mutual love of late-night walks and bad sci-fi, navigated one tense misunderstanding about plans that ' +
  'got smoothed over honestly, and traded a few vulnerable admissions that each is taking the connection seriously. ' +
  'There is real warmth and a building anticipation about where this is going, tempered by a little guardedness.';

/** A representative day-recap event log (worst-case). */
const FILLER_EVENTS =
  '- Went on a date with Mara at the riverside cafe; it went well (affection +4).\n' +
  '- Received a warm good-morning text from Nia and replied.\n' +
  '- Bought a small gift at the market (-40).\n' +
  '- Worked a shift at the bookstore (+60, stamina -1).\n' +
  '- A friend posted about an upcoming gathering this weekend.';

/** Build one estimate row by measuring an assembled prompt. */
async function measure(
  spec: { key: string; label: string; description: string; messages: ChatMessage[]; maxResponseTokens: number },
  opts: { live: boolean; liveDead: boolean },
): Promise<{ row: PromptEstimate; transportError?: string }> {
  const chars = estimatePromptChars(spec.messages);
  const base = {
    key: spec.key,
    label: spec.label,
    description: spec.description,
    messageCount: spec.messages.length,
    chars,
    maxResponseTokens: spec.maxResponseTokens,
  };

  if (!opts.live || opts.liveDead) {
    return {
      row: {
        ...base,
        promptTokens: estimateTokens(chars),
        method: 'estimated',
        note: opts.live && opts.liveDead ? 'Skipped after the endpoint failed; estimated from characters.' : undefined,
      },
    };
  }

  try {
    const settings = getLlmSettings();
    const res = await getAdapter(settings).chat(
      { messages: spec.messages, temperature: 0, maxTokens: 1 },
      AbortSignal.timeout(60_000),
    );
    const pt = res.usage?.promptTokens;
    if (typeof pt === 'number') {
      return { row: { ...base, promptTokens: pt, method: 'exact' } };
    }
    return {
      row: {
        ...base,
        promptTokens: estimateTokens(chars),
        method: 'estimated',
        note: 'Endpoint reported no token usage; estimated from characters.',
      },
    };
  } catch (err) {
    const message = (err as Error).message;
    return {
      row: {
        ...base,
        promptTokens: estimateTokens(chars),
        method: 'estimated',
        note: 'Endpoint unreachable; estimated from characters.',
      },
      transportError: message,
    };
  }
}

export async function estimatePrompts(req: PromptEstimateRequest): Promise<PromptEstimateResult> {
  const settings = getLlmSettings();
  const character = resolveCharacter(req.characterId);
  if (!character) {
    return {
      model: settings.model,
      characterId: null,
      characterName: null,
      live: false,
      simulateFull: req.simulateFull,
      estimates: [],
      error: 'No characters exist yet — create a character first.',
    };
  }

  const now = Date.now();
  const transcript = req.simulateFull ? fillerMessages('estimate', character.name) : latestTranscript(character.id);

  // A real date-mode context (the largest prompt path), plus a chat-mode one.
  const dateSession = ConversationSessionSchema.parse({
    id: 'estimate-date',
    characterId: character.id,
    locationId: null,
    mode: 'date',
    summary: req.simulateFull ? FILLER_SUMMARY : '',
    ended: false,
    createdAt: now,
    updatedAt: now,
  });
  const chatSession = ConversationSessionSchema.parse({
    id: 'estimate-chat',
    characterId: character.id,
    locationId: null,
    mode: 'chat',
    summary: req.simulateFull ? FILLER_SUMMARY : '',
    ended: false,
    createdAt: now,
    updatedAt: now,
  });

  // A representative just-judged verdict so the date prompt includes its
  // "how their last message landed" block (the realistic full shape).
  let dateCtx = buildPromptContextForSession(dateSession, transcript, {
    turnVerdict: { engagement: 2, label: 'into it', note: 'asked a thoughtful, specific follow-up' },
  });
  let chatCtx = buildPromptContextForSession(chatSession, transcript);
  if (req.simulateFull) {
    const texts = fillerTexts(character.name);
    dateCtx = { ...dateCtx, recentTexts: texts };
    chatCtx = { ...chatCtx, recentTexts: texts };
  }

  const playerName = dateCtx.player.name;
  const playerGender = dateCtx.player.gender;
  const reserve = settings.maxTokens;

  // Each spec assembles the REAL ChatMessage[] the runtime would send.
  const specs: Array<{ key: string; label: string; description: string; messages: ChatMessage[]; maxResponseTokens: number }> = [
    {
      key: 'dating_dialogue',
      label: 'Date reply',
      description: 'A character speaking on a date — the largest prompt (full world/character/relationship context).',
      messages: buildDialogueMessages(dateCtx),
      maxResponseTokens: reserve,
    },
    {
      key: 'chat_dialogue',
      label: 'Chat reply',
      description: 'A plain (non-date) conversation reply.',
      messages: buildDialogueMessages(chatCtx),
      maxResponseTokens: reserve,
    },
    {
      key: 'text_reply',
      label: 'Text reply (phone)',
      description: "A character's SMS reply to one of your texts.",
      messages: buildTextReplyMessages({
        character,
        relationship: dateCtx.relationship,
        recentTexts: dateCtx.recentTexts,
        playerName,
        playerGender,
        worldDay: dateCtx.worldDay,
        chronicle: dateCtx.chronicle,
        memories: dateCtx.memories,
        acquaintances: dateCtx.acquaintances,
      }),
      maxResponseTokens: reserve,
    },
    {
      key: 'daily_text',
      label: 'Daily check-in text',
      description: "A character's one unprompted daily text.",
      messages: buildDailyTextPlanMessages({
        character,
        relationship: dateCtx.relationship,
        daysSinceSeen: 2,
        giftable: [{ id: 'item-sample', name: 'a small paperback' }],
        playerName,
        playerGender,
        recentTexts: dateCtx.recentTexts,
        chronicle: dateCtx.chronicle,
        memories: dateCtx.memories,
      }),
      maxResponseTokens: reserve,
    },
    {
      key: 'text_judge',
      label: 'Text judge',
      description: 'Impartial read of how your latest text landed (structured).',
      messages: buildTextJudgeMessages({
        character,
        relationship: dateCtx.relationship,
        recentTexts: dateCtx.recentTexts,
        playerName,
        memories: dateCtx.memories,
      }),
      maxResponseTokens: reserve,
    },
    {
      key: 'turn_judge',
      label: 'Date turn judge',
      description: 'Per-message rapport read during a date (structured).',
      messages: buildTurnReactionMessages({
        character,
        needJudge: dateCtx.dateNeed ?? '',
        vibe: 'warming up nicely',
        recentMessages: dateCtx.recentMessages,
        playerName,
      }),
      maxResponseTokens: reserve,
    },
    {
      key: 'walkout_judge',
      label: 'Walkout judge',
      description: 'Mid-date check on whether the character walks out (structured).',
      messages: buildWalkoutReactionMessages({
        character,
        relationship: dateCtx.relationship,
        recentMessages: dateCtx.recentMessages,
        playerName,
      }),
      maxResponseTokens: reserve,
    },
    {
      key: 'dtr_judge',
      label: 'Define-the-relationship',
      description: 'Accept / deflect / backfire decision when you make it official (structured).',
      messages: buildDtrReactionMessages({
        character,
        relationship: dateCtx.relationship,
        rung: { status: 'exclusive', label: 'exclusive', verb: 'asked to make it exclusive' },
        recentMessages: dateCtx.recentMessages,
        playerName,
      }),
      maxResponseTokens: reserve,
    },
    {
      key: 'player_breakup',
      label: 'Breakup reaction',
      description: 'Whether your message reads as a breakup, and the reaction (structured).',
      messages: buildPlayerBreakupMessages({
        character,
        relationship: dateCtx.relationship,
        recentMessages: dateCtx.recentMessages,
        playerName,
      }),
      maxResponseTokens: reserve,
    },
    {
      key: 'player_farewell',
      label: 'Farewell reaction',
      description: 'Whether your message ends the date, and the goodbye line (structured).',
      messages: buildPlayerFarewellMessages({
        character,
        relationship: dateCtx.relationship,
        vibe: 'warming up nicely',
        recentMessages: dateCtx.recentMessages,
        playerName,
      }),
      maxResponseTokens: reserve,
    },
    {
      key: 'session_evaluator',
      label: 'Date evaluator',
      description: 'End-of-date relationship scoring (structured).',
      messages: buildEvaluatorMessages(dateCtx),
      maxResponseTokens: reserve,
    },
    {
      key: 'rolling_summary',
      label: 'Conversation summary',
      description: 'Compresses a long conversation into a rolling summary (structured).',
      messages: buildSummaryMessages(dateCtx),
      maxResponseTokens: reserve,
    },
    {
      key: 'day_recap',
      label: 'End-of-day recap',
      description: "Narrates the day's events into a recap (structured).",
      messages: buildDayRecapMessages(dateCtx.worldDay ?? 1, FILLER_EVENTS),
      maxResponseTokens: reserve,
    },
  ];

  // Measure sequentially: a local model serves one request at a time, and once
  // the endpoint clearly fails we stop hammering it and estimate the rest.
  const estimates: PromptEstimate[] = [];
  let liveError: string | undefined;
  for (const spec of specs) {
    const { row, transportError } = await measure(spec, { live: req.live, liveDead: !!liveError });
    if (transportError && !liveError) liveError = transportError;
    estimates.push(row);
  }

  return {
    model: settings.model,
    characterId: character.id,
    characterName: character.name,
    live: req.live && !liveError && estimates.some((e) => e.method === 'exact'),
    simulateFull: req.simulateFull,
    estimates,
    error: liveError ? `Live token counts unavailable (${liveError}); showing character-based estimates.` : undefined,
  };
}
