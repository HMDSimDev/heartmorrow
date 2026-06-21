import {
  LoreQuizConfigSchema,
  MemoryMatchConfigSchema,
  TimingMeterConfigSchema,
  SweetAndSourConfigSchema,
  TwoTruthsConfigSchema,
  RhythmSerenadeConfigSchema,
  LumberjackConfigSchema,
  WriterConfigSchema,
  type Character,
  type LoreQuizSubmission,
  type LumberjackSubmission,
  type MemoryMatchSubmission,
  type MinigameId,
  type MinigameSubmission,
  type RhythmSerenadeSubmission,
  type SweetAndSourSubmission,
  type TimingMeterSubmission,
  type TwoTruthsSubmission,
  type WriterSubmission,
} from '@dsim/shared';
import { MemoryMatchGame } from './MemoryMatchGame';
import { TimingMeterGame } from './TimingMeterGame';
import { LoreQuizGame } from './LoreQuizGame';
import { SweetAndSourGame } from './SweetAndSourGame';
import { TwoTruthsGame } from './TwoTruthsGame';
import { RhythmSerenade } from './RhythmSerenade';
import { LumberjackGame } from './LumberjackGame';
import { WriterGame } from './WriterGame';

/** An in-flight minigame run: the id, the server run handle, and the opaque config. */
export interface ActiveGame {
  minigameId: MinigameId;
  runId: string;
  config: unknown;
}

/**
 * Renders the play surface for an active minigame run and reports the player's raw
 * submission via `onComplete`. Shared by the Arcade (bonding games) and the Work app
 * (job games) so the launch/finish plumbing lives in one place.
 */
export function GameView({
  active,
  partner,
  onComplete,
}: {
  active: ActiveGame;
  partner: Character | null;
  onComplete: (s: MinigameSubmission) => void;
}) {
  switch (active.minigameId) {
    case 'memory_match':
      return (
        <MemoryMatchGame
          config={MemoryMatchConfigSchema.parse(active.config)}
          onComplete={(submission: MemoryMatchSubmission) => onComplete({ minigameId: 'memory_match', submission })}
        />
      );
    case 'timing_meter':
      return (
        <TimingMeterGame
          config={TimingMeterConfigSchema.parse(active.config)}
          onComplete={(submission: TimingMeterSubmission) => onComplete({ minigameId: 'timing_meter', submission })}
        />
      );
    case 'lore_quiz':
      return (
        <LoreQuizGame
          config={LoreQuizConfigSchema.parse(active.config)}
          partner={partner ?? undefined}
          onComplete={(submission: LoreQuizSubmission) => onComplete({ minigameId: 'lore_quiz', submission })}
        />
      );
    case 'sweet_and_sour':
      return (
        <SweetAndSourGame
          config={SweetAndSourConfigSchema.parse(active.config)}
          onComplete={(submission: SweetAndSourSubmission) => onComplete({ minigameId: 'sweet_and_sour', submission })}
        />
      );
    case 'two_truths_a_lie':
      return (
        <TwoTruthsGame
          config={TwoTruthsConfigSchema.parse(active.config)}
          onComplete={(submission: TwoTruthsSubmission) => onComplete({ minigameId: 'two_truths_a_lie', submission })}
        />
      );
    case 'rhythm_serenade':
      return (
        <RhythmSerenade
          config={RhythmSerenadeConfigSchema.parse(active.config)}
          onComplete={(submission: RhythmSerenadeSubmission) => onComplete({ minigameId: 'rhythm_serenade', submission })}
        />
      );
    case 'lumberjack':
      return (
        <LumberjackGame
          config={LumberjackConfigSchema.parse(active.config)}
          onComplete={(submission: LumberjackSubmission) => onComplete({ minigameId: 'lumberjack', submission })}
        />
      );
    case 'writer':
      return (
        <WriterGame
          config={WriterConfigSchema.parse(active.config)}
          onComplete={(submission: WriterSubmission) => onComplete({ minigameId: 'writer', submission })}
        />
      );
    default:
      return null;
  }
}
