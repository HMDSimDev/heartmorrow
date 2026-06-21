import {
  CAREER,
  CAREER_SKILL_LABELS,
  MinigameResultSchema,
  MinigameRewardSchema,
  MinigameStartSchema,
  DATING_STAT_KEYS,
  RELATIONSHIP_STAT_KEYS,
  isCareerSkill,
  masteryMult,
  type Milestone,
  type MinigameFinish,
  type MinigameFinishResponse,
  type MinigameInfo,
  type MinigameReaction,
  type MinigameResult,
  type MinigameReward,
  type MinigameStart,
  type MinigameStartResponse,
} from '@dsim/shared';
import { getMinigameModule, listMinigameInfo } from '../minigames/index';
import { buildMinigameReaction, favoriteMinigameFor, FAVORITE_BONUS, FLOP_PENALTY } from '../minigames/reactions';
import { worldsRepo, worldNotesRepo, minigameResultsRepo } from '../db/repositories';
import { getCharacter } from './character-service';
import { getRelationship } from './relationship-service';
import { getLlmSettings } from './settings-service';
import { applyCharacterDatingChange, applyRelationshipChange, stampLastDate } from './stat-service';
import { assertCanAct, ensureWorldState, spendStamina } from './world-clock-service';
import { addMoney, getSkillLevel, grantCareerXp } from './player-service';
import { addMemoriesFromEvaluation } from './memory-service';
import { appendChronicleLine } from './chronicle-service';
import { detectMilestoneCrossing } from './milestone-service';
import { recordEvent } from './event-service';
import { newId, playerIdForWorld } from '../lib/ids';
import { badRequest } from '../lib/errors';

interface ActiveRun {
  minigameId: MinigameStart['minigameId'];
  characterId: string | null;
  worldId: string | null;
  state: unknown;
  createdAt: number;
}

// In-memory run store. Holds the server-authoritative state (answer keys,
// totals) between start and finish. A run lasts for the server's lifetime.
const runs = new Map<string, ActiveRun>();

const REWARD_DELTA_CAP = 10;
const REWARD_MONEY_CAP = 100;

/** A play that lands at or above this grade leaves a remembered mark. */
const GOOD_PLAY = new Set(['S', 'A', 'B']);

function boundReward(reward: MinigameReward): MinigameReward {
  const cap = (n: number) => Math.max(-REWARD_DELTA_CAP, Math.min(REWARD_DELTA_CAP, Math.round(n)));
  const dating: Record<string, number> = {};
  for (const k of DATING_STAT_KEYS) {
    const v = reward.dating[k];
    if (typeof v === 'number' && v !== 0) dating[k] = cap(v);
  }
  const relationship: Record<string, number> = {};
  for (const k of RELATIONSHIP_STAT_KEYS) {
    const v = reward.relationship[k];
    if (typeof v === 'number' && v !== 0) relationship[k] = cap(v);
  }
  return MinigameRewardSchema.parse({
    dating,
    relationship,
    money: Math.max(0, Math.min(REWARD_MONEY_CAP, Math.round(reward.money))),
  });
}

export function listMinigames(): MinigameInfo[] {
  return listMinigameInfo();
}

export async function startMinigame(input: MinigameStart): Promise<MinigameStartResponse> {
  const data = MinigameStartSchema.parse(input);
  const module = getMinigameModule(data.minigameId);

  const character = data.characterId ? getCharacter(data.characterId) : null;
  const relationship = character ? getRelationship(character.id) : null;
  const world =
    (character?.worldId ? worldsRepo.get(character.worldId) : undefined) ??
    (data.worldId ? worldsRepo.get(data.worldId) : undefined) ??
    null;
  const worldNotes = world ? worldNotesRepo.listByWorld(world.id) : [];
  const settings = getLlmSettings();

  // Minigames cost a daily action when tied to a world; block at 0 stamina.
  if (world) assertCanAct(world.id);

  // A career-gated job stays locked until the required skill is high enough.
  if (world && isCareerSkill(module.info.requiresSkill)) {
    const have = getSkillLevel(module.info.requiresSkill, playerIdForWorld(world.id));
    const need = module.info.requiresLevel ?? 0;
    if (have < need) {
      throw badRequest(
        `That work isn't open to you yet — reach ${CAREER_SKILL_LABELS[module.info.requiresSkill]} level ${need} first.`,
      );
    }
  }

  const built = await module.build({ character, relationship, world, worldNotes, settings });
  const runId = newId('run');
  runs.set(runId, {
    minigameId: data.minigameId,
    characterId: data.characterId,
    worldId: world?.id ?? null,
    state: built.state,
    createdAt: Date.now(),
  });

  return { runId, minigameId: data.minigameId, config: built.config };
}

export function finishMinigame(input: MinigameFinish): MinigameFinishResponse {
  const run = runs.get(input.runId);
  if (!run) throw badRequest('Minigame run not found or expired. Start a new game.');
  if (input.submission.minigameId !== run.minigameId) {
    throw badRequest('Submission does not match the started minigame.');
  }

  const module = getMinigameModule(run.minigameId);
  const resolved = module.resolve(input.submission.submission, run.state);
  const reward = boundReward(resolved.reward);

  // A money-only JOB (rewardsCharacter:false — e.g. The Woodlot, The Copy Desk) is
  // impersonal: it must NOT touch a relationship, leave a memory, or sting a partner
  // on a flop, even if one happened to be selected when it started. Ignore the run's
  // character entirely for such games (money + best-score still key off the world).
  const characterId = module.info.rewardsCharacter ? run.characterId : null;
  const character = characterId ? getCharacter(characterId) : null;

  // A money-only JOB scales its pay with the skill's mastery (flat-capped) and grants
  // career XP; a bonding game keeps the standard bounded reward and touches no skill.
  const isJob = !module.info.rewardsCharacter;
  let paidMoney = reward.money;
  if (isJob && run.worldId && isCareerSkill(module.info.skill)) {
    const level = getSkillLevel(module.info.skill, playerIdForWorld(run.worldId));
    paidMoney = Math.min(CAREER.ABSOLUTE_MAX_PAY, Math.round(reward.money * masteryMult(level)));
  }
  const paidReward = paidMoney === reward.money ? reward : MinigameRewardSchema.parse({ ...reward, money: paidMoney });
  const playedFavorite = !!character && favoriteMinigameFor(character) === run.minigameId;

  // Warmth BEFORE any deltas, so we can detect a band crossing this play caused.
  const beforeRel = characterId ? getRelationship(characterId) : null;

  // Apply rewards through the validated stat service. The CLIENT NEVER supplies
  // these deltas — they are derived from the server-held state + the submission.
  if (characterId) {
    if (Object.keys(reward.dating).length > 0) {
      applyCharacterDatingChange(characterId, reward.dating, { source: 'minigame', detail: { minigameId: run.minigameId } });
    }
    if (Object.keys(reward.relationship).length > 0) {
      applyRelationshipChange(characterId, reward.relationship, { source: 'minigame', detail: { minigameId: run.minigameId } });
    }
    // Two-way stakes: playing their favorite lands warmer; a genuine flop stings.
    if (playedFavorite && resolved.grade !== 'F') {
      applyRelationshipChange(characterId, { ...FAVORITE_BONUS }, { source: 'minigame_favorite', detail: { minigameId: run.minigameId } });
    } else if (resolved.grade === 'F') {
      applyRelationshipChange(characterId, { ...FLOP_PENALTY }, { source: 'minigame_flop', detail: { minigameId: run.minigameId } });
    }
  }
  // Reward goes to THIS world's wallet (a world-less solo run earns nothing).
  if (paidReward.money > 0 && run.worldId) addMoney(paidReward.money, playerIdForWorld(run.worldId));

  // A job shift builds its skill — XP scales with how well it went (an F earns ~none).
  if (isJob && run.worldId && isCareerSkill(module.info.skill) && module.info.skillXp) {
    const gainedXp = Math.round(module.info.skillXp * (resolved.score / 100));
    if (gainedXp > 0) grantCareerXp(module.info.skill, gainedXp, playerIdForWorld(run.worldId));
  }

  // Personal best — read the prior best (within this world) BEFORE persisting.
  const priorBest = minigameResultsRepo.bestScore(run.minigameId, characterId, run.worldId);
  const isNewBest = priorBest !== null && resolved.score > priorBest;

  const result: MinigameResult = MinigameResultSchema.parse({
    id: newId('mgr'),
    minigameId: run.minigameId,
    characterId,
    worldId: run.worldId,
    score: resolved.score,
    grade: resolved.grade,
    reward: paidReward,
    createdAt: Date.now(),
  });
  minigameResultsRepo.insert(result);
  runs.delete(input.runId);

  // A minigame play costs a daily action (world-bound) + counts as seeing them.
  if (run.worldId) {
    if (characterId) stampLastDate(characterId, ensureWorldState(run.worldId).day);
    spendStamina(run.worldId);
  }

  // --- Make it matter: reaction, remembered moment, milestone --------------
  const reaction: MinigameReaction | null = buildMinigameReaction({
    character,
    minigameId: run.minigameId,
    grade: resolved.grade,
    score: resolved.score,
    seed: result.id,
    playedFavorite,
  });

  let milestone: Milestone | null = null;
  if (characterId && character) {
    const day = run.worldId ? ensureWorldState(run.worldId).day : 0;
    const title = module.info.title;

    // A great game night can be the moment you grow closer — feed the spine.
    if (beforeRel) {
      try {
        milestone = detectMilestoneCrossing(characterId, beforeRel, getRelationship(characterId), { day, mode: 'minigame' });
      } catch {
        /* milestone detection is best-effort */
      }
    }

    if (GOOD_PLAY.has(resolved.grade)) {
      // A durable memory the character will recall on later dates/texts + Moments.
      try {
        const memoryText =
          resolved.score >= 85
            ? `We played ${title} together and ${character.name.split(' ')[0]} was honestly impressed with me.`
            : `We had a good time playing ${title} together.`;
        addMemoriesFromEvaluation(
          characterId,
          [{ text: memoryText, importance: resolved.grade === 'S' ? 4 : 3, tags: ['minigame'] }],
          result.id,
        );
      } catch {
        /* memory write is best-effort; never break the finish contract */
      }
      // A chronicle line so it surfaces in their history (no date-tally bump).
      try {
        const flavor = reaction ? ` ${reaction.line.replace(/"/g, '')}` : '';
        appendChronicleLine(characterId, day, 'minigame', `${title} together — ${resolved.grade} (${resolved.score}).${flavor}`, { bumpSession: false });
      } catch {
        /* chronicle is best-effort */
      }
      if (isNewBest) {
        try {
          appendChronicleLine(characterId, day, 'minigame', `🏆 A new personal best at ${title}: ${resolved.score}.`, { bumpSession: false });
        } catch {
          /* best-effort */
        }
      }
    }
  }

  recordEvent('minigame_finish', {
    worldId: run.worldId,
    minigameId: run.minigameId,
    characterId,
    score: resolved.score,
    grade: resolved.grade,
    tone: reaction?.tone ?? null,
    playedFavorite,
    isNewBest,
  });

  return {
    result,
    relationship: characterId ? getRelationship(characterId) : null,
    reaction,
    milestone,
    bestScore: priorBest,
    isNewBest,
    playedFavorite,
  };
}

export function recentResults(worldId?: string | null): MinigameResult[] {
  return worldId ? minigameResultsRepo.listByWorld(worldId) : minigameResultsRepo.list();
}

/** Test helper: reset the in-memory run store. */
export function _resetRuns(): void {
  runs.clear();
}
