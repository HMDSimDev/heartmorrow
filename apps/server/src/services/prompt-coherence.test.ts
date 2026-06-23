import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LAST_SEEN_FLAG, LAST_DATE_FLAG, AFTERGLOW_MOOD_FLAG, AFTERGLOW_DAY_FLAG } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { getRelationship } from './relationship-service';
import { stampLastSeen, stampLastDate, setRelationshipFlag } from './stat-service';
import { createSession, addPlayerMessage, endSession } from './conversation-service';
import { buildTextReplyMessages, buildDailyTextPlanMessages, messageText } from '../prompt/prompt-builder';

const systemTextOf = (msgs: ReturnType<typeof buildTextReplyMessages>) =>
  messageText(msgs[0]!.content).toLowerCase();
/** The whole assembled prompt (system + user), lowercased — afterglow rides in the user turn. */
const allTextOf = (msgs: ReturnType<typeof buildTextReplyMessages>) =>
  msgs.map((m) => messageText(m.content)).join('\n').toLowerCase();

describe('in-person last-date clock split (#24)', () => {
  beforeEach(() => resetDb());

  it('stampLastSeen sets only the neglect clock; stampLastDate sets both clocks', () => {
    const { character } = seedWorldAndCharacter();

    // Texting (last-seen only) must NOT advance the in-person clock the date greeting reads.
    stampLastSeen(character.id, 5);
    let flags = getRelationship(character.id).flags;
    expect(flags[LAST_SEEN_FLAG]).toBe(5);
    expect(flags[LAST_DATE_FLAG]).toBeUndefined();

    // A real in-person meeting advances both, so the absence beat resets correctly.
    stampLastDate(character.id, 8);
    flags = getRelationship(character.id).flags;
    expect(flags[LAST_SEEN_FLAG]).toBe(8);
    expect(flags[LAST_DATE_FLAG]).toBe(8);
  });
});

describe('text reply mirrors the date prompt emotional state (#1)', () => {
  beforeEach(() => resetDb());

  it('a recently broken-up character texts guarded, not blithely warm', () => {
    const { character } = seedWorldAndCharacter();
    setRelationshipFlag(character.id, 'state:brokenUp', true, { source: 'test' });
    const msgs = buildTextReplyMessages({
      character,
      relationship: getRelationship(character.id),
      recentTexts: [],
      playerName: 'Alex',
    });
    expect(systemTextOf(msgs)).toContain('recently broke up');
  });

  it('a jealous character carries the sting into texting', () => {
    const { character } = seedWorldAndCharacter();
    setRelationshipFlag(character.id, 'state:jealous', true, { source: 'test' });
    const msgs = buildTextReplyMessages({
      character,
      relationship: getRelationship(character.id),
      recentTexts: [],
      playerName: 'Alex',
    });
    expect(systemTextOf(msgs)).toContain('jealous and insecure');
  });

  it('a calm relationship adds no emotional-state clause', () => {
    const { character } = seedWorldAndCharacter();
    const msgs = buildTextReplyMessages({
      character,
      relationship: getRelationship(character.id),
      recentTexts: [],
      playerName: 'Alex',
    });
    const text = systemTextOf(msgs);
    expect(text).not.toContain('recently broke up');
    expect(text).not.toContain('jealous and insecure');
  });
});

describe("date afterglow: a recent date's mood briefly colors texts, then fades", () => {
  beforeEach(() => resetDb());
  afterEach(() => setAdapterOverride(null));

  function setAfterglow(characterId: string, mood: string, day: number): void {
    setRelationshipFlag(characterId, AFTERGLOW_MOOD_FLAG, mood, { source: 'test' });
    setRelationshipFlag(characterId, AFTERGLOW_DAY_FLAG, day, { source: 'test' });
  }

  it('carries the last date\'s mood into the next-day text reply (within the window)', () => {
    const { character } = seedWorldAndCharacter();
    setAfterglow(character.id, 'tender and a little raw', 5);
    const msgs = buildTextReplyMessages({
      character,
      relationship: getRelationship(character.id),
      recentTexts: [],
      playerName: 'Alex',
      worldDay: 6, // one day later — still in the afterglow window
    });
    const text = allTextOf(msgs);
    expect(text).toContain('how your last time together left you');
    expect(text).toContain('tender and a little raw');
  });

  it('carries the mood into a proactive daily text too', () => {
    const { character } = seedWorldAndCharacter();
    setAfterglow(character.id, 'heavy and introspective', 5);
    const msgs = buildDailyTextPlanMessages({
      character,
      relationship: getRelationship(character.id),
      daysSinceSeen: 1,
      giftable: [],
      playerName: 'Alex',
      worldDay: 6,
    });
    expect(allTextOf(msgs)).toContain('heavy and introspective');
  });

  it('drops the afterglow once the window has passed (no harping days later)', () => {
    const { character } = seedWorldAndCharacter();
    setAfterglow(character.id, 'tender and a little raw', 5);
    const msgs = buildTextReplyMessages({
      character,
      relationship: getRelationship(character.id),
      recentTexts: [],
      playerName: 'Alex',
      worldDay: 8, // three days later — faded
    });
    const text = allTextOf(msgs);
    expect(text).not.toContain('how your last time together left you');
    expect(text).not.toContain('tender and a little raw');
  });

  it('adds nothing when there is no recent-date mood on record', () => {
    const { character } = seedWorldAndCharacter();
    const msgs = buildTextReplyMessages({
      character,
      relationship: getRelationship(character.id),
      recentTexts: [],
      playerName: 'Alex',
      worldDay: 6,
    });
    expect(allTextOf(msgs)).not.toContain('how your last time together left you');
  });

  it('stamps the evaluator mood (+ day) when a real date ends — the write side', async () => {
    const { character } = seedWorldAndCharacter();
    const sess = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(sess.id, 'That meant a lot to me — thank you for actually listening.');
    setAdapterOverride(
      new ScriptedAdapter([
        JSON.stringify({
          mood: 'wistful',
          expression: 'smiling',
          relationshipDeltas: {},
          memoryCandidates: [],
          summaryLine: 'A heavy, honest evening.',
        }),
      ]),
    );

    await endSession(sess.id);

    const flags = getRelationship(character.id).flags;
    expect(flags[AFTERGLOW_MOOD_FLAG]).toBe('wistful');
    expect(typeof flags[AFTERGLOW_DAY_FLAG]).toBe('number');
  });
});
