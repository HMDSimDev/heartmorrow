import {
  DEFAULT_PLAYER_ID,
  DEFAULT_STARTING_MONEY,
  ExportBundleSchema,
  type ExportBundle,
} from '@dsim/shared';
import { getDb } from '../db/index';
import {
  assetsRepo,
  charactersRepo,
  eventsRepo,
  inventoryRepo,
  memoriesRepo,
  minigameResultsRepo,
  playersRepo,
  relationshipsRepo,
  shopItemsRepo,
  worldNotesRepo,
  worldsRepo,
  worldStatesRepo,
  threadsRepo,
  textMessagesRepo,
  emailsRepo,
  chroniclesRepo,
  endingsRepo,
  dayRecordsRepo,
  sessionsRepo,
  messagesRepo,
  feedPostsRepo,
  feedCommentsRepo,
  feedReactionsRepo,
  npcEdgesRepo,
  npcKnowledgeRepo,
  canonFactsRepo,
  propertiesRepo,
  propertyOwnershipRepo,
  propertyLeasesRepo,
  landlordNoticesRepo,
  companiesRepo,
  stockHoldingsRepo,
  stockPricesRepo,
  marketNewsRepo,
  gamblingRoundsRepo,
} from '../db/repositories';
import { recordEvent } from './event-service';
import { ensureDayRecords } from './day-record-service';

/**
 * Export all local game data into a single validated bundle. An 'authoring'
 * export zeroes the derived world-sim/canon arrays so re-seeding a shared world
 * can never inherit a playthrough's NPC edges, gossip, or ex-canonized facts.
 */
export function exportAll(opts: { kind?: 'authoring' | 'savegame' } = {}): ExportBundle {
  const kind = opts.kind ?? 'savegame';
  const authoring = kind === 'authoring';
  const worlds = worldsRepo.list();
  // Materialize any not-yet-recorded completed days so the almanac round-trips
  // even though the exported event log is capped (see ensureDayRecords).
  for (const w of worlds) ensureDayRecords(w.id);
  const characters = charactersRepo.list();
  const threads = threadsRepo.listByPlayer(DEFAULT_PLAYER_ID);
  const conversationSessions = sessionsRepo.list();
  return ExportBundleSchema.parse({
    version: 1,
    kind,
    exportedAt: Date.now(),
    worlds,
    worldNotes: worlds.flatMap((w) => worldNotesRepo.listByWorld(w.id)),
    characters,
    memories: characters.flatMap((c) => memoriesRepo.listByCharacter(c.id)),
    relationships: characters
      .map((c) => relationshipsRepo.getByCharacter(c.id, DEFAULT_PLAYER_ID))
      .filter((r): r is NonNullable<typeof r> => Boolean(r)),
    conversationSessions,
    messages: conversationSessions.flatMap((s) => messagesRepo.listBySession(s.id)),
    // Wallets/personas AND inventory are keyed PER WORLD (player:<worldId>) after the
    // player-identity migration, so export EVERY row — exporting only the legacy
    // DEFAULT_PLAYER_ID captured an empty default and made an import wipe every
    // world's money + items. (Relationships/emails/threads stay on DEFAULT_PLAYER_ID.)
    players: playersRepo.list(),
    assets: assetsRepo.list(),
    shopItems: shopItemsRepo.list(),
    inventory: inventoryRepo.list(),
    minigameResults: minigameResultsRepo.list(),
    events: eventsRepo.list(1000),
    worldStates: worlds.map((w) => worldStatesRepo.get(w.id)).filter((s): s is NonNullable<typeof s> => Boolean(s)),
    messageThreads: threads,
    // Include still-queued daily texts so a mid-day export round-trips faithfully.
    textMessages: threads.flatMap((t) => textMessagesRepo.listAllByThread(t.id)),
    emails: emailsRepo.listDeliveredByPlayer(DEFAULT_PLAYER_ID),
    chronicles: chroniclesRepo.list(),
    endings: endingsRepo.list(),
    dayRecords: dayRecordsRepo.list(),
    feedPosts: feedPostsRepo.list(),
    feedComments: feedCommentsRepo.list(),
    feedReactions: feedReactionsRepo.list(),
    npcEdges: authoring ? [] : npcEdgesRepo.list(),
    npcKnowledge: authoring ? [] : npcKnowledgeRepo.list(),
    canonFacts: authoring ? [] : canonFactsRepo.list(),
    // Wealth: authored definitions (properties, companies) always ship; playthrough
    // state (ownership, holdings, prices, news) is zeroed for an 'authoring' export.
    properties: propertiesRepo.list(),
    companies: companiesRepo.list(),
    propertyOwnership: authoring ? [] : propertyOwnershipRepo.list(),
    propertyLeases: authoring ? [] : propertyLeasesRepo.list(),
    landlordNotices: authoring ? [] : landlordNoticesRepo.list(),
    stockHoldings: authoring ? [] : stockHoldingsRepo.list(),
    stockPrices: authoring ? [] : stockPricesRepo.list(),
    marketNews: authoring ? [] : marketNewsRepo.list(),
    // Gambling: pure playthrough state (settled-bet log + any active hand).
    gamblingRounds: authoring ? [] : gamblingRoundsRepo.list(),
  });
}

const CLEAR_ORDER = [
  'messages',
  'conversation_sessions',
  'inventory_items',
  'minigame_results',
  'character_memories',
  'relationships',
  'world_states',
  'text_messages',
  'message_threads',
  'emails',
  'character_chronicles',
  'character_endings',
  'day_records',
  // Faces: children (comments/reactions) before posts; posts + seen before worlds.
  'feed_reactions',
  'feed_comments',
  'feed_posts',
  'feed_seen',
  // Derived world-sim state (references characters + worlds) before characters.
  'npc_edges',
  'npc_knowledge',
  'canon_facts',
  // Wealth: playthrough rows (ownership/leases/notices/holdings/prices/news) before
  // their authored parents (properties/companies), and all of them before worlds.
  'stock_prices',
  'stock_holdings',
  'market_news',
  'property_ownership',
  'property_leases',
  'landlord_notices',
  'companies',
  'properties',
  // Gambling: pure playthrough rows (reference only worlds), wiped before worlds.
  'gambling_rounds',
  'characters',
  'world_notes',
  'worlds',
  'shop_items',
  'assets',
  'players',
  'game_events',
];

/**
 * Replace ALL local game data with the contents of a bundle. This is
 * destructive (it clears existing rows first) and runs in one transaction.
 */
export function importAll(bundle: ExportBundle): { imported: true } {
  const data = ExportBundleSchema.parse(bundle);
  const db = getDb();

  // Derived world-sim rows reference characters + worlds. Drop any orphan (a
  // recycled/old id that doesn't resolve in this bundle) so import never leaves
  // a dangling reference — and never throws on the world_id foreign key.
  const importWorldIds = new Set(data.worlds.map((w) => w.id));
  const importCharIds = new Set(data.characters.map((c) => c.id));
  const importPropertyIds = new Set(data.properties.map((p) => p.id));
  const importCompanyIds = new Set(data.companies.map((c) => c.id));
  let prunedDerived = 0;

  db.transaction(() => {
    for (const table of CLEAR_ORDER) {
      db.exec(`DELETE FROM ${table};`);
    }
    // Insert in dependency-safe order.
    data.assets.forEach((a) => assetsRepo.insert(a));
    data.worlds.forEach((w) => worldsRepo.insert(w));
    data.worldStates.forEach((s) => worldStatesRepo.insert(s));
    data.worldNotes.forEach((n) => worldNotesRepo.insert(n));
    data.characters.forEach((c) => charactersRepo.insert(c));
    data.memories.forEach((m) => memoriesRepo.insert(m));
    data.relationships.forEach((r) => relationshipsRepo.insert(r));
    // Derived world-sim state, after characters (orphans pruned, not inserted).
    data.npcEdges.forEach((e) => {
      if (importWorldIds.has(e.worldId) && importCharIds.has(e.aId) && importCharIds.has(e.bId)) npcEdgesRepo.upsert(e);
      else prunedDerived += 1;
    });
    data.npcKnowledge.forEach((k) => {
      // subjectId may be the player or null, so only the knower is required to resolve.
      if (importWorldIds.has(k.worldId) && importCharIds.has(k.knowerId)) npcKnowledgeRepo.insert(k);
      else prunedDerived += 1;
    });
    data.canonFacts.forEach((f) => {
      if (importWorldIds.has(f.worldId) && importCharIds.has(f.subjectId)) canonFactsRepo.insert(f);
      else prunedDerived += 1;
    });
    // Conversation history: sessions reference characters; messages reference sessions.
    data.conversationSessions.forEach((s) => sessionsRepo.insert(s));
    data.messages.forEach((m) => messagesRepo.insert(m));
    data.messageThreads.forEach((t) => threadsRepo.insert(t));
    data.textMessages.forEach((m) => textMessagesRepo.insert(m));
    data.emails.forEach((e) => emailsRepo.insert(e));
    data.chronicles.forEach((c) => chroniclesRepo.insert(c));
    data.endings.forEach((e) => endingsRepo.insert(e));
    // Almanac day records, after worlds (FK). Orphan worlds were dropped above.
    data.dayRecords.forEach((d) => {
      if (importWorldIds.has(d.worldId)) dayRecordsRepo.upsert(d);
    });
    // Faces: posts before their comments/reactions (FK dependency).
    data.feedPosts.forEach((p) => feedPostsRepo.insert(p));
    data.feedComments.forEach((c) => feedCommentsRepo.insert(c));
    data.feedReactions.forEach((x) => feedReactionsRepo.insert(x));
    // Wealth: authored definitions after worlds, then playthrough rows (orphans pruned).
    data.properties.forEach((p) => {
      if (importWorldIds.has(p.worldId)) propertiesRepo.insert(p);
    });
    data.companies.forEach((c) => {
      if (importWorldIds.has(c.worldId)) companiesRepo.insert(c);
    });
    data.propertyOwnership.forEach((o) => {
      if (importWorldIds.has(o.worldId) && importPropertyIds.has(o.propertyId)) propertyOwnershipRepo.insert(o);
      else prunedDerived += 1;
    });
    data.propertyLeases.forEach((l) => {
      if (importWorldIds.has(l.worldId) && importPropertyIds.has(l.propertyId)) propertyLeasesRepo.upsert(l);
      else prunedDerived += 1;
    });
    data.landlordNotices.forEach((n) => {
      if (importWorldIds.has(n.worldId)) landlordNoticesRepo.insert(n);
      else prunedDerived += 1;
    });
    data.stockHoldings.forEach((h) => {
      if (importWorldIds.has(h.worldId) && importCompanyIds.has(h.companyId)) stockHoldingsRepo.upsert(h);
      else prunedDerived += 1;
    });
    data.stockPrices.forEach((sp) => {
      if (importWorldIds.has(sp.worldId) && importCompanyIds.has(sp.companyId)) stockPricesRepo.upsert(sp);
      else prunedDerived += 1;
    });
    data.marketNews.forEach((n) => {
      if (importWorldIds.has(n.worldId)) marketNewsRepo.insert(n);
      else prunedDerived += 1;
    });
    data.gamblingRounds.forEach((g) => {
      if (importWorldIds.has(g.worldId)) gamblingRoundsRepo.upsert(g);
      else prunedDerived += 1;
    });
    data.players.forEach((p) => {
      // Players use INSERT (table was cleared above). Go through the repo so the column
      // list stays in one place — a hand-written INSERT here previously dropped `career`.
      playersRepo.insert(p);
    });
    data.shopItems.forEach((s) => shopItemsRepo.insert(s));
    data.inventory.forEach((i) => inventoryRepo.insert(i));
    // Historical logs: re-insert so an export/import round-trip is faithful.
    data.minigameResults.forEach((m) => minigameResultsRepo.insert(m));
    data.events.forEach((e) => eventsRepo.insert(e));
  });

  recordEvent('data_imported', { worlds: data.worlds.length, characters: data.characters.length });
  if (prunedDerived > 0) recordEvent('import_pruned_derived', { count: prunedDerived });
  return { imported: true };
}

/** Tables that hold PLAYTHROUGH progress (not authored content). */
const PROGRESS_TABLES = [
  'messages',
  'conversation_sessions',
  'inventory_items',
  'minigame_results',
  'character_memories',
  'relationships',
  'world_states',
  'text_messages',
  'message_threads',
  'emails',
  'character_chronicles',
  // Reached endings are playthrough progress: keep them here (as CLEAR_ORDER and
  // deleteWorld already do) so a reset lets endings be re-earned. Without this the
  // "once only" guard in maybeReachEnding permanently blocks the ending after a reset
  // and the gallery shows a playthrough that no longer exists.
  'character_endings',
  'day_records',
  'feed_reactions',
  'feed_comments',
  'feed_posts',
  'feed_seen',
  // Derived world-sim state IS playthrough progress — a reset must wipe it so the
  // authored character returns pristine (no leftover sim edges / canonized facts).
  'npc_edges',
  'npc_knowledge',
  'canon_facts',
  // Wealth PLAYTHROUGH state (ownership/leases/notices/holdings/prices/news) is wiped;
  // the authored property + company DEFINITIONS are kept (they're content, not progress).
  'property_ownership',
  'property_leases',
  'landlord_notices',
  'stock_holdings',
  'stock_prices',
  'market_news',
  // Gambling: bet log + any active hand are playthrough state, wiped on reset.
  'gambling_rounds',
  'game_events',
];

/**
 * Erase ALL progress (relationships, memories, sessions, texts, emails, day/
 * stamina, inventory) and reset to Day 1 with starting money — but KEEP authored
 * content (worlds, characters, notes, shop items, assets).
 */
export function resetProgress(): { reset: true } {
  const db = getDb();
  // Clear progress AND reset money atomically — a crash mid-reset must not leave
  // wiped relationships alongside a stale (carried-over) money balance. Every
  // per-world wallet is reset to starting money (each world's persona is kept).
  db.transaction(() => {
    for (const table of PROGRESS_TABLES) db.exec(`DELETE FROM ${table};`);
    db.run('UPDATE players SET money = ?, updated_at = ?', DEFAULT_STARTING_MONEY, Date.now());
  });
  recordEvent('progress_reset', {});
  return { reset: true };
}
