import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MessageSchema, ConversationSessionSchema, NpcKnowledgeSchema, type Message } from '@dsim/shared';
import { resetDb, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { createWorld } from './world-service';
import { createCharacter } from './character-service';
import { maybeExtractExFacts, rejectCanonFact } from './ex-canon-service';
import { buildPromptContextForSession } from './conversation-service';
import { buildSystemPrompt } from '../prompt/prompt-builder';
import { ensureWorldState } from './world-clock-service';
import { canonFactsRepo, npcKnowledgeRepo, sessionsRepo } from '../db/repositories';

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

const reply = (o: object) => new ScriptedAdapter([JSON.stringify(o)]);

/** Mira has an ex-link to Dorian; Dorian's opt-in is parameterized. */
function setup(dorianOptIn = true) {
  const world = createWorld({ name: 'T' });
  ensureWorldState(world.id);
  const dorian = createCharacter({ worldId: world.id, name: 'Dorian', age: 31, allowsExCanonization: dorianOptIn });
  const mira = createCharacter({
    worldId: world.id,
    name: 'Mira',
    age: 27,
    links: [{ targetId: dorian.id, kind: 'ex' }],
  });
  return { world, mira, dorian };
}

function transcript(charLine: string, playerLine = 'oh, interesting.'): Message[] {
  return [
    MessageSchema.parse({ id: 'm0', sessionId: 'sess', role: 'player', text: playerLine, createdAt: 1 }),
    MessageSchema.parse({ id: 'm1', sessionId: 'sess', role: 'character', text: charLine, createdAt: 2 }),
  ];
}

const session = () => ConversationSessionSchema.parse({ id: 'sess', characterId: 'x', mode: 'date', createdAt: 1, updatedAt: 1 });

describe('ex-canonization (Phase 7)', () => {
  it('canonizes a fact the character stated about an opted-in ex (sensitivity is server-derived)', async () => {
    const { mira, dorian } = setup(true);
    // The model reports sensitivity 'neutral', but 'habit' is server-baselined to touchy.
    setAdapterOverride(reply({ exName: 'Dorian', facts: [{ category: 'habit', value: 'smoker', sensitivity: 'neutral', sourceQuote: 'used to smoke' }] }));

    await maybeExtractExFacts({ ...session(), characterId: mira.id }, transcript('My ex Dorian used to smoke, but he hates talking about it.'), mira, 3);

    const facts = canonFactsRepo.listBySubject(dorian.id, { status: 'active' });
    expect(facts.length).toBe(1);
    expect(facts[0]?.value).toBe('smoker');
    expect(facts[0]?.sensitivity).toBe('touchy'); // server upgraded the habit
    expect(facts[0]?.sourceCharId).toBe(mira.id);
  });

  it('does NOTHING when the ex is not opted in (the immutable-truth default)', async () => {
    const { mira, dorian } = setup(false);
    setAdapterOverride(reply({ exName: 'Dorian', facts: [{ category: 'habit', value: 'smoker', sensitivity: 'touchy', sourceQuote: 'used to smoke' }] }));

    await maybeExtractExFacts({ ...session(), characterId: mira.id }, transcript('My ex Dorian used to smoke.'), mira, 3);

    expect(canonFactsRepo.listBySubject(dorian.id).length).toBe(0);
  });

  it('never canonizes a "fact" that only the PLAYER said — the quote must be in the character lines', async () => {
    const { mira, dorian } = setup(true);
    // The character vaguely mentions an ex (pre-screen passes), but the model's quote
    // comes from the PLAYER's line, which is never fed to it → quote verification fails.
    setAdapterOverride(reply({ exName: 'Dorian', facts: [{ category: 'job', value: 'felon', sensitivity: 'neutral', sourceQuote: 'your ex is a felon' }] }));

    await maybeExtractExFacts(
      { ...session(), characterId: mira.id },
      transcript('My ex and I just grew apart, honestly.', 'I heard your ex is a felon.'),
      mira,
      3,
    );

    expect(canonFactsRepo.listBySubject(dorian.id).length).toBe(0);
  });

  it('parks a contradicting second value in the same category as shadow (not a second truth)', async () => {
    const { mira, dorian } = setup(true);
    setAdapterOverride(reply({ exName: 'Dorian', facts: [{ category: 'job', value: 'barista', sensitivity: 'neutral', sourceQuote: 'was a barista' }] }));
    await maybeExtractExFacts({ ...session(), characterId: mira.id }, transcript('My ex Dorian was a barista back when we dated.'), mira, 3);

    // A later date claims a different job — stored, audited, but NOT active.
    setAdapterOverride(reply({ exName: 'Dorian', facts: [{ category: 'job', value: 'banker', sensitivity: 'neutral', sourceQuote: 'is a banker' }] }));
    await maybeExtractExFacts({ ...ConversationSessionSchema.parse({ id: 'sess2', characterId: mira.id, mode: 'date', createdAt: 1, updatedAt: 1 }) }, transcript('Apparently my ex is a banker now.'), mira, 4);

    expect(canonFactsRepo.listBySubject(dorian.id, { status: 'active' }).map((f) => f.value)).toEqual(['barista']);
    expect(canonFactsRepo.listBySubject(dorian.id, { status: 'shadow' }).map((f) => f.value)).toEqual(['banker']);
  });

  it('rejecting a fact reverses it and cascades its gossip residue stale', async () => {
    const { mira, dorian } = setup(true);
    setAdapterOverride(reply({ exName: 'Dorian', facts: [{ category: 'hobby', value: 'paints', sensitivity: 'neutral', sourceQuote: 'paints' }] }));
    await maybeExtractExFacts({ ...session(), characterId: mira.id }, transcript('My ex Dorian paints, did I mention?'), mira, 3);
    const fact = canonFactsRepo.listBySubject(dorian.id)[0]!;
    // A gossip row derived from that canon fact has spread.
    npcKnowledgeRepo.insert(NpcKnowledgeSchema.parse({ id: 'k1', worldId: dorian.worldId!, knowerId: mira.id, subjectId: dorian.id, topic: 'ex_fact', claim: 'paints', sourceCanonId: fact.id, day: 3, createdAt: 1 }));

    rejectCanonFact(fact.id);

    expect(canonFactsRepo.listBySubject(dorian.id, { status: 'active' }).length).toBe(0);
    expect(canonFactsRepo.listBySubject(dorian.id).find((f) => f.id === fact.id)?.status).toBe('rejected');
    expect(npcKnowledgeRepo.listByKnower(mira.id).find((k) => k.sourceCanonId === fact.id)?.fidelity).toBe(0);
  });

  it('surfaces an active canon fact as a reaction block when you date the subject', async () => {
    const { mira, dorian } = setup(true);
    setAdapterOverride(reply({ exName: 'Dorian', facts: [{ category: 'habit', value: 'smoker', sensitivity: 'touchy', sourceQuote: 'used to smoke' }] }));
    await maybeExtractExFacts({ ...session(), characterId: mira.id }, transcript('My ex Dorian used to smoke.'), mira, 3);

    const sess = sessionsRepo.insert(
      ConversationSessionSchema.parse({ id: 'd1', characterId: dorian.id, mode: 'date', createdAt: 1, updatedAt: 1 }),
    );
    const ctx = buildPromptContextForSession(sess, []);
    expect(ctx.canonFacts.some((f) => f.value === 'smoker' && f.sensitivity === 'touchy')).toBe(true);

    const prompt = buildSystemPrompt(ctx, '');
    expect(prompt).toContain('THINGS PEOPLE KNOW ABOUT YOU');
    expect(prompt).toContain('smoker');
  });
});
