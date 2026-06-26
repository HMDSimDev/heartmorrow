import { describe, it, expect, beforeEach } from 'vitest';
import {
  QuestGraphSchema,
  QuestGenSchema,
  hasWinGoal,
  isWinReachable,
  resolveQuestAction,
  initialQuestState,
  type QuestState,
} from '@dsim/shared';
import { resetDb, seedWorldAndCharacter } from '../test/helpers';
import { ensureWorldState } from '../services/world-clock-service';
import { activeQuestsRepo, questTurnsRepo } from '../db/repositories';
import { playerIdForWorld } from '../lib/ids';
import { updateLlmSettings } from './settings-service';
import { applyRelationshipChange } from './stat-service';
import { getRelationshipIfExists } from './relationship-service';
import {
  createQuest,
  getQuestLobby,
  startQuest,
  takeQuestTurn,
  getActiveQuest,
  abandonQuest,
  listAuthoredQuests,
  updateQuest,
  deleteQuest,
  boundGeneratedQuest,
  generateQuest,
} from './quest-service';

beforeEach(() => resetDb());

// A tiny one-scene quest: a persuade affordance whose success sets the win flag.
// maxTurns is small so the turn-budget backstop bounds any offline LLM retries.
function makeQuest(worldId: string) {
  return createQuest({
    worldId,
    name: 'The Gate',
    blurb: 'Win the watchman over.',
    graph: QuestGraphSchema.parse({
      entryNodeId: 'gate',
      maxTurns: 3,
      timeoutOutcome: 'resolved',
      nodes: [
        {
          id: 'gate',
          kind: 'standoff',
          setup: 'A watchman bars the gate.',
          entities: [{ id: 'watch', name: 'Watchman', faction: 'hostile', disposition: 0 }],
          affordances: [
            {
              verb: 'persuade',
              stat: 'charm',
              difficulty: 'normal',
              hint: 'Talk him round.',
              effects: {
                success: [
                  { op: 'setFlag', flag: 'watch.won' },
                  { op: 'moveEntityToFaction', entityId: 'watch', faction: 'ally' },
                ],
                partial: [{ op: 'adjustStat', key: 'disposition', entityId: 'watch', delta: 5 }],
                fail: [],
                complication: [{ op: 'adjustStat', key: 'disposition', entityId: 'watch', delta: -3 }],
              },
            },
          ],
          edges: [],
          isTerminal: false,
        },
      ],
      goals: [
        { id: 'win', kind: 'flag', outcome: 'win', label: 'Win the watchman over', predicate: { kind: 'flag', flag: 'watch.won' } },
      ],
    }),
  });
}

describe('quest lobby + eligibility', () => {
  it('lists authored quests as eligible when no run is active', () => {
    const { world } = seedWorldAndCharacter();
    makeQuest(world.id);
    const lobby = getQuestLobby(world.id);
    expect(lobby.quests).toHaveLength(1);
    expect(lobby.quests[0]!.eligible).toBe(true);
    expect(lobby.active).toBeNull();
  });

  it('gates a partner-anchored quest behind the warmth band', () => {
    const { world, character } = seedWorldAndCharacter();
    createQuest({
      worldId: world.id,
      name: 'Heart Quest',
      partnerId: character.id,
      minWarmthBand: 3,
      graph: QuestGraphSchema.parse({
        entryNodeId: 'n',
        nodes: [{ id: 'n', setup: '', affordances: [{ verb: 'aid', stat: 'empathy', difficulty: 'normal', hint: '' }] }],
        goals: [{ id: 'w', kind: 'flag', outcome: 'win', label: 'win', predicate: { kind: 'always' } }],
      }),
    });
    // At baseline warmth the partner gate is closed.
    expect(getQuestLobby(world.id).quests[0]!.eligible).toBe(false);
    expect(getQuestLobby(world.id).quests[0]!.lockReason).toContain(character.name);
    // Warm them up past the gate; now it opens.
    applyRelationshipChange(character.id, { affection: 90, trust: 60, chemistry: 60 }, { source: 'test' });
    expect(getQuestLobby(world.id).quests[0]!.eligible).toBe(true);
  });

  it('listing the lobby never persists a relationship row for an UNMET partner (read-only)', () => {
    const { world } = seedWorldAndCharacter();
    // Anchor to a partner the player has never met (no relationship row) — the old
    // getRelationship() would have INSERTed one just by listing the lobby.
    const unmet = 'char_unmet_partner';
    createQuest({
      worldId: world.id,
      name: 'Heart Quest',
      partnerId: unmet,
      minWarmthBand: 2,
      graph: QuestGraphSchema.parse({
        entryNodeId: 'n',
        nodes: [{ id: 'n', setup: '', affordances: [{ verb: 'aid', stat: 'empathy', difficulty: 'normal', hint: '' }] }],
        goals: [{ id: 'w', kind: 'flag', outcome: 'win', label: 'win', predicate: { kind: 'always' } }],
      }),
    });
    expect(getRelationshipIfExists(unmet)).toBeUndefined();
    const lobby = getQuestLobby(world.id); // a READ surface
    expect(lobby.quests[0]!.eligible).toBe(false); // gated (no rapport yet)
    expect(getRelationshipIfExists(unmet)).toBeUndefined(); // …and nothing was written
  });
});

describe('authoring CRUD', () => {
  it('rejects a quest with no win goal', () => {
    const { world } = seedWorldAndCharacter();
    expect(() =>
      createQuest({
        worldId: world.id,
        name: 'Doomed',
        graph: QuestGraphSchema.parse({
          entryNodeId: 'n',
          nodes: [{ id: 'n', setup: '', affordances: [{ verb: 'wait', stat: 'grit', difficulty: 'normal', hint: '' }] }],
          // only a LOSE goal — nothing the player can win
          goals: [{ id: 'l', kind: 'flag', outcome: 'lose', label: 'lose', predicate: { kind: 'always' } }],
        }),
      }),
    ).toThrow(/win/i);
  });

  it('creates, lists, updates, and deletes (clearing any orphan run)', async () => {
    const { world } = seedWorldAndCharacter();
    ensureWorldState(world.id);
    const q = makeQuest(world.id);
    expect(listAuthoredQuests(world.id).map((x) => x.id)).toContain(q.id);

    updateQuest(q.id, { name: 'Renamed Gate' });
    expect(listAuthoredQuests(world.id)[0]!.name).toBe('Renamed Gate');

    // Start a run, then delete the quest out from under it → the run is cleared.
    await startQuest(world.id, q.id);
    expect(getActiveQuest(world.id)).not.toBeNull();
    deleteQuest(q.id);
    expect(listAuthoredQuests(world.id)).toHaveLength(0);
    expect(getActiveQuest(world.id)).toBeNull();
  });
});

describe('LLM quest generation (boundGeneratedQuest)', () => {
  const rawDraft = (success: unknown[]) =>
    QuestGenSchema.parse({
      name: 'Drafted',
      blurb: 'A model draft.',
      graph: {
        entryNodeId: 'a',
        maxTurns: 8,
        nodes: [{ id: 'a', setup: 'A scene.', affordances: [{ verb: 'persuade', stat: 'charm', difficulty: 'hard', hint: '', effects: { success } }] }],
        goals: [], // the model forgot a win goal
      },
    });

  it('reuses a success flag as the synthesized win goal', () => {
    const draft = boundGeneratedQuest(rawDraft([{ op: 'setFlag', flag: 'opened' }]), null);
    expect(hasWinGoal(draft.graph)).toBe(true);
    const win = draft.graph.goals.find((g) => g.outcome === 'win')!;
    expect(win.predicate).toMatchObject({ kind: 'flag', flag: 'opened' });
  });

  it('injects a completion flag + goal when no success flag exists', () => {
    const draft = boundGeneratedQuest(rawDraft([{ op: 'adjustStat', key: 'disposition', entityId: 'x', delta: 5 }]), null);
    expect(hasWinGoal(draft.graph)).toBe(true);
    // the injected flag is both set by a success effect AND the win predicate
    const flags = draft.graph.nodes.flatMap((n) => n.affordances.flatMap((a) => a.effects.success.filter((e) => e.op === 'setFlag').map((e) => e.flag)));
    expect(flags).toContain('quest_complete');
  });

  it('adds a reachable backup win when the model wires its win to an unsettable flag', () => {
    // The model's win checks a flag NOTHING sets, but a success sets a different flag.
    const draft = boundGeneratedQuest(
      QuestGenSchema.parse({
        name: 'X',
        blurb: '',
        graph: {
          entryNodeId: 'a',
          nodes: [{ id: 'a', setup: '', affordances: [{ verb: 'persuade', stat: 'charm', difficulty: 'hard', hint: '', effects: { success: [{ op: 'setFlag', flag: 'opened' }] } }] }],
          goals: [{ id: 'w', kind: 'flag', outcome: 'win', label: 'win', predicate: { kind: 'flag', flag: 'never_set' } }],
        },
      }),
      null,
    );
    expect(isWinReachable(draft.graph)).toBe(true);
  });

  it('sets a warmth-band gate when partner-anchored', () => {
    const draft = boundGeneratedQuest(rawDraft([{ op: 'setFlag', flag: 'done' }]), 'char:123');
    expect(draft.partnerId).toBe('char:123');
    expect(draft.minWarmthBand).toBe(1);
  });

  it('fails safe when the model is unreachable', async () => {
    updateLlmSettings({ baseUrl: 'http://127.0.0.1:1/v1' });
    const { world } = seedWorldAndCharacter();
    const res = await generateQuest(world.id, 'A heist at the clocktower.', null);
    expect(res.ok).toBe(false);
  });
});

describe('replaying a quest starts it clean', () => {
  it('clears the prior run’s transcript on leave + restart (no stale log)', async () => {
    updateLlmSettings({ baseUrl: 'http://127.0.0.1:1/v1' });
    const { world } = seedWorldAndCharacter();
    ensureWorldState(world.id);
    const quest = makeQuest(world.id);

    await startQuest(world.id, quest.id);
    const afterTurn = await takeQuestTurn(world.id, 'I talk the watchman round.');
    expect(afterTurn.log.length).toBe(1); // a turn was logged

    abandonQuest(world.id);
    const restarted = await startQuest(world.id, quest.id);
    expect(restarted.status).toBe('active');
    expect(restarted.turn).toBe(0); // state reset…
    expect(restarted.log).toHaveLength(0); // …and the log reset too (the bug)
  });
});

describe('off-axis input degrades safely (offline templated interpreter)', () => {
  it('routes self-directed input to a neutral no-op — not a social verb, no turn consumed', async () => {
    updateLlmSettings({ baseUrl: 'http://127.0.0.1:1/v1' }); // force the offline path
    const { world } = seedWorldAndCharacter();
    ensureWorldState(world.id);
    const quest = makeQuest(world.id);
    await startQuest(world.id, quest.id);

    const scene = await takeQuestTurn(world.id, '*I kill myself*');
    expect(scene.status).toBe('active'); // a roll never resolved it
    expect(scene.turn).toBe(0); // the turn budget is untouched
    const beat = scene.log[scene.log.length - 1]!;
    expect(beat.neutral).toBe(true);
    expect(beat.narration).not.toMatch(/deceiv|lie|bluff/i);
  });

  it('treats a bare question as a conversation — the character replies, nothing mechanical changes', async () => {
    updateLlmSettings({ baseUrl: 'http://127.0.0.1:1/v1' }); // offline → templated reply
    const { world } = seedWorldAndCharacter();
    ensureWorldState(world.id);
    const quest = makeQuest(world.id);
    await startQuest(world.id, quest.id);

    const scene = await takeQuestTurn(world.id, 'I ask the watchman what he knows.');
    const beat = scene.log[scene.log.length - 1]!;
    expect(beat.neutral).toBe(true);
    expect(beat.voiced).toBe(true); // a conversation, not a bluff or a dead beat
    expect(scene.turn).toBe(0); // free — no turn consumed
    // …and it's an actual reply, not the inert "nothing answers that" line
    expect(beat.narration).not.toMatch(/nothing answers that/i);
    expect(beat.narration).toMatch(/Watchman|hears you out|few words/i);
  });
});

describe('resolution framing', () => {
  it('frames a goal-less endScene resolution as a WIN, not a loss', async () => {
    updateLlmSettings({ baseUrl: 'http://127.0.0.1:1/v1' }); // offline templated path
    const { world } = seedWorldAndCharacter();
    ensureWorldState(world.id);
    // Every grade ends the scene (desperate → the spine tier is unlocked); the lone win
    // goal is gated on a flag nothing sets, so the endScene fires goal-less.
    const quest = createQuest({
      worldId: world.id,
      name: 'The Exit',
      graph: QuestGraphSchema.parse({
        entryNodeId: 'room',
        maxTurns: 5,
        timeoutOutcome: 'resolved',
        nodes: [
          {
            id: 'room',
            kind: 'scene',
            setup: 'A heavy door.',
            entities: [],
            edges: [],
            isTerminal: false,
            affordances: [
              {
                verb: 'force',
                stat: 'grit',
                difficulty: 'desperate',
                hint: 'Shoulder it open.',
                effects: {
                  success: [{ op: 'endScene', status: 'resolved' }],
                  partial: [{ op: 'endScene', status: 'resolved' }],
                  fail: [{ op: 'endScene', status: 'resolved' }],
                  complication: [{ op: 'endScene', status: 'resolved' }],
                },
              },
            ],
          },
        ],
        goals: [{ id: 'w', kind: 'flag', outcome: 'win', label: 'Get out', predicate: { kind: 'flag', flag: 'never_set' } }],
      }),
    });

    await startQuest(world.id, quest.id);
    const scene = await takeQuestTurn(world.id, 'I force the door open.');
    expect(scene.status).toBe('resolved');
    expect(scene.resolution?.outcome).toBe('win'); // a clean ending, not a LOSE
  });
});

describe('determinism — reconstruction fold (plan §8)', () => {
  // Strip service-only bookkeeping the PURE referee never produces: the service stamps
  // `_warmthApplied` into state after resolve (it depends on the per-partner-day cap,
  // which lives outside quest state); everything else in state is referee-owned and so
  // must rebuild exactly from the logged (action, roll) transcript.
  const stripService = (s: QuestState): QuestState => {
    const stats = { ...s.stats };
    delete stats['_warmthApplied'];
    return { ...s, stats };
  };

  it('replaying the logged (action, roll) transcript rebuilds state_json exactly', async () => {
    updateLlmSettings({ baseUrl: 'http://127.0.0.1:1/v1' }); // deterministic offline path
    const { world } = seedWorldAndCharacter();
    ensureWorldState(world.id);
    const quest = createQuest({
      worldId: world.id,
      name: 'Fold',
      graph: QuestGraphSchema.parse({
        entryNodeId: 'gate',
        maxTurns: 6,
        timeoutOutcome: 'resolved',
        nodes: [
          {
            id: 'gate',
            kind: 'standoff',
            setup: 'A guard bars the way.',
            edges: [],
            isTerminal: false,
            entities: [{ id: 'g', name: 'Guard', faction: 'hostile', disposition: 0, hp: 30 }],
            affordances: [
              {
                verb: 'persuade',
                stat: 'charm',
                difficulty: 'hard',
                hint: 'Talk him round.',
                // every grade mutates state, so each turn is a real fold step
                effects: {
                  success: [
                    { op: 'setFlag', flag: 'won' },
                    { op: 'moveEntityToFaction', entityId: 'g', faction: 'ally' },
                    { op: 'adjustStat', key: 'disposition', entityId: 'g', delta: 10 },
                    { op: 'addMoney', amount: 30 },
                  ],
                  partial: [{ op: 'adjustStat', key: 'disposition', entityId: 'g', delta: 5 }],
                  fail: [{ op: 'adjustStat', key: 'disposition', entityId: 'g', delta: -3 }],
                  complication: [{ op: 'adjustStat', key: 'hp', entityId: 'g', delta: -5 }],
                },
              },
            ],
          },
        ],
        // win gated on a faction the success never grants (ally ≠ party) → runs to maxTurns
        goals: [{ id: 'w', kind: 'persuade', outcome: 'win', label: 'Win him over', predicate: { kind: 'entityFaction', entityId: 'g', faction: 'party' } }],
      }),
    });

    await startQuest(world.id, quest.id);
    const playerId = playerIdForWorld(world.id);
    for (let i = 0; i < 8; i += 1) {
      const run = activeQuestsRepo.getActive(world.id, playerId);
      if (!run || run.status !== 'active') break;
      await takeQuestTurn(world.id, 'I persuade the guard to stand down.');
    }

    const finalRun = activeQuestsRepo.getActive(world.id, playerId)!;
    const live = finalRun.state; // the durable state_json
    const turns = questTurnsRepo.listByRun(world.id, playerId, quest.id);
    expect(turns.length).toBeGreaterThan(1);

    // Fold the PURE referee over the logged (action, roll) pairs from the entry state —
    // the LLM is never re-invoked; the logged action IS the input (plan §8).
    let folded = initialQuestState(quest.graph);
    for (const turnRow of turns) {
      folded = resolveQuestAction(folded, quest.graph, turnRow.action, turnRow.roll).newState;
    }

    expect(stripService(folded)).toEqual(stripService(live));
  });
});

describe('start → resume → turn loop → resolve', () => {
  it('runs the full loop and always terminates within maxTurns', async () => {
    // Point the LLM at a closed port so the interpret/narrate seams fast-fail to
    // the deterministic templated path — the offline behaviour, network-free.
    updateLlmSettings({ baseUrl: 'http://127.0.0.1:1/v1' });
    const { world } = seedWorldAndCharacter();
    ensureWorldState(world.id);
    const quest = makeQuest(world.id);

    const opened = await startQuest(world.id, quest.id);
    expect(opened.status).toBe('active');
    expect(opened.turn).toBe(0);
    expect(opened.log).toHaveLength(0);

    // A second start while one is active is refused.
    await expect(startQuest(world.id, quest.id)).rejects.toThrow();

    // Resume returns the same live scene.
    const resumed = getActiveQuest(world.id);
    expect(resumed?.status).toBe('active');

    // Drive turns until resolved. Termination is code-owned, so this always ends
    // by the maxTurns (3) backstop at the latest — regardless of the seeded rolls.
    let scene = opened;
    let guard = 0;
    while (scene.status === 'active' && guard < 6) {
      scene = await takeQuestTurn(world.id, 'I tell the watchman his lord has betrayed him and ask him to stand down.');
      guard += 1;
      expect(scene.log.length).toBe(guard); // the transcript grows one beat per turn
    }
    expect(scene.status).not.toBe('active');
    expect(scene.resolution).not.toBeNull();
    expect(scene.turn).toBeLessThanOrEqual(3);

    // The resolved run still resumes (the resolution screen survives a refresh)…
    expect(getActiveQuest(world.id)?.status).not.toBe('active');
    // …until the player leaves it.
    abandonQuest(world.id);
    expect(getActiveQuest(world.id)).toBeNull();
  });
});
