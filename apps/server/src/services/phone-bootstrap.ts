import { registerClockHooks } from './world-clock-service';
import { generateDailyTextsForDay } from './text-generation-service';
import { generateDailyEmails } from './email-service';
import { generateGossipForDay, generateKnowledgeGossipForDay } from './gossip-service';
import { generateFeedForDay } from './feed-service';
import { deliverCrisisTextsForDay } from './crisis-service';
import { deliverDueTexts } from './text-message-service';
import { simulateWorldDay } from './world-sim-service';
import { generateMarketNews } from './market-service';

/**
 * Wire the phone subsystem to the world clock without an import cycle:
 *  - world-sim → simulate the ENDED day SYNCHRONOUSLY (awaited inside advanceDay)
 *    so the recap popup shows what the NPC world did, in one wait.
 *  - day start  → generate the day's queued texts + emails (background — these stay
 *    fire-and-forget so a roster-sized fan-out never blocks the Sleep wait).
 *  - phase change → deliver any queued texts whose time has come.
 * Imported for side-effect at server startup (see app.ts).
 */
registerClockHooks({
  onWorldSim: (worldId, day) => simulateWorldDay(worldId, day),
  onDayStarted: (worldId, day) => {
    void generateDailyTextsForDay(worldId, day).catch(() => undefined);
    void generateDailyEmails(worldId, day).catch(() => undefined);
    void generateGossipForDay(worldId, day).catch(() => undefined);
    void generateKnowledgeGossipForDay(worldId, day).catch(() => undefined);
    void generateFeedForDay(worldId, day).catch(() => undefined);
    void deliverCrisisTextsForDay(worldId, day).catch(() => undefined);
    void generateMarketNews(worldId, day).catch(() => undefined);
  },
  onPhaseAdvanced: () => {
    try {
      deliverDueTexts();
    } catch {
      /* best effort */
    }
  },
});

export const phoneBootstrapped = true;
