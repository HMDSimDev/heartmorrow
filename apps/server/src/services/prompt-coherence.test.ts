import { describe, it, expect, beforeEach } from 'vitest';
import { LAST_SEEN_FLAG, LAST_DATE_FLAG } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter } from '../test/helpers';
import { getRelationship } from './relationship-service';
import { stampLastSeen, stampLastDate, setRelationshipFlag } from './stat-service';
import { buildTextReplyMessages, messageText } from '../prompt/prompt-builder';

const systemTextOf = (msgs: ReturnType<typeof buildTextReplyMessages>) =>
  messageText(msgs[0]!.content).toLowerCase();

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
