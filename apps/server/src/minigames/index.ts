import { registerMinigame } from './registry';
import { memoryMatchModule } from './memory-match';
import { timingMeterModule } from './timing-meter';
import { loreQuizModule } from './lore-quiz';
import { sweetAndSourModule } from './sweet-and-sour';
import { twoTruthsModule } from './two-truths-a-lie';
import { rhythmSerenadeModule } from './rhythm-serenade';

// Register all built-in minigames. To add a new one, create a module that
// implements `MinigameModule` and register it here (see docs/ADDING_MINIGAMES.md).
registerMinigame(memoryMatchModule);
registerMinigame(timingMeterModule);
registerMinigame(loreQuizModule);
registerMinigame(sweetAndSourModule);
registerMinigame(twoTruthsModule);
registerMinigame(rhythmSerenadeModule);

export * from './registry';
