import { registerClockHooks } from './world-clock-service';
import { generateAnniversaryTextsForDay, generateDailyTextsForDay } from './text-generation-service';
import { generateDailyEmails } from './email-service';
import { generateGossipForDay, generateKnowledgeGossipForDay } from './gossip-service';
import { generatePostcardsForDay } from './postcard-service';
import { generateFeedForDay } from './feed-service';
import { deliverCrisisTextsForDay } from './crisis-service';
import { deliverDueTexts } from './text-message-service';
import { simulateWorldDay } from './world-sim-service';
import { generateMarketNews } from './market-service';
import { reportOperationFailure } from '../lib/operation-warning';

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
    // Anniversary remembrances FIRST, then the daily cadence: both passes share
    // the one-character-text-per-day guard, so sequencing (not racing) them is
    // what lets a remembrance take the day's slot instead of losing a coin flip.
    void generateAnniversaryTextsForDay(worldId, day)
      .catch((error) => { reportOperationFailure('anniversary_text_generation_failed', 'Anniversary texts could not be generated for the new day.', error, { worldId, day }); })
      .then(() => generateDailyTextsForDay(worldId, day))
      .catch((error) => { reportOperationFailure('daily_text_generation_failed', 'Daily texts could not be generated for the new day.', error, { worldId, day }); });
    void generateDailyEmails(worldId, day).catch((error) => { reportOperationFailure('daily_email_generation_failed', 'Daily email could not be generated for the new day.', error, { worldId, day }); });
    void generatePostcardsForDay(worldId, day).catch((error) => { reportOperationFailure('postcard_generation_failed', 'Postcards could not be generated for the new day.', error, { worldId, day }); });
    void generateGossipForDay(worldId, day).catch((error) => { reportOperationFailure('gossip_generation_failed', 'Gossip could not be generated for the new day.', error, { worldId, day }); });
    void generateKnowledgeGossipForDay(worldId, day).catch((error) => { reportOperationFailure('knowledge_gossip_generation_failed', 'Knowledge gossip could not be generated for the new day.', error, { worldId, day }); });
    void generateFeedForDay(worldId, day).catch((error) => { reportOperationFailure('feed_generation_failed', 'Feed posts could not be generated for the new day.', error, { worldId, day }); });
    void deliverCrisisTextsForDay(worldId, day).catch((error) => { reportOperationFailure('crisis_text_delivery_failed', 'A relationship-support message could not be delivered for the new day.', error, { worldId, day }); });
    void generateMarketNews(worldId, day).catch((error) => { reportOperationFailure('market_news_generation_failed', 'Market news could not be generated for the new day.', error, { worldId, day }); });
  },
  onPhaseAdvanced: () => {
    try {
      deliverDueTexts();
    } catch (error) {
      reportOperationFailure('queued_text_delivery_failed', 'Queued phone messages could not be delivered.', error);
    }
  },
});

export const phoneBootstrapped = true;
