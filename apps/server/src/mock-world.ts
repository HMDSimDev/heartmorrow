/**
 * Mock-world generator: builds one rich, fully "lived-in" showcase world so the
 * app can be screenshotted in action — characters with portraits, relationship
 * histories, chronicles, memories, date transcripts, milestones, phone threads,
 * emails, an epilogue, minigame scores and inventory.
 *
 * Everything here is fictional, original, and self-contained (no network calls).
 * Portraits come from `apps/server/data/mock_data` and are copied into the
 * controlled uploads directory as real assets.
 *
 * Run with: `pnpm --filter @dsim/server run mock`
 * (Refuses to run twice; set FORCE_MOCK=1 to add it on top of existing data.)
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  AssetSchema,
  CharacterChronicleSchema,
  CharacterEndingSchema,
  CharacterMemorySchema,
  ConversationSessionSchema,
  DayRecordSchema,
  EmailSchema,
  FeedCommentSchema,
  FeedPostSchema,
  FeedReactionSchema,
  GamblingRoundSchema,
  GameEventSchema,
  InventoryItemSchema,
  MarketNewsSchema,
  MessageSchema,
  MessageThreadSchema,
  MinigameResultSchema,
  PropertyLeaseSchema,
  PropertyOwnershipSchema,
  RelationshipSchema,
  StockHoldingSchema,
  StockPriceSchema,
  TextMessageSchema,
  WorldStateSchema,
  DEFAULT_PLAYER_ID,
  type ChronicleLine,
  type Flags,
} from '@dsim/shared';
import { config, ensureDirectories } from './config';
import { getDb, initDatabase } from './db/index';
import {
  assetsRepo,
  charactersRepo,
  chroniclesRepo,
  companiesRepo,
  dayRecordsRepo,
  emailsRepo,
  endingsRepo,
  eventsRepo,
  feedCommentsRepo,
  feedPostsRepo,
  feedReactionsRepo,
  gamblingRoundsRepo,
  inventoryRepo,
  marketNewsRepo,
  memoriesRepo,
  messagesRepo,
  minigameResultsRepo,
  playersRepo,
  propertiesRepo,
  propertyLeasesRepo,
  propertyOwnershipRepo,
  relationshipsRepo,
  sessionRapportRepo,
  sessionsRepo,
  shopItemsRepo,
  stockHoldingsRepo,
  stockPricesRepo,
  textMessagesRepo,
  threadsRepo,
  worldsRepo,
  worldStatesRepo,
} from './db/repositories';
import { createWorld, createWorldNote } from './services/world-service';
import { createCharacter, updateCharacter } from './services/character-service';
import { createShopItem } from './services/shop-service';
import { createProperty } from './services/property-service';
import { createCompany } from './services/market-service';
import { deleteAsset } from './services/asset-service';
import { getOrCreatePlayer, updatePlayer } from './services/player-service';
import { PlayerProfileSchema } from '@dsim/shared';
import type { Row } from './db/sqlite';
import { newId, playerIdForWorld } from './lib/ids';

const MOCK_WORLD_NAME = 'Asterfall Bay';

// --- time helpers -----------------------------------------------------------
// The playthrough is "currently" on in-world day 24. We backdate everything so
// timelines, recaps and Moments sort naturally.
const NOW = Date.now();
const DAY_MS = 22 * 60 * 60 * 1000; // a little under 24h so spacing reads nicely
const CURRENT_DAY = 24;
/** Epoch ms for an in-world day (day 24 ≈ now). */
const at = (day: number, offsetMs = 0): number => NOW - (CURRENT_DAY - day) * DAY_MS + offsetMs;
const MIN = 60 * 1000;

function installImage(file: string, altText: string, type: 'portrait' | 'other', tags: string[]): string {
  const src = path.join(config.serverRoot, 'data', 'mock_data', file);
  const id = newId('asset');
  const storedName = `${id}.png`;
  fs.copyFileSync(src, path.join(config.uploadsDir, storedName));
  assetsRepo.insert(
    AssetSchema.parse({
      id,
      type,
      path: storedName,
      filename: file,
      mimeType: 'image/png',
      altText,
      tags,
      metadata: { bytes: fs.statSync(src).size },
      createdAt: NOW,
    }),
  );
  return id;
}

const installPortrait = (file: string, altText: string): string =>
  installImage(file, altText, 'portrait', ['mock', 'portrait']);

/** A photo the player "took" and texted — stored exactly like a real uploaded
 *  attachment (an `other` asset referenced by a text's `imageAssetId`). */
const installPhoto = (file: string, altText: string): string =>
  installImage(file, altText, 'other', ['mock', 'photo']);

function setRelationship(
  characterId: string,
  stats: { affection: number; trust: number; chemistry: number; comfort: number; respect: number; curiosity: number; tension: number },
  flags: Flags,
  updatedAt: number,
): void {
  const existing = relationshipsRepo.getByCharacter(characterId, DEFAULT_PLAYER_ID);
  const rel = RelationshipSchema.parse({
    id: existing?.id ?? newId('rel'),
    characterId,
    playerId: DEFAULT_PLAYER_ID,
    ...stats,
    flags,
    updatedAt,
  });
  if (existing) relationshipsRepo.update(rel);
  else relationshipsRepo.insert(rel);
}

function addMemory(
  characterId: string,
  text: string,
  importance: number,
  tags: string[],
  createdAt: number,
  // Memories captured after a date carry the originating event id; the profile
  // then shows them as "💞 from a date" rather than "✍ added manually".
  sourceEventId: string,
): void {
  memoriesRepo.insert(
    CharacterMemorySchema.parse({
      id: newId('mem'),
      characterId,
      text,
      importance,
      tags,
      sourceEventId,
      createdAt,
      lastUsedAt: null,
    }),
  );
}

function addChronicle(characterId: string, chronicle: string, recentLines: ChronicleLine[], sessionCount: number, updatedAt: number): void {
  chroniclesRepo.insert(
    CharacterChronicleSchema.parse({
      characterId,
      playerId: DEFAULT_PLAYER_ID,
      chronicle,
      recentLines,
      sessionCount,
      updatedAt,
    }),
  );
}

function addEvent(type: string, payload: Record<string, unknown>, createdAt: number): string {
  const e = eventsRepo.insert(GameEventSchema.parse({ id: newId('evt'), type, payload, createdAt }));
  return e.id;
}

/** Record a date's session-evaluation event and return its id (used as the
 *  sourceEventId for memories captured on that date — exactly as endSession does). */
function addDateEval(characterId: string, day: number, mood: string, summaryLine: string, createdAt: number): string {
  return addEvent('session_eval', { characterId, day, mood, summaryLine }, createdAt);
}

interface Line {
  role: 'player' | 'character';
  text: string;
}
function addDate(
  characterId: string,
  locationId: string,
  day: number,
  summary: string,
  lines: Line[],
  createdAt: number,
): void {
  const session = sessionsRepo.insert(
    ConversationSessionSchema.parse({
      id: newId('sess'),
      characterId,
      locationId,
      mode: 'date',
      summary,
      ended: true,
      createdAt,
      updatedAt: createdAt + lines.length * MIN,
    }),
  );
  lines.forEach((l, i) => {
    messagesRepo.insert(
      MessageSchema.parse({
        id: newId('msg'),
        sessionId: session.id,
        role: l.role,
        text: l.text,
        metadata: {},
        createdAt: createdAt + i * MIN,
      }),
    );
  });
}

interface Text {
  sender: 'player' | 'character';
  body: string;
  day: number;
  offsetMin: number;
  attachment?: { shopItemId: string; name: string; claimed: boolean };
  /** An uploaded photo the sender attached (the texting feature's image support). */
  imageAssetId?: string;
}
function addThread(characterId: string, unread: number, texts: Text[]): void {
  const first = texts[0];
  const last = texts[texts.length - 1];
  const created = first ? at(first.day, first.offsetMin * MIN) : NOW;
  const lastAt = last ? at(last.day, last.offsetMin * MIN) : null;
  const thread = threadsRepo.insert(
    MessageThreadSchema.parse({
      id: newId('thr'),
      characterId,
      playerId: DEFAULT_PLAYER_ID,
      lastMessageAt: lastAt,
      unreadCount: unread,
      createdAt: created,
      updatedAt: lastAt ?? created,
    }),
  );
  for (const t of texts) {
    const ts = at(t.day, t.offsetMin * MIN);
    textMessagesRepo.insert(
      TextMessageSchema.parse({
        id: newId('txt'),
        threadId: thread.id,
        sender: t.sender,
        body: t.body,
        status: 'delivered',
        dayNumber: t.day,
        scheduledPhase: null,
        attachment: t.attachment ?? null,
        imageAssetId: t.imageAssetId ?? null,
        deliveredAt: ts,
        createdAt: ts,
      }),
    );
  }
}

/** Shop items this script creates — also used to purge them cleanly on re-run. */
const MOCK_ITEM_NAMES = [
  'Box of Harbor Caramels', 'Vial of Sea Glass', 'Roll of Expired Film', 'Indigo Wool Scarf', 'Paper Star-Lantern',
  'Conservatory Recital Ticket', 'Vintage Rangefinder Camera', 'Dog-Eared Romance Paperback', 'Bubble-Tea Punch Card', 'Lighthouse Linocut Print',
];

/**
 * Remove everything a previous run of this script created (the Asterfall Bay world
 * + all its characters' progress, plus the global rows it adds — mock emails,
 * shop items and inventory), so the generator is fully re-runnable and never
 * duplicates. Leaves any other world (e.g. the default seed) untouched.
 */
function purgeExisting(): void {
  const db = getDb();
  const world = worldsRepo.list().find((w) => w.name === MOCK_WORLD_NAME);
  if (world) {
    for (const c of charactersRepo.listByWorld(world.id)) {
      if (c.portraitAssetId) {
        try { deleteAsset(c.portraitAssetId); } catch { /* file already gone */ }
      }
      for (const t of db.all<Row>('SELECT id FROM message_threads WHERE character_id = ?', c.id)) {
        // Drop any photo a text carried (e.g. the mock image-texting demo) so its
        // asset row + uploaded file don't leak across re-runs.
        for (const m of db.all<Row>(
          'SELECT image_asset_id FROM text_messages WHERE thread_id = ? AND image_asset_id IS NOT NULL',
          t.id as string,
        )) {
          try { deleteAsset(m.image_asset_id as string); } catch { /* file already gone */ }
        }
        db.run('DELETE FROM text_messages WHERE thread_id = ?', t.id as string);
      }
      for (const s of db.all<Row>('SELECT id FROM conversation_sessions WHERE character_id = ?', c.id)) {
        db.run('DELETE FROM messages WHERE session_id = ?', s.id as string);
        db.run('DELETE FROM session_rapport WHERE session_id = ?', s.id as string);
      }
      db.run('DELETE FROM message_threads WHERE character_id = ?', c.id);
      db.run('DELETE FROM conversation_sessions WHERE character_id = ?', c.id);
      db.run('DELETE FROM relationships WHERE character_id = ?', c.id);
      db.run('DELETE FROM character_memories WHERE character_id = ?', c.id);
      db.run('DELETE FROM character_chronicles WHERE character_id = ?', c.id);
      db.run('DELETE FROM character_endings WHERE character_id = ?', c.id);
      db.run('DELETE FROM minigame_results WHERE character_id = ?', c.id);
      db.run("DELETE FROM game_events WHERE json_extract(payload, '$.characterId') = ?", c.id);
      db.run('DELETE FROM characters WHERE id = ?', c.id);
    }
    // World-scoped wealth / social / record tables (not tied to a single character).
    // feed_comments + feed_reactions cascade off feed_posts; stock_holdings + stock_prices
    // cascade off companies — but we delete explicitly too, so the generator stays
    // re-runnable even if a future schema drops a cascade.
    for (const post of db.all<Row>('SELECT id FROM feed_posts WHERE world_id = ?', world.id)) {
      db.run('DELETE FROM feed_comments WHERE post_id = ?', post.id as string);
      db.run('DELETE FROM feed_reactions WHERE post_id = ?', post.id as string);
    }
    db.run('DELETE FROM feed_posts WHERE world_id = ?', world.id);
    db.run('DELETE FROM feed_seen WHERE world_id = ?', world.id);
    db.run('DELETE FROM gambling_rounds WHERE world_id = ?', world.id);
    db.run('DELETE FROM day_records WHERE world_id = ?', world.id);
    db.run('DELETE FROM market_news WHERE world_id = ?', world.id);
    db.run('DELETE FROM stock_holdings WHERE world_id = ?', world.id);
    db.run('DELETE FROM stock_prices WHERE world_id = ?', world.id);
    db.run('DELETE FROM companies WHERE world_id = ?', world.id);
    db.run('DELETE FROM landlord_notices WHERE world_id = ?', world.id);
    db.run('DELETE FROM property_leases WHERE world_id = ?', world.id);
    db.run('DELETE FROM property_ownership WHERE world_id = ?', world.id);
    db.run('DELETE FROM properties WHERE world_id = ?', world.id);
    db.run('DELETE FROM world_notes WHERE world_id = ?', world.id);
    db.run('DELETE FROM world_states WHERE world_id = ?', world.id);
    db.run('DELETE FROM worlds WHERE id = ?', world.id);
  }
  // Global rows this script adds (not tied to the world):
  db.run("DELETE FROM emails WHERE sender_handle LIKE '%.bay'");
  for (const name of MOCK_ITEM_NAMES) {
    const item = shopItemsRepo.list().find((s) => s.name === name);
    if (item) {
      db.run('DELETE FROM inventory_items WHERE shop_item_id = ?', item.id);
      db.run('DELETE FROM shop_items WHERE id = ?', item.id);
    }
  }
}

function setMoney(amount: number, playerId: string): void {
  const player = getOrCreatePlayer(playerId);
  playersRepo.update(PlayerProfileSchema.parse({ ...player, money: amount, updatedAt: NOW }));
}

function mock(): void {
  ensureDirectories();
  initDatabase();
  purgeExisting(); // idempotent: clears any prior run so re-running never duplicates

  // --- World ----------------------------------------------------------------
  const cafe = { id: newId('loc'), name: 'The Driftwood Café', description: 'A tiny harbor café inherited from someone’s aunt: mismatched chairs, the smell of harbor-roast beans, and one window that fogs over when the espresso machine sighs.', tags: ['cozy', 'harbor', 'warm'], indoor: true, priceTier: 1 };
  const aquarium = { id: newId('loc'), name: 'Harborlight Aquarium', description: 'The town aquarium on the quay; after hours the tanks glow cobalt and the volunteers feed the rays in the blue dark.', tags: ['quiet', 'after-hours', 'sea'], indoor: true, priceTier: 2 };
  const lighthouse = { id: newId('loc'), name: 'Asterfall Light', description: 'The old lighthouse on the point, decommissioned but still climbed; from the gallery rail the whole bay turns to scattered light.', tags: ['outdoors', 'romantic', 'view'], indoor: false, priceTier: 0 };
  const arcade = { id: newId('loc'), name: 'The Starling Arcade', description: 'A restored train-station hall full of brass-trimmed cabinets and pinball, the platform clock still ticking over the high-score boards.', tags: ['games', 'nostalgic', 'loud'], indoor: true, priceTier: 1 };
  const conservatory = { id: newId('loc'), name: 'Asterfall Conservatory', description: 'Practice rooms and a small recital hall where the sea-light comes through tall windows and someone is always running the same difficult bar.', tags: ['music', 'quiet', 'university'], indoor: true, priceTier: 2 };
  const boardwalk = { id: newId('loc'), name: 'The Long Boardwalk', description: 'A weathered promenade strung between the harbor and the point, lined with shuttered stalls that bloom back to life for the Star Festival.', tags: ['outdoors', 'romantic', 'festival'], indoor: false, priceTier: 0 };

  const world = createWorld({
    name: MOCK_WORLD_NAME,
    summary:
      'A coastal university town under an old lighthouse, where students, artists, researchers and travelers wash up from all over the world. The harbor aquarium glows at night, the restored train arcade hums, and once a year the whole bay turns out for the Star Festival.',
    tone: 'Warm, slow-burn, salt-air campus romance — earnest and a little wistful.',
    globalNotes: 'Everyone passes through The Driftwood Café eventually. Gossip travels the boardwalk faster than the tide. The Star Festival is the night the town holds its breath.',
    rules: 'Grounded contemporary fiction — no magic, no sci-fi. Keep conflict interpersonal and low-stakes.',
    lore: 'Asterfall Bay was a working harbor that became a university town; the lighthouse went dark the same year the train station became an arcade. The Star Festival has marked the end of summer for as long as anyone remembers.',
    locations: [cafe, aquarium, lighthouse, arcade, conservatory, boardwalk],
    contentFlags: { allowRomance: true, allowMatureThemes: true, intensity: 'moderate' },
    // Showcase the optional mechanics (property / stock market / casino) in the demo world.
    featureFlags: { property: true, stockMarket: true, gambling: true },
  });

  // --- Player (this world's self-contained save) ----------------------------
  const playerId = playerIdForWorld(world.id);
  getOrCreatePlayer(playerId);
  updatePlayer(
    { name: 'Rowan', pronouns: 'they/them', personaNotes: 'A sound engineer who moved to Asterfall Bay last spring to run the Star Festival stages. A good listener; bad at sitting still.' },
    playerId,
  );
  setMoney(615, playerId);

  createWorldNote(world.id, {
    title: 'The Star Festival',
    body: 'At the end of summer the whole bay climbs the boardwalk to the lighthouse and releases paper star-lanterns over the water. The most romantic night of the year, and everyone knows it.',
    tags: ['event', 'romance'], scope: 'lore', importance: 5,
  });
  createWorldNote(world.id, {
    title: 'Town and gown',
    body: 'The harbor folk (café, aquarium, boardwalk) and the university folk (conservatory, students) share one small bay and quietly measure each other across it. Characters carry that divide.',
    tags: ['setting'], scope: 'lore', importance: 4,
  });
  createWorldNote(world.id, {
    title: 'Tone guidance',
    body: 'Warmth and longing over melodrama. Let the sea air and the festival lights do half the talking.',
    tags: ['tone'], scope: 'rule', importance: 5,
  });

  // --- Shop items (a handful, for gifts + inventory) ------------------------
  const caramels = createShopItem({ name: 'Box of Harbor Caramels', description: 'Cheap salted caramels from the boardwalk stall. A small, knowing gift.', price: 30, category: 'gift', rarity: 'uncommon', effects: [{ kind: 'relationship', stat: 'comfort', delta: 4 }, { kind: 'relationship', stat: 'affection', delta: 2 }], infiniteStock: true, stock: 0, assetId: null });
  const seaGlass = createShopItem({ name: 'Vial of Sea Glass', description: 'Frosted shards the tide spent years smoothing. Sentimental.', price: 25, category: 'gift', rarity: 'common', effects: [{ kind: 'relationship', stat: 'affection', delta: 3 }], infiniteStock: true, stock: 0, assetId: null });
  const film = createShopItem({ name: 'Roll of Expired Film', description: 'A discontinued stock that renders the bay in warm, grainy gold. For someone who shoots.', price: 60, category: 'gift', rarity: 'rare', effects: [{ kind: 'relationship', stat: 'chemistry', delta: 5 }, { kind: 'relationship', stat: 'affection', delta: 3 }], infiniteStock: false, stock: 3, assetId: null });
  const scarf = createShopItem({ name: 'Indigo Wool Scarf', description: 'Hand-dyed at the harbor market. Boosts your style for a few outings.', price: 85, category: 'apparel', rarity: 'rare', effects: [{ kind: 'temp_buff', stat: 'style', delta: 8, durationSessions: 3 }], infiniteStock: true, stock: 0, assetId: null });
  const starLantern = createShopItem({ name: 'Paper Star-Lantern', description: 'A hand-folded star-lantern for the Festival. Limited each summer.', price: 50, category: 'gift', rarity: 'rare', effects: [{ kind: 'relationship', stat: 'affection', delta: 6 }], infiniteStock: false, stock: 6, assetId: null });

  // Player owns a few things already.
  for (const [item, qty, day] of [[caramels, 1, 9], [seaGlass, 2, 14], [starLantern, 1, 20]] as const) {
    inventoryRepo.insert(InventoryItemSchema.parse({ id: newId('inv'), playerId, shopItemId: item.id, quantity: qty, acquiredAt: at(day) }));
  }

  // --- Characters -----------------------------------------------------------
  const luca = createCharacter({
    worldId: world.id,
    name: 'Luca Moretti',
    age: 25,
    pronouns: 'he/him',
    shortDescription: 'Italian café owner who inherited the tiny Driftwood Café from his aunt. Knows everyone’s usual order; acts like the town’s older brother.',
    personality: 'Warm, easy, endlessly hospitable. Looks after everyone but himself, and quietly worries he’s letting his own life pass him by.',
    creatorNotes: 'Gives and gives; melts when someone finally looks after him for once. Don’t mistake his kindness for having no needs.',
    speechStyle: 'Open and unhurried, fond teasing, switches into earnest the moment it counts.',
    likes: ['the first pour of the morning', 'feeding people', 'old harbor regulars', 'rain on a slow café day'],
    dislikes: ['being a burden', 'rushed goodbyes', 'wasted food'],
    boundaries: ['Don’t take his generosity for granted', 'Let him be cared for too'],
    goals: ['Keep his aunt’s café alive', 'Stop putting his own life last'],
    relationshipPreferences: 'Steady and domestic; falls into easy, lasting love and means every bit of it.',
    favoriteWeather: ['rainy', 'cloudy'],
    dislikedWeather: ['stormy'],
    datingStats: { charm: 82, empathy: 84, humor: 72, confidence: 74, intellect: 66, style: 70 },
    guardedness: 26, // warm and open — easy to reach, falls into things gently
    portraitAssetId: installPortrait('luca_moretti.png', 'Luca Moretti — warm Italian café owner in rolled sleeves and apron'),
    expressionAssets: {},
  });

  const clara = createCharacter({
    worldId: world.id,
    name: 'Clara Voss',
    age: 24,
    pronouns: 'she/her',
    shortDescription: 'German violinist at the Asterfall Conservatory. Elegant, blunt, hard to impress — secretly devoted to cheap sweets and dramatic romance novels.',
    personality: 'Disciplined and exacting, with a cool wit and a melodramatic softness she would die before admitting to.',
    creatorNotes: 'Won’t be charmed; can be earned. Reward sincerity and consistency, not flattery. The sweets are the tell.',
    speechStyle: 'Precise, dry, a little severe; rare warmth lands like a held note resolving.',
    likes: ['the difficult passage finally clean', 'cheap caramels', 'rain on the practice-room glass', 'being taken seriously'],
    dislikes: ['flattery', 'sloppiness', 'small talk'],
    boundaries: ['No empty compliments', 'Respect the work'],
    goals: ['Win the spring concerto seat', 'Let someone past the polish'],
    relationshipPreferences: 'Slow and exacting; immovably loyal once she decides you are worth the disruption.',
    favoriteWeather: ['cloudy', 'snowy'],
    dislikedWeather: ['sunny'],
    datingStats: { charm: 74, empathy: 60, humor: 58, confidence: 82, intellect: 86, style: 84 },
    guardedness: 62, // hard to impress; opens slowly, then completely
    portraitAssetId: installPortrait('clara_voss.png', 'Clara Voss — tall ash-blonde violinist in a black dress with a violin case'),
    expressionAssets: {},
  });

  const mei = createCharacter({
    worldId: world.id,
    name: 'Tachibana Mei',
    age: 21,
    pronouns: 'she/her',
    shortDescription: 'Japanese marine biology student who volunteers at the Harborlight Aquarium. Bright and playful, with a starfish pin in her side braid.',
    personality: 'Cheerful, curious, generous with her enthusiasm — under it, quietly straining against a high-achieving family’s expectations.',
    creatorNotes: 'Easy to like, harder to truly reach; the route is letting her be tired and unimpressive sometimes. Don’t add to the pressure.',
    speechStyle: 'Quick, warm, tumbling into tangents about sea creatures; goes small and honest when the mask slips.',
    likes: ['the rays at feeding time', 'tide pools', 'sweet bubble tea', 'people who ask real questions'],
    dislikes: ['being measured against her siblings', 'pretending she’s fine', 'cynicism about the ocean'],
    boundaries: ['Don’t pile on the pressure', 'Let her have off days'],
    goals: ['Finish her thesis on her own terms', 'Be wanted for herself, not her grades'],
    relationshipPreferences: 'Earnest and hopeful; wants someone who notices the person behind the bright front.',
    favoriteWeather: ['sunny', 'rainy'],
    dislikedWeather: ['stormy'],
    datingStats: { charm: 80, empathy: 78, humor: 76, confidence: 70, intellect: 74, style: 68 },
    guardedness: 24, // sunny and forward, though the real worry stays hidden a while
    portraitAssetId: installPortrait('tachibana_mei.png', 'Tachibana Mei — petite chestnut-haired marine biology student with a starfish pin'),
    expressionAssets: {},
  });

  const sofia = createCharacter({
    worldId: world.id,
    name: 'Sofía Reyes',
    age: 22,
    pronouns: 'she/her',
    shortDescription: 'Mexican street photographer documenting Asterfall Bay before modernization changes it. Flirts easily, speaks directly — and bolts when feelings get real.',
    personality: 'Bold, funny, fearless with a camera and with strangers; allergic to sincerity the moment it’s pointed at her.',
    creatorNotes: 'The flirting is the armor. The route is staying when she deflects, and meaning it. Don’t chase, don’t flinch.',
    speechStyle: 'Direct, teasing, quick on the comeback; goes quiet and careful when she’s actually moved.',
    likes: ['golden-hour light', 'expired film', 'the boardwalk before it’s gone', 'people who hold eye contact'],
    dislikes: ['being told to be serious', 'posed smiles', 'goodbyes she didn’t choose'],
    boundaries: ['Don’t corner her into feelings', 'No making it weird before she’s ready'],
    goals: ['Finish the Asterfall series before the cranes arrive', 'Stop running the second it gets real'],
    relationshipPreferences: 'Confident and casual on the surface; underneath, terrified and hopeful in equal measure.',
    favoriteWeather: ['foggy', 'cloudy'],
    dislikedWeather: ['rainy'],
    datingStats: { charm: 86, empathy: 64, humor: 78, confidence: 88, intellect: 70, style: 80 },
    guardedness: 44, // forward and flirty, but the sincere core is well defended
    portraitAssetId: installPortrait('sofia_reyes.png', 'Sofía Reyes — athletic street photographer with wavy dark hair and a camera strap'),
    expressionAssets: {},
  });

  const minhAn = createCharacter({
    worldId: world.id,
    name: 'Nguyễn Minh An',
    age: 22,
    pronouns: 'she/her',
    shortDescription: 'Vietnamese game design student who makes cozy puzzle games with a sharp, deadpan delivery. Round glasses, headphones around her neck.',
    personality: 'Observant, practical, dryly funny; very guarded about anything she hasn’t finished, which is everything that matters to her.',
    creatorNotes: 'Trust is shown by access to the unfinished work. Earn it by being safe to be unimpressive in front of. No prying.',
    speechStyle: 'Flat, precise, secretly very funny; the warmth is in what she chooses to show you, not what she says.',
    likes: ['a mechanic that finally clicks', 'lo-fi at 2am', 'the arcade’s old cabinets', 'people who don’t need filling silences'],
    dislikes: ['being watched while she works', '"when’s it coming out"', 'forced enthusiasm'],
    boundaries: ['Don’t look at the unfinished build uninvited', 'No pushing for the reveal'],
    goals: ['Ship her first real game', 'Let one person see the messy draft'],
    relationshipPreferences: 'Slow, wary, deeply loyal; lets you in by degrees, then all at once.',
    favoriteWeather: ['rainy', 'cloudy'],
    dislikedWeather: ['sunny'],
    datingStats: { charm: 58, empathy: 66, humor: 74, confidence: 60, intellect: 84, style: 62 },
    guardedness: 52, // guarded about the work; warms once she trusts you with the mess
    portraitAssetId: installPortrait('nguyen_minh-an.png', 'Nguyễn Minh An — game design student with a black bob, round glasses and a hoodie'),
    expressionAssets: {},
  });

  const seojun = createCharacter({
    worldId: world.id,
    name: 'Han Seo-jun',
    age: 23,
    pronouns: 'he/him',
    shortDescription: 'Korean architecture student who restores old buildings around town part-time. Distant at first; quietly remembers every small detail.',
    personality: 'Calm, reserved, conscientious. Keeps his feelings in good order and shows care through quiet, unasked-for acts. Wounded by carelessness.',
    creatorNotes: 'Reads as cold until you notice what he remembers. Slow to give trust, slow to forgive its misuse — broken faith costs double.',
    speechStyle: 'Spare, considered, understated; the rare direct sentence carries real weight.',
    likes: ['honest old joinery', 'the lighthouse stair', 'tea that’s gone slightly cold while he worked', 'people who keep their word'],
    dislikes: ['carelessness', 'being managed', 'promises made lightly'],
    boundaries: ['Don’t take his quiet for indifference', 'Mean what you say to him'],
    goals: ['Save the boardwalk stalls from the wrecking ball', 'Trust that someone will choose him on purpose'],
    relationshipPreferences: 'Reserved and all-or-nothing; the hardest to reach, the steadiest once he’s sure.',
    favoriteWeather: ['cloudy', 'foggy'],
    dislikedWeather: ['stormy'],
    datingStats: { charm: 68, empathy: 76, humor: 56, confidence: 70, intellect: 82, style: 78 },
    guardedness: 70, // reserved and slow to trust; quietly devoted once reached
    portraitAssetId: installPortrait('han_seo-jun.png', 'Han Seo-jun — tall lean architecture student in a long coat and rectangular glasses'),
    expressionAssets: {},
  });

  // --- Social web -----------------------------------------------------------
  updateCharacter(luca.id, { links: [{ targetId: mei.id, kind: 'friend' }, { targetId: clara.id, kind: 'friend' }] });
  updateCharacter(clara.id, { links: [{ targetId: seojun.id, kind: 'friend' }, { targetId: luca.id, kind: 'friend' }] });
  updateCharacter(mei.id, { links: [{ targetId: luca.id, kind: 'friend' }, { targetId: minhAn.id, kind: 'friend' }] });
  updateCharacter(sofia.id, { links: [{ targetId: minhAn.id, kind: 'friend' }, { targetId: seojun.id, kind: 'rival' }] });
  updateCharacter(minhAn.id, { links: [{ targetId: sofia.id, kind: 'friend' }, { targetId: mei.id, kind: 'friend' }] });
  updateCharacter(seojun.id, { links: [{ targetId: clara.id, kind: 'friend' }, { targetId: sofia.id, kind: 'rival' }] });

  // ==========================================================================
  // LUCA — the full arc: cohabiting sweethearts, reached the happy ending
  // ==========================================================================
  setRelationship(
    luca.id,
    { affection: 92, trust: 90, chemistry: 88, comfort: 94, respect: 88, curiosity: 64, tension: 8 },
    { status: 'cohabiting', lastSeenDay: 23, 'milestone:getting-close': 6, 'milestone:close': 12, 'milestone:sweethearts': 18, 'dtr:lastDay': 19 },
    at(23),
  );
  addChronicle(
    luca.id,
    'It began as a daily coffee and the kind of conversation that outlasts the cup. Luca had spent years remembering everyone else’s order and no one had thought to learn his; Rowan did, and kept showing up, and slowly the café became a place he was tended in instead of only tending. He worried aloud, once, that his life was passing behind the counter — and Rowan stayed past closing to argue otherwise. By the Star Festival they were inseparable; a month later Rowan’s gear lived in the flat above the café. He stopped putting himself last, and found out what that feels like.',
    [
      { day: 18, mode: 'date', line: 'Released a star-lantern together at the Festival; he held Rowan’s hand the whole climb up.' },
      { day: 19, mode: 'date', line: 'Asked Rowan to move into the flat over the café, then immediately offered to make food about it.' },
      { day: 22, mode: 'date', line: 'Closed up late; danced once around the empty café to the radio.' },
    ],
    9,
    at(22),
  );
  const evLucaFirst = addDateEval(luca.id, 2, 'warm', 'A coffee that turned into closing the café together.', at(2));
  const evLucaConfess = addDateEval(luca.id, 11, 'tender', 'He admitted the worry, and Rowan stayed.', at(11));
  const evLucaStar = addDateEval(luca.id, 18, 'glowing', 'Released a star-lantern at the Festival.', at(18));
  addDateEval(luca.id, 22, 'happy', 'Danced once around the empty café at closing.', at(22));
  const evLucaMoveIn = addEvent('dtr_accepted', { characterId: luca.id, day: 19, status: 'cohabiting' }, at(19));
  addMemory(luca.id, 'They learned my order before I learned theirs. Nobody had done that for me in this café. I think that was the moment, honestly.', 5, ['keepsake', 'first'], at(2), evLucaFirst);
  addMemory(luca.id, 'I said the thing I never say — that I was scared my life was happening to other people at my counter. They didn’t fix it. They just stayed past closing. That was the fix.', 5, ['keepsake', 'confession'], at(11), evLucaConfess);
  addMemory(luca.id, 'We sent a star up over the water at the Festival. I’ve watched that lantern launch for years from behind the counter. First time I was out there in it.', 5, ['keepsake', 'star-festival'], at(18), evLucaStar);
  addMemory(luca.id, 'Their cables are coiled by my aunt’s old espresso machine now. She’d have liked them. The flat finally feels lived in.', 4, ['keepsake', 'moving-in'], at(19), evLucaMoveIn);
  addDate(luca.id, boardwalk.id, 18, 'The Star Festival — a lantern over the water; he let himself be looked after.', [
    { role: 'character', text: 'Okay — close up early with me. The whole café can wait one night. Come up the boardwalk before the stalls fill.' },
    { role: 'player', text: 'I already folded us a lantern. Figured you’d be too busy feeding everyone to grab one.' },
    { role: 'character', text: '…You folded — of course you did. Of course you did.' },
    { role: 'character', text: 'Help me light it. And hold my hand on the stair, it’s steeper than it looks and I’m feeling things.' },
    { role: 'player', text: 'Feeling things is allowed tonight. It’s in the bylaws.' },
    { role: 'character', text: 'Where were you all the mornings I was just the guy behind the counter.' },
  ], at(18, 30 * MIN));
  addDate(luca.id, cafe.id, 22, 'Closing time; one slow dance around the empty café.', [
    { role: 'character', text: 'Chairs are up, machine’s off. Don’t leave yet. There’s a song on and the floor’s never this empty.' },
    { role: 'player', text: 'Are you asking me to dance in your aunt’s café, Luca?' },
    { role: 'character', text: '(takes your hand, a little shy for a man who runs the most social room in town)' },
    { role: 'player', text: 'She’d approve.' },
    { role: 'character', text: 'She’d be insufferable about it. So would I. Come here.' },
  ], at(22, 20 * MIN));
  addEvent('milestone_reached', { characterId: luca.id, day: 6, label: 'getting close' }, at(6, 5 * MIN));
  addEvent('dtr_accepted', { characterId: luca.id, day: 8, status: 'dating' }, at(8));
  addEvent('milestone_reached', { characterId: luca.id, day: 12, label: 'close' }, at(12));
  addEvent('dtr_accepted', { characterId: luca.id, day: 14, status: 'exclusive' }, at(14));
  addEvent('milestone_reached', { characterId: luca.id, day: 18, label: 'sweethearts' }, at(18, 5 * MIN));
  addEvent('ending_reached', { characterId: luca.id, day: 22, title: 'The Usual' }, at(22, 40 * MIN));
  endingsRepo.insert(CharacterEndingSchema.parse({
    characterId: luca.id,
    playerId: DEFAULT_PLAYER_ID,
    title: 'The Usual',
    epilogue:
      'The Driftwood Café opens at six like always, but now there are two cups on the counter before the lights even warm up. Rowan’s gear shares the back room with sacks of harbor-roast, and the flat upstairs smells of coffee and salt and someone else’s shampoo. Luca still knows everyone’s order — but he finally has one of his own, made for him, every morning, no charge. On Festival nights they close early and climb the boardwalk together. He stopped waiting to start his life. It turned out it had been steeping the whole time, just behind the counter, going quietly perfect.',
    day: 22,
    createdAt: at(22, 40 * MIN),
  }));
  addThread(luca.id, 1, [
    { sender: 'character', body: 'morning. your cup’s already pulled, the good beans, don’t tell the regulars ☕', day: 21, offsetMin: 380 },
    { sender: 'player', body: 'on my way down. save me the window seat', day: 21, offsetMin: 392 },
    { sender: 'character', body: 'the window seat is structurally yours now. it’s in the lease', day: 21, offsetMin: 395 },
    { sender: 'character', body: 'closed early tonight. radio’s on, floor’s empty, you know what that means 🤍', day: 23, offsetMin: 250 },
  ]);
  minigameResultsRepo.insert(MinigameResultSchema.parse({ id: newId('mg'), worldId: world.id, minigameId: 'sweet_and_sour', characterId: luca.id, score: 96, grade: 'S', reward: { dating: {}, relationship: { comfort: 6 }, money: 40 }, createdAt: at(17) }));
  minigameResultsRepo.insert(MinigameResultSchema.parse({ id: newId('mg'), worldId: world.id, minigameId: 'memory_match', characterId: luca.id, score: 84, grade: 'A', reward: { dating: {}, relationship: { affection: 3 }, money: 28 }, createdAt: at(10) }));

  // ==========================================================================
  // CLARA — exclusive & close: stable, exacting, vouched-for; a gift waiting
  // ==========================================================================
  setRelationship(
    clara.id,
    { affection: 74, trust: 78, chemistry: 66, comfort: 72, respect: 84, curiosity: 58, tension: 18 },
    { status: 'exclusive', lastSeenDay: 21, 'milestone:getting-close': 7, 'milestone:close': 15, 'dtr:lastDay': 17 },
    at(21),
  );
  addChronicle(
    clara.id,
    'Rowan came to the Conservatory to mic a recital and stayed to listen, properly, which almost no one does. Clara, who is impossible to flatter and quick to dismiss, found nothing to dismiss — only someone who took the work as seriously as she did and her seriously besides. The polish came off in increments: the secret caramels, the romance novel face-down on the music stand, the laugh she pretends she doesn’t have. They are exclusive now, which from Clara is an act of real discipline broken on purpose, and she has decided, precisely, that they are worth the disruption.',
    [
      { day: 15, mode: 'date', line: 'Played the difficult passage clean for the first time; let Rowan hear the draft of it.' },
      { day: 17, mode: 'date', line: 'Agreed to be exclusive between movements, very matter-of-fact, ears pink.' },
      { day: 21, mode: 'date', line: 'Shared the contraband caramels in the practice room; admitted to the novel.' },
    ],
    6,
    at(21),
  );
  const evClaraFirst = addDateEval(clara.id, 3, 'measured', 'They listened to the whole rehearsal without once checking their phone.', at(3));
  const evClaraClean = addDateEval(clara.id, 15, 'proud', 'The hard passage, finally clean — and witnessed.', at(15));
  const evClaraExclusive = addDateEval(clara.id, 17, 'certain', 'Said "only you" with a metronome still ticking.', at(17));
  addMemory(clara.id, 'They came to record the recital and then they actually listened. Do you know how rare that is. They heard the seam in the second movement that I have been hiding for a month.', 5, ['keepsake', 'first'], at(3), evClaraFirst);
  addMemory(clara.id, 'I played it clean and turned around and they were just… there, looking like it mattered. I did not perform it for them. I simply let them hear. That is not nothing, from me.', 4, ['keepsake'], at(15), evClaraClean);
  addMemory(clara.id, 'I said only you with the metronome still going, because I am a coward about silences. They understood. I do not say it twice; I do not need to.', 5, ['keepsake', 'commitment'], at(17), evClaraExclusive);
  addDate(clara.id, conservatory.id, 17, 'Agreed to be exclusive; the metronome still ticking.', [
    { role: 'character', text: 'Sit. Do not touch the bow. I want to say something and I would like to only say it once.' },
    { role: 'player', text: 'I’m listening. I’m good at that, apparently.' },
    { role: 'character', text: '(she sets the violin down with the same care she gives a held note)' },
    { role: 'character', text: 'I am not easily impressed and you have not tried to impress me, which is the only thing that ever works. I would like there to be only you. I have thought about it precisely.' },
    { role: 'player', text: 'Only you, Clara. I’ve thought about it imprecisely and constantly.' },
    { role: 'character', text: 'Good. …Stop smiling like that, the acoustics carry and people will talk.' },
  ], at(17, 45 * MIN));
  addEvent('milestone_reached', { characterId: clara.id, day: 7, label: 'getting close' }, at(7, 5 * MIN));
  addEvent('dtr_accepted', { characterId: clara.id, day: 9, status: 'dating' }, at(9));
  addEvent('milestone_reached', { characterId: clara.id, day: 15, label: 'close' }, at(15, 5 * MIN));
  addEvent('dtr_accepted', { characterId: clara.id, day: 17, status: 'exclusive' }, at(17));
  addThread(clara.id, 0, [
    { sender: 'character', body: 'Practice room 4 is free until nine. The acoustics are tolerable and the company would be also.', day: 20, offsetMin: 880 },
    { sender: 'player', body: 'Is that the famous Voss warmth I keep hearing about?', day: 20, offsetMin: 905 },
    { sender: 'character', body: 'It is the only warmth on offer. Take it or rehearse alone.', day: 20, offsetMin: 910 },
    { sender: 'character', body: 'I bought the caramels from the boardwalk stall. The cheap ones. They are for you and I will deny this in person. Simply take them.', day: 21, offsetMin: 540, attachment: { shopItemId: caramels.id, name: caramels.name, claimed: false } },
  ]);
  minigameResultsRepo.insert(MinigameResultSchema.parse({ id: newId('mg'), worldId: world.id, minigameId: 'rhythm_serenade', characterId: clara.id, score: 93, grade: 'S', reward: { dating: {}, relationship: { respect: 5 }, money: 36 }, createdAt: at(13) }));
  minigameResultsRepo.insert(MinigameResultSchema.parse({ id: newId('mg'), worldId: world.id, minigameId: 'lore_quiz', characterId: clara.id, score: 86, grade: 'A', reward: { dating: {}, relationship: { respect: 3 }, money: 28 }, createdAt: at(16) }));

  // ==========================================================================
  // MEI — dating & getting close: blossoming, bright, recent playful texts
  // ==========================================================================
  setRelationship(
    mei.id,
    { affection: 58, trust: 54, chemistry: 56, comfort: 52, respect: 50, curiosity: 76, tension: 16 },
    { status: 'dating', lastSeenDay: 22, 'milestone:getting-close': 16, 'dtr:lastDay': 18 },
    at(22),
  );
  addChronicle(
    mei.id,
    'Rowan met Mei on a class tour of the aquarium and asked the kind of question her professors never do — not about her grades, about the rays. She lit up, then caught herself, the way she always does before the brightness can be measured and found wanting. But Rowan kept asking after the person, not the prodigy, and slowly she let the bright front slip to show the tired, hopeful student under it. A tide-pool afternoon, a nervous "so are we dating, or—", a yes she gave to her own shoes. It is early and sweet and, for once, the pressure is somewhere far behind her.',
    [
      { day: 16, mode: 'date', line: 'After-hours feeding the rays; she admitted she’s scared of disappointing her family.' },
      { day: 18, mode: 'date', line: 'Said yes to dating, talking to her sneakers the whole time.' },
      { day: 22, mode: 'date', line: 'Tide pools at low tide; named every creature, then named the quiet between them too.' },
    ],
    4,
    at(22),
  );
  const evMeiFirst = addDateEval(mei.id, 8, 'bright', 'She talked about the rays for an hour and no one stopped her.', at(8));
  const evMeiGift = addDateEval(mei.id, 16, 'open', 'A vial of sea glass, and the first honest worry under the bright front.', at(16));
  addDateEval(mei.id, 22, 'happy', 'Tide pools and the comfortable quiet of being liked as she is.', at(22));
  const evMeiDating = addEvent('dtr_accepted', { characterId: mei.id, day: 18, status: 'dating' }, at(18));
  addMemory(mei.id, 'They asked about the rays. Not my GPA, not my thesis timeline. The rays. I talked for an hour and they just kept asking. I didn’t know I was allowed to be interesting instead of impressive.', 5, ['keepsake', 'first'], at(8), evMeiFirst);
  addMemory(mei.id, 'They gave me sea glass and I told them the thing I don’t tell anyone — that I’m terrified of being the sibling who let everyone down. They didn’t flinch. They held the worry like it was glass too.', 4, ['keepsake'], at(16), evMeiGift);
  addMemory(mei.id, 'I said yes to my own sneakers, which is so embarrassing, but they laughed in the kind way and said yes back. We’re a we now. A small bright we.', 4, ['keepsake', 'commitment'], at(18), evMeiDating);
  addDate(mei.id, aquarium.id, 16, 'After-hours at the tanks; the bright front slips.', [
    { role: 'character', text: 'Okay so THIS one — this is Pancake, technically she’s a thornback ray but look at her little face, she comes right up when it’s quiet—' },
    { role: 'player', text: 'You light up completely when you talk about them. I could listen to this all night.' },
    { role: 'character', text: 'Oh. Most people, um. Most people want to hear about my marks. My family definitely only wants to hear about my marks.' },
    { role: 'player', text: 'I want to hear about Pancake. And about you. The tired version too, if she ever wants to come out.' },
    { role: 'character', text: '(goes quiet, feeds the ray, says very softly) …she’s a little tired. Thanks for asking after her.' },
  ], at(16, 30 * MIN));
  addEvent('milestone_reached', { characterId: mei.id, day: 16, label: 'getting close' }, at(16, 5 * MIN));
  addThread(mei.id, 0, [
    { sender: 'character', body: 'PANCAKE ATE FROM MY HAND TODAY i nearly cried at work 🐟🥹', day: 22, offsetMin: 480 },
    { sender: 'player', body: 'a historic day. i’m so proud of you both', day: 22, offsetMin: 495 },
    { sender: 'character', body: 'don’t be nice about it i WILL cry again and i’m on the bus', day: 22, offsetMin: 500 },
    { sender: 'player', body: 'cry on the bus. own it. tide pools after your shift?', day: 22, offsetMin: 506 },
    { sender: 'character', body: 'yes!! low tide’s at five, i’ll bring the good bucket 🪣💛', day: 22, offsetMin: 512 },
  ]);
  minigameResultsRepo.insert(MinigameResultSchema.parse({ id: newId('mg'), worldId: world.id, minigameId: 'memory_match', characterId: mei.id, score: 79, grade: 'B', reward: { dating: {}, relationship: { curiosity: 3 }, money: 20 }, createdAt: at(19) }));

  // ==========================================================================
  // SOFÍA — close, edging toward more: flirty armor slipping into something real
  // ==========================================================================
  setRelationship(
    sofia.id,
    { affection: 62, trust: 56, chemistry: 74, comfort: 54, respect: 56, curiosity: 70, tension: 24 },
    { status: 'dating', lastSeenDay: 21, 'milestone:getting-close': 9, 'milestone:close': 17, 'dtr:lastDay': 12 },
    at(21),
  );
  addChronicle(
    sofia.id,
    'Sofía photographed Rowan before she ever spoke to them — caught them coiling cable on the boardwalk in the gold hour and decided that was a good enough introduction. The flirting came easy; it always does, it’s the wall she builds fastest. What unsettled her was that Rowan kept staying after the joke landed, holding the eye contact one beat past comfortable, refusing to let her turn the real thing back into a bit. On the lighthouse gallery, mid-deflection, she let one true sentence out — and then immediately took a photo to have something to do with her hands. It’s the closest she’s come to not running.',
    [
      { day: 12, mode: 'date', line: 'Made it "official" with a joke, then looked terrified she meant it.' },
      { day: 15, mode: 'date', line: 'Shot the boardwalk stalls before the cranes; got quiet about things ending.' },
      { day: 17, mode: 'date', line: 'On the lighthouse gallery she said one sincere thing, then hid behind the camera.' },
    ],
    5,
    at(21),
  );
  const evSofiaFirst = addDateEval(sofia.id, 6, 'playful', 'She photographed Rowan first and explained later.', at(6));
  const evSofiaStalls = addDateEval(sofia.id, 15, 'wistful', 'The doomed boardwalk stalls, and a rare unguarded sadness.', at(15));
  const evSofiaLight = addDateEval(sofia.id, 17, 'caught', 'One true sentence on the lighthouse gallery — then the camera came up.', at(17));
  const evSofiaDating = addEvent('dtr_accepted', { characterId: sofia.id, day: 12, status: 'dating' }, at(12));
  addMemory(sofia.id, 'I shot them before I talked to them. Gold hour, cable over one shoulder, not posing for anybody. I told myself it was for the series. It was not entirely for the series.', 5, ['keepsake', 'first'], at(6), evSofiaFirst);
  addMemory(sofia.id, 'I made us "official" as a joke because that way if they laughed it was just a bit. They didn’t laugh. They said "okay" like they meant it and I have been low-key panicking in a happy way ever since.', 4, ['keepsake', 'commitment'], at(12), evSofiaDating);
  addMemory(sofia.id, 'On the lighthouse I said the real thing — that I don’t usually let people stay this long — and then I took their picture so I’d have somewhere to put my face. They let me. They’re very patient with my whole… deal.', 5, ['keepsake', 'vulnerable'], at(17), evSofiaLight);
  addDate(sofia.id, lighthouse.id, 17, 'Lighthouse gallery; the armor slips for one sentence.', [
    { role: 'character', text: 'Hold still — no, don’t pose, that’s the whole point, you ruin it when you pose. There. The light’s doing something stupid and perfect behind you.' },
    { role: 'player', text: 'You always put the camera between us right when it gets real. I notice, you know.' },
    { role: 'character', text: '…Wow. Okay. Going straight for it. (lowers the camera, slowly)' },
    { role: 'character', text: 'I don’t let people stick around this long. It’s a thing. I run. You’re supposed to have been run from by now.' },
    { role: 'player', text: 'I’m not going anywhere, Sofía. Take the picture if you need to. I’ll still be here after.' },
    { role: 'character', text: '(takes the picture. then doesn’t lift the camera again.) …Damn it. Okay.' },
  ], at(17, 30 * MIN));
  addEvent('milestone_reached', { characterId: sofia.id, day: 9, label: 'getting close' }, at(9, 5 * MIN));
  addEvent('milestone_reached', { characterId: sofia.id, day: 17, label: 'close' }, at(17, 5 * MIN));
  addThread(sofia.id, 1, [
    { sender: 'character', body: 'developed the lighthouse roll. one of them is unreasonably good and it’s your stupid face', day: 20, offsetMin: 660 },
    { sender: 'player', body: 'send it??', day: 20, offsetMin: 672 },
    { sender: 'character', body: 'no. you have to earn the print. golden hour tomorrow, boardwalk, before they tear the blue stall down', day: 20, offsetMin: 675 },
    { sender: 'character', body: 'wear the thing i like. you know the thing. don’t make me say nice stuff twice in one week', day: 21, offsetMin: 410 },
  ]);
  minigameResultsRepo.insert(MinigameResultSchema.parse({ id: newId('mg'), worldId: world.id, minigameId: 'two_truths_a_lie', characterId: sofia.id, score: 90, grade: 'A', reward: { dating: {}, relationship: { chemistry: 4 }, money: 30 }, createdAt: at(14) }));

  // ==========================================================================
  // MINH AN — getting close: guarded, deadpan, trust shown by the unfinished work
  // ==========================================================================
  setRelationship(
    minhAn.id,
    { affection: 48, trust: 44, chemistry: 46, comfort: 42, respect: 52, curiosity: 66, tension: 20 },
    { status: 'dating', lastSeenDay: 20, 'milestone:getting-close': 14, 'dtr:lastDay': 16 },
    at(20),
  );
  addChronicle(
    minhAn.id,
    'Minh An colonized the corner cabinet at the Starling Arcade and Rowan made the mistake — or the very good decision — of not trying to fill the silence next to her. Weeks of companionable quiet later, she said the deadpan thing that turned out to be a test, and Rowan passed it by not laughing at the wrong moment. The real milestone wasn’t a confession; it was the night she turned her laptop around and let Rowan play thirty broken seconds of her unfinished puzzle game. She is guarded the way you’re guarded about the thing you actually care about. The door is open now, by exactly the degree she chose.',
    [
      { day: 10, mode: 'date', line: 'Sat in shared silence at the arcade; she decided silence next to Rowan was acceptable.' },
      { day: 14, mode: 'date', line: 'Turned the laptop around — let Rowan play the unfinished build. Watched their face the whole time.' },
      { day: 16, mode: 'date', line: 'Made it "dating," deadpan, then immediately put her headphones back on, ears red.' },
    ],
    3,
    at(20),
  );
  const evMinhFirst = addDateEval(minhAn.id, 10, 'neutral', 'The good kind of silence at the corner cabinet.', at(10));
  const evMinhBuild = addDateEval(minhAn.id, 14, 'trusting', 'She let Rowan play the unfinished game.', at(14));
  const evMinhDating = addEvent('dtr_accepted', { characterId: minhAn.id, day: 16, status: 'dating' }, at(16));
  addMemory(minhAn.id, 'They sat next to me for two hours and didn’t once ask what I was working on. Do you understand how rare that is. I almost said thank you. I didn’t. But I almost did.', 5, ['keepsake', 'first'], at(10), evMinhFirst);
  addMemory(minhAn.id, 'I turned the laptop around. Thirty seconds, the broken build, the placeholder art, the bug where the cat clips through the wall. They played it like it was finished. They found the one mechanic that works and said so. I have never shown anyone the mess before.', 5, ['keepsake', 'trust'], at(14), evMinhBuild);
  addMemory(minhAn.id, 'I said "I guess we’re dating then" in my flattest voice so I could pretend it was a joke if it landed wrong. It did not land wrong. I put my headphones on so they couldn’t see my face do the thing.', 4, ['keepsake', 'commitment'], at(16), evMinhDating);
  addDate(minhAn.id, arcade.id, 14, 'The laptop turns around; thirty seconds of the real thing.', [
    { role: 'character', text: 'Don’t make it weird. It’s thirty seconds. It’s broken. The cat clips through the wall and I haven’t fixed the timing on the second puzzle. Just — here.' },
    { role: 'player', text: '(plays it carefully, like it matters, because it does) …oh. Oh, the box-rotation thing. That’s yours. That feels like nothing else.' },
    { role: 'character', text: '(very still) …You found the one part that works. Most people poke at the cat bug.' },
    { role: 'player', text: 'The cat bug is charming. The rotation is the game. Minh An, this is really good.' },
    { role: 'character', text: '(closes the laptop, quietly, doesn’t take it back) …Okay. You can see the next build too. When it’s less broken. Maybe when it’s a little broken. We’ll see.' },
  ], at(14, 40 * MIN));
  addEvent('milestone_reached', { characterId: minhAn.id, day: 14, label: 'getting close' }, at(14, 5 * MIN));
  // The image-texting feature, on show: the player snaps a dumb photo and sends it;
  // Minh An "sees" it (a real uploaded asset on the player's text) and riffs on it.
  const bananaPhoto = installPhoto('naked_banana.png', 'A peeled banana posed like a tiny person — a deeply stupid, very funny photo.');
  addThread(minhAn.id, 1, [
    { sender: 'character', body: 'fixed the cat bug. now it clips through the FLOOR instead. arguably worse. arguably funnier', day: 19, offsetMin: 1360 },
    { sender: 'player', body: 'ship it. floor cat is a feature', day: 19, offsetMin: 1375 },
    { sender: 'character', body: 'this is why i don’t show people my work', day: 19, offsetMin: 1378 },
    { sender: 'character', body: 'corner cabinet tomorrow. i’m not saving you a stool. (i’m saving you a stool)', day: 20, offsetMin: 300 },
    { sender: 'player', body: 'found this little guy at the harbor market. thought of you immediately. unclear why', day: 23, offsetMin: 1180, imageAssetId: bananaPhoto },
    { sender: 'character', body: '…', day: 23, offsetMin: 1186 },
    { sender: 'character', body: 'why is he NAKED. why does he have the posture of a man who owes me money', day: 23, offsetMin: 1187 },
    { sender: 'player', body: 'he’s simply confident', day: 23, offsetMin: 1189 },
    { sender: 'character', body: 'i hate that i laughed out loud in the silent floor of the library. a real, audible noise. people turned. this is your fault', day: 23, offsetMin: 1191 },
    { sender: 'character', body: 'ok he’s going in the game. unlockable. you have to find all the floor cats first. i’m naming him after you', day: 23, offsetMin: 1194 },
  ]);
  minigameResultsRepo.insert(MinigameResultSchema.parse({ id: newId('mg'), worldId: world.id, minigameId: 'lore_quiz', characterId: minhAn.id, score: 82, grade: 'A', reward: { dating: {}, relationship: { curiosity: 3 }, money: 26 }, createdAt: at(15) }));

  // ==========================================================================
  // HAN SEO-JUN — exclusive but ON THE ROCKS: a strained, complicated thread
  // ==========================================================================
  setRelationship(
    seojun.id,
    { affection: 36, trust: 32, chemistry: 40, comfort: 30, respect: 44, curiosity: 46, tension: 60 },
    {
      status: 'exclusive', lastSeenDay: 20,
      'milestone:getting-close': 5, 'milestone:close': 11,
      'dtr:lastDay': 13,
      'state:onTheRocks': true, 'rocks:since': 20,
      'state:jealous': true,
      'jealousy:lastRollDay': 19,
      'walkout:lastDay': 19,
    },
    at(20),
  );
  addChronicle(
    seojun.id,
    'It took weeks of climbing the lighthouse stair beside Seo-jun — him measuring sightlines, saying almost nothing — before Rowan understood that the silence was attention, not distance. He remembered everything: the coffee order, the offhand worry, the date Rowan mentioned once. Slowly that careful noticing became its own kind of confession, and he let himself be chosen. Then the bay did what the bay does: word reached him that Rowan had been seen, close, with Sofía — and Sofía is exactly the kind of careless flame he distrusts. He didn’t shout. He simply stopped, set down the thing he was carrying, and went quiet in the way that costs the most. It isn’t over. He is waiting, very still, to see whether Rowan meant it.',
    [
      { day: 11, mode: 'date', line: 'Showed Rowan the old joinery he’s saving; the closest he comes to opening a door.' },
      { day: 13, mode: 'date', line: 'Agreed to be exclusive — understated, but he said yes and meant it doubly.' },
      { day: 19, mode: 'date', line: 'Heard about Sofía. Set down his tools and left without raising his voice.' },
    ],
    7,
    at(20),
  );
  const evSeojunFirst = addDateEval(seojun.id, 11, 'open', 'He showed the work he protects — and the person under the quiet.', at(11));
  const evSeojunExclusive = addEvent('dtr_accepted', { characterId: seojun.id, day: 13, status: 'exclusive' }, at(13));
  const evSeojunWalkout = addEvent('walkout', { characterId: seojun.id, day: 19, reason: 'Heard you had been close with Sofía, his rival.' }, at(19, 40 * MIN));
  addMemory(seojun.id, 'I took them up to see the boardwalk stall joinery, the joints my grandfather’s generation cut by hand. I do not show people that. They didn’t photograph it or rush me. They just put their hand on the old wood the way I do. I decided, then.', 5, ['keepsake', 'first'], at(11), evSeojunFirst);
  addMemory(seojun.id, 'I said yes to exclusive. I do not give my word lightly and I do not take it back. They should understand that the saying of it was the whole of it.', 4, ['keepsake', 'commitment'], at(13), evSeojunExclusive);
  addMemory(seojun.id, 'I heard they had been close with Sofía. Of course it was Sofía — careless light, the kind that doesn’t mean to burn anything. I set down the chisel so I would not damage the work, and I left. I did not raise my voice. I should not have had to.', 5, ['scar', 'jealousy'], at(19), evSeojunWalkout);
  addDate(seojun.id, lighthouse.id, 11, 'The old joinery; a quiet door opens.', [
    { role: 'character', text: 'Mind the third step, it’s original. Two hundred years and it still holds. People keep wanting to replace it. They don’t see what they’d be throwing away.' },
    { role: 'player', text: '(rests a hand on the old rail, the way he does) It’s beautiful. You can feel the hand that made it.' },
    { role: 'character', text: '(a long pause, then, quietly) …Most people climb straight past it to the view. You stopped.' },
    { role: 'player', text: 'The view’s not going anywhere. This might be. Seemed worth stopping for.' },
    { role: 'character', text: 'Yes. …It is. Thank you for seeing it. I notice that you noticed. I notice most things.' },
  ], at(11, 50 * MIN));
  addDate(seojun.id, lighthouse.id, 19, 'He heard about Sofía and went quiet.', [
    { role: 'character', text: 'You were on the boardwalk Friday. With Sofía. Close.' },
    { role: 'player', text: 'Seo-jun — it wasn’t what it —' },
    { role: 'character', text: 'I asked for one thing. That you mean what you say to me. That was the only thing.' },
    { role: 'character', text: '(he sets the chisel down on the cloth, square to the edge, which is worse than if he’d dropped it)' },
    { role: 'character', text: 'I’m going to finish this another day. Don’t walk down with me tonight.' },
  ], at(19, 40 * MIN));
  addDateEval(seojun.id, 5, 'reserved', 'A first thaw on the lighthouse stair.', at(5));
  addEvent('milestone_reached', { characterId: seojun.id, day: 5, label: 'getting close' }, at(5, 5 * MIN));
  addEvent('dtr_accepted', { characterId: seojun.id, day: 7, status: 'dating' }, at(7));
  addEvent('milestone_reached', { characterId: seojun.id, day: 11, label: 'close' }, at(11, 5 * MIN));
  addEvent('jealousy_triggered', { characterId: seojun.id, day: 19, rival: 'Sofía Reyes', relation: 'rival' }, at(19, 30 * MIN));
  addEvent('relationship_on_the_rocks', { characterId: seojun.id, day: 20 }, at(20));
  addThread(seojun.id, 2, [
    { sender: 'character', body: 'The lighthouse stair is quiet tonight. I almost asked you to come measure the rail with me. Then I remembered Friday.', day: 20, offsetMin: 1300 },
    { sender: 'player', body: 'I should have told you myself. Can I explain? In person, not like this.', day: 20, offsetMin: 1340 },
    { sender: 'character', body: 'Perhaps. Not tonight. I keep my temper by keeping my distance and I would like to keep both for now.', day: 21, offsetMin: 200 },
    { sender: 'character', body: 'If you come Thursday, come because you have decided. Not because you want the quiet to end.', day: 21, offsetMin: 205 },
  ]);
  minigameResultsRepo.insert(MinigameResultSchema.parse({ id: newId('mg'), worldId: world.id, minigameId: 'lore_quiz', characterId: seojun.id, score: 88, grade: 'A', reward: { dating: {}, relationship: { respect: 4 }, money: 30 }, createdAt: at(12) }));

  // ==========================================================================
  // A LIVED-IN WORLD: extra shop, property, market, casino, recaps, social feed
  // (everything below is flavor that makes the demo screenshots feel inhabited)
  // ==========================================================================

  // --- A fuller shop --------------------------------------------------------
  const recitalTicket = createShopItem({ name: 'Conservatory Recital Ticket', description: 'A seat for the spring concerto night. Clara would notice if you came.', price: 45, category: 'special', rarity: 'uncommon', effects: [{ kind: 'relationship', stat: 'respect', delta: 4 }], infiniteStock: false, stock: 8, assetId: null });
  const camera = createShopItem({ name: 'Vintage Rangefinder Camera', description: 'A heavy old rangefinder from the harbor pawn shop. For someone who shoots the bay.', price: 220, category: 'special', rarity: 'legendary', effects: [{ kind: 'relationship', stat: 'chemistry', delta: 6 }, { kind: 'relationship', stat: 'curiosity', delta: 3 }], infiniteStock: false, stock: 1, assetId: null });
  const novel = createShopItem({ name: 'Dog-Eared Romance Paperback', description: 'A lurid, much-loved seaside romance. A certain violinist would die before admitting she wants it.', price: 12, category: 'book', rarity: 'common', effects: [{ kind: 'relationship', stat: 'comfort', delta: 3 }], infiniteStock: true, stock: 0, assetId: null });
  const punchCard = createShopItem({ name: 'Bubble-Tea Punch Card', description: 'Nine stamps to a free taro milk tea. Mei has Opinions about the toppings.', price: 18, category: 'consumable', rarity: 'common', effects: [{ kind: 'relationship', stat: 'affection', delta: 2 }, { kind: 'relationship', stat: 'comfort', delta: 2 }], infiniteStock: true, stock: 0, assetId: null });
  const print = createShopItem({ name: 'Lighthouse Linocut Print', description: 'A hand-pulled print of Asterfall Light at dusk, sold at the boardwalk market.', price: 35, category: 'gift', rarity: 'uncommon', effects: [{ kind: 'relationship', stat: 'affection', delta: 3 }, { kind: 'relationship', stat: 'respect', delta: 1 }], infiniteStock: true, stock: 0, assetId: null });

  // The player has picked up a few more things along the way.
  for (const [item, qty, day] of [[recitalTicket, 1, 17], [punchCard, 1, 21], [print, 1, 12]] as const) {
    inventoryRepo.insert(InventoryItemSchema.parse({ id: newId('inv'), playerId, shopItemId: item.id, quantity: qty, acquiredAt: at(day) }));
  }

  // --- Property: a leased studio, an owned flat (date venue), some listings ---
  const studio = createProperty({ worldId: world.id, name: 'Quayside Studio', description: 'A cramped, cheerful studio over a chandlery, with just enough room for a mixing desk and a kettle.', category: 'residence', buyPrice: 6200, rentAmount: 95, rentCadence: 'weekly', indoor: true, tags: ['cozy', 'harbor', 'starter'], buffStat: 'comfort', buffAmount: 2, assetId: null });
  const flat = createProperty({ worldId: world.id, name: 'Lighthouse-View Flat', description: 'A warm one-bed on the point with a window that frames Asterfall Light. Quiet, and entirely yours.', category: 'residence', buyPrice: 14800, rentAmount: 0, rentCadence: 'monthly', indoor: true, tags: ['romantic', 'view', 'quiet'], buffStat: 'affection', buffAmount: 3, assetId: null });
  createProperty({ worldId: world.id, name: 'The Signal-Keeper’s Cottage', description: 'The old keeper’s cottage at the foot of the lighthouse — stone-walled, salt-bitten, full of weather.', category: 'retreat', buyPrice: 21000, rentAmount: 180, rentCadence: 'weekly', indoor: true, tags: ['romantic', 'historic', 'remote'], buffStat: 'chemistry', buffAmount: 4, assetId: null });
  createProperty({ worldId: world.id, name: 'Boardwalk Loft', description: 'A bright loft above the shuttered arcade stalls, all brick and big windows and festival noise.', category: 'social', buyPrice: 17500, rentAmount: 140, rentCadence: 'weekly', indoor: true, tags: ['lively', 'central', 'festival'], buffStat: 'curiosity', buffAmount: 3, assetId: null });
  createProperty({ worldId: world.id, name: 'Tidewatch Plot', description: 'An empty headland lot the council keeps threatening to sell. Nothing here but gorse and a view.', category: 'land', buyPrice: 9000, rentAmount: 0, rentCadence: 'monthly', indoor: false, tags: ['land', 'view', 'investment'], buffStat: null, buffAmount: 0, assetId: null });

  propertyOwnershipRepo.insert(PropertyOwnershipSchema.parse({ id: newId('powns'), worldId: world.id, playerId, propertyId: flat.id, purchasePrice: flat.buyPrice, acquiredAt: at(15) }));
  propertyLeasesRepo.upsert(PropertyLeaseSchema.parse({ id: newId('lease'), worldId: world.id, playerId, propertyId: studio.id, nextDueDay: CURRENT_DAY + 2, status: 'active', graceUntilDay: null, startedAt: at(6) }));

  // --- Stock market: companies that react to the bay; a small portfolio -------
  const seedPrices = (companyId: string, series: ReadonlyArray<readonly [number, number]>): void => {
    for (const [day, price] of series) {
      stockPricesRepo.upsert(StockPriceSchema.parse({ worldId: world.id, companyId, day, price, createdAt: at(day) }));
    }
  };
  const hrbl = createCompany({ worldId: world.id, name: 'Harborlight Marine Labs', ticker: 'HRBL', description: 'Coastal research and the aquarium’s quiet benefactor. Lives and dies on grant season.', sector: 'health', basePrice: 145, volatility: 0.07, dividendPerShare: 2, linkedCharacterId: mei.id, assetId: null });
  const drft = createCompany({ worldId: world.id, name: 'Driftwood Roasters', ticker: 'DRFT', description: 'The little harbor roastery that supplies half the cafés on the bay, including one you know.', sector: 'consumer', basePrice: 64, volatility: 0.05, dividendPerShare: 1, linkedCharacterId: luca.id, assetId: null });
  const aslp = createCompany({ worldId: world.id, name: 'Asterfall Light & Power', ticker: 'ASLP', description: 'The utility that keeps the lighthouse dark and the arcade humming. Steady, until it isn’t.', sector: 'energy', basePrice: 90, volatility: 0.04, dividendPerShare: 2, linkedCharacterId: null, assetId: null });
  const arcd = createCompany({ worldId: world.id, name: 'Starling Arcade Co.', ticker: 'ARCD', description: 'The restored train arcade’s parent company, betting big on nostalgia and pinball leagues.', sector: 'media', basePrice: 50, volatility: 0.09, dividendPerShare: 0, linkedCharacterId: minhAn.id, assetId: null });
  const ryfo = createCompany({ worldId: world.id, name: 'Reyes Film & Optics', ticker: 'RYFO', description: 'A boutique film stock revived by a cult of photographers documenting the disappearing coast.', sector: 'consumer', basePrice: 120, volatility: 0.08, dividendPerShare: 0, linkedCharacterId: sofia.id, assetId: null });

  seedPrices(hrbl.id, [[20, 150], [21, 153], [22, 149], [23, 158], [CURRENT_DAY, 164]]);
  seedPrices(drft.id, [[20, 66], [21, 65], [22, 67], [23, 70], [CURRENT_DAY, 69]]);
  seedPrices(aslp.id, [[20, 90], [21, 89], [22, 88], [23, 86], [CURRENT_DAY, 84]]);
  seedPrices(arcd.id, [[20, 48], [21, 50], [22, 53], [23, 52], [CURRENT_DAY, 57]]);
  seedPrices(ryfo.id, [[20, 124], [21, 122], [22, 119], [23, 121], [CURRENT_DAY, 118]]);

  // Holdings: two winners, one underwater — so the portfolio shows real P/L.
  stockHoldingsRepo.upsert(StockHoldingSchema.parse({ id: newId('hold'), worldId: world.id, playerId, companyId: hrbl.id, shares: 40, costBasis: 40 * 145, acquiredDay: 12, updatedAt: NOW }));
  stockHoldingsRepo.upsert(StockHoldingSchema.parse({ id: newId('hold'), worldId: world.id, playerId, companyId: drft.id, shares: 60, costBasis: 60 * 62, acquiredDay: 9, updatedAt: NOW }));
  stockHoldingsRepo.upsert(StockHoldingSchema.parse({ id: newId('hold'), worldId: world.id, playerId, companyId: aslp.id, shares: 30, costBasis: 30 * 92, acquiredDay: 14, updatedAt: NOW }));

  const news = (day: number, companyId: string, ticker: string, headline: string, body: string, sentiment: 'up' | 'down' | 'flat'): void => {
    marketNewsRepo.insert(MarketNewsSchema.parse({ id: newId('news'), worldId: world.id, day, companyId, ticker, headline, body, sentiment, createdAt: at(day, 400 * MIN) }));
  };
  news(CURRENT_DAY, hrbl.id, 'HRBL', 'Marine Labs lands renewed coastal grant', 'A multi-year research grant sends Harborlight up sharply; the aquarium’s night-feed program is safe for another season.', 'up');
  news(CURRENT_DAY, aslp.id, 'ASLP', 'Power utility flags lighthouse-point maintenance costs', 'Asterfall Light & Power warns of one-off spending on the headland lines, and the market marks it down.', 'down');
  news(CURRENT_DAY, arcd.id, 'ARCD', 'Arcade pinball league sells out opening night', 'Starling Arcade Co. rallies on a packed relaunch; the restored station hall is suddenly the place to be.', 'up');
  news(23, drft.id, 'DRFT', 'Driftwood Roasters expands harbor delivery', 'The roastery’s new boardwalk round nudges shares up on quiet but steady volume.', 'up');
  news(23, ryfo.id, 'RYFO', 'Reyes Film cuts run of its cult expired stock', 'A scarcity scare turns to a sell-off as photographers worry the famous gold-grain emulsion is ending.', 'down');

  // --- Casino: a small, believable gambling history --------------------------
  const round = (game: 'slots' | 'blackjack' | 'roulette' | 'videoPoker', bet: number, payout: number, outcome: string, day: number, state: Record<string, unknown>): void => {
    gamblingRoundsRepo.upsert(GamblingRoundSchema.parse({ id: newId('round'), worldId: world.id, playerId, game, status: 'settled', bet, payout, outcome, state, day, createdAt: at(day, 700 * MIN), updatedAt: at(day, 700 * MIN) }));
  };
  round('slots', 20, 0, 'No match — bar / cherry / seven.', 7, { reels: ['bar', 'cherry', 'seven'] });
  round('blackjack', 50, 100, 'Player 20 beats dealer 18.', 10, { player: [10, 10], dealer: [10, 8], result: 'win' });
  round('roulette', 30, 0, 'Landed 4 black; bet red.', 13, { number: 4, color: 'black', bet: 'red' });
  round('videoPoker', 25, 75, 'Three of a kind, jacks.', 15, { hand: ['JH', 'JS', 'JC', '4D', '9S'], rank: 'three_of_a_kind' });
  round('slots', 40, 200, 'Jackpot line — seven / seven / seven.', 18, { reels: ['seven', 'seven', 'seven'] });
  round('blackjack', 60, 0, 'Bust at 23.', 20, { player: [10, 6, 7], dealer: [10, 7], result: 'bust' });
  round('roulette', 20, 70, 'Straight-up on 17 paid 35:1 short — corner hit.', 22, { number: 17, color: 'black', bet: 'corner' });

  // --- Day records (power the Calendar app's recaps) -------------------------
  const dayRecord = (
    day: number,
    headline: string,
    narrative: string,
    highlights: string[],
    beats: ReadonlyArray<{ icon: string; text: string; tone: 'good' | 'bad' | 'neutral' }>,
    income: number,
  ): void => {
    dayRecordsRepo.upsert(DayRecordSchema.parse({ worldId: world.id, day, headline, narrative, highlights, beats: [...beats], income, reconstructed: false, createdAt: at(day, 900 * MIN), updatedAt: at(day, 900 * MIN) }));
  };
  dayRecord(16, 'Tide pools and a quiet confession', 'A clear morning at the aquarium; Mei’s bright front slipped just enough to let the real worry show. The bay felt briefly enormous and gentle.', ['Fed the rays after hours with Mei', 'A vial of sea glass changed hands'], [
    { icon: '🐟', text: 'Mei showed you the thornback rays', tone: 'good' },
    { icon: '💙', text: 'Affection grew with Mei', tone: 'good' },
    { icon: '💸', text: 'Dividends paid out from DRFT', tone: 'neutral' },
  ], 60);
  dayRecord(17, 'Only you, over the metronome', 'Rain on the conservatory glass and a small, exact vow. Clara does not say things twice; she didn’t need to.', ['Clara agreed to be exclusive', 'Bought a recital ticket for the spring'], [
    { icon: '🎻', text: 'Clara: now exclusive', tone: 'good' },
    { icon: '🤝', text: 'Respect grew with Clara', tone: 'good' },
  ], 60);
  dayRecord(18, 'The Star Festival', 'The season’s first fog came in and the whole bay climbed the boardwalk. A lantern went up over the water, and Luca finally let himself be looked after.', ['Released a star-lantern with Luca', 'Sweethearts milestone reached'], [
    { icon: '🏮', text: 'Star-lantern set adrift with Luca', tone: 'good' },
    { icon: '💞', text: 'Reached “sweethearts” with Luca', tone: 'good' },
    { icon: '🎚️', text: 'Ran sound for the festival stages', tone: 'neutral' },
  ], 120);
  dayRecord(19, 'A door half-closed', 'Word travels the boardwalk faster than the tide. Seo-jun heard about Sofía and went quiet in the way that costs the most. Luca, meanwhile, asked you to move in.', ['Luca asked you to move in', 'Seo-jun walked out without raising his voice'], [
    { icon: '📦', text: 'Agreed to move in with Luca', tone: 'good' },
    { icon: '🥀', text: 'Seo-jun left after hearing about Sofía', tone: 'bad' },
  ], 80);
  dayRecord(20, 'Aftermath and ledgers', 'A grey, in-between day. You paid the studio rent, watched ASLP slide, and tried to think of what to say to Seo-jun on Thursday.', ['Paid weekly rent on the Quayside Studio', 'Seo-jun’s relationship marked “on the rocks”'], [
    { icon: '🏠', text: 'Rent paid on the Quayside Studio', tone: 'neutral' },
    { icon: '📉', text: 'ASLP dipped on maintenance news', tone: 'bad' },
  ], 40);
  dayRecord(21, 'Slow rounds and a steeped pot', 'Rain kept the café full and the boardwalk empty. Clara left caramels she’ll deny; Sofía wants you in golden hour tomorrow.', ['Clara set aside cheap caramels for you', 'A long, easy shift at the Driftwood'], [
    { icon: '🍬', text: 'Clara left you a gift', tone: 'good' },
    { icon: '☕', text: 'Closed the café late with Luca', tone: 'good' },
  ], 50);
  dayRecord(22, 'Pancake ate from her hand', 'Mei nearly cried at work and texted you about it; you split tide pools at low tide. A small bright day with nothing to prove.', ['Tide pools at low tide with Mei', 'HRBL climbed on grant rumors'], [
    { icon: '🐟', text: 'Mei’s ray ate from her hand', tone: 'good' },
    { icon: '📈', text: 'HRBL rallied', tone: 'good' },
  ], 90);
  dayRecord(23, 'Two cups on the counter', 'The flat over the café smells of coffee and salt now. Cass— no. Just this: a quiet morning, two cups, and the whole loud world holding still.', ['A quiet morning in the new flat with Luca', 'Collected dividends across the portfolio'], [
    { icon: '🤍', text: 'A settled morning with Luca', tone: 'good' },
    { icon: '💸', text: 'Portfolio dividends paid out', tone: 'neutral' },
  ], 110);

  // --- The Faces feed: a living little social web ----------------------------
  const phaseFor = (offsetMin: number): 'morning' | 'afternoon' | 'evening' =>
    offsetMin < 360 ? 'morning' : offsetMin < 1020 ? 'afternoon' : 'evening';
  const post = (author: string, kind: 'status' | 'life' | 'jealousy' | 'milestone', body: string, mood: string, day: number, offsetMin: number): string => {
    const p = feedPostsRepo.insert(FeedPostSchema.parse({
      id: newId('fpost'), worldId: world.id,
      authorType: author === 'player' ? 'player' : 'character',
      authorId: author === 'player' ? DEFAULT_PLAYER_ID : author,
      body, kind, mood, sourceEventId: null, dayNumber: day, phase: phaseFor(offsetMin), createdAt: at(day, offsetMin * MIN),
    }));
    return p.id;
  };
  const comment = (postId: string, author: string, body: string, tone: string, day: number, offsetMin: number): void => {
    feedCommentsRepo.insert(FeedCommentSchema.parse({
      id: newId('fcmt'), postId,
      authorType: author === 'player' ? 'player' : 'character',
      authorId: author === 'player' ? DEFAULT_PLAYER_ID : author,
      body, tone, createdAt: at(day, offsetMin * MIN),
    }));
  };
  const react = (postId: string, actor: string, kind: 'like' | 'love' | 'laugh' | 'wow' | 'sad' | 'angry', day: number, offsetMin: number): void => {
    feedReactionsRepo.insert(FeedReactionSchema.parse({
      id: newId('frxn'), postId,
      actorType: actor === 'player' ? 'player' : 'character',
      actorId: actor === 'player' ? DEFAULT_PLAYER_ID : actor,
      kind, createdAt: at(day, offsetMin * MIN),
    }));
  };

  // Mei — the ray ate from her hand (the loudest, happiest post)
  const pMei = post(mei.id, 'life', 'PANCAKE THE THORNBACK RAY ATE FROM MY HAND TODAY. eleven years of school for this exact moment and honestly? worth it 🐟🥹', 'giddy', 22, 500);
  comment(pMei, luca.id, 'This is the best news the bay has had all week. First taro tea’s on the house to celebrate.', 'warm', 22, 540);
  comment(pMei, minhAn.id, 'congratulations to you and to pancake. i have added a ray to my game in your honour. it clips through the tank.', 'deadpan', 22, 600);
  comment(pMei, 'player', 'a historic day for marine science and for us', 'fond', 22, 620);
  react(pMei, luca.id, 'love', 22, 545); react(pMei, minhAn.id, 'laugh', 22, 605); react(pMei, sofia.id, 'like', 22, 700); react(pMei, 'player', 'love', 22, 622);

  // Luca — morning café post
  const pLuca = post(luca.id, 'life', 'Rain on the harbor, machine’s warmed up, first pour pulled perfect. Some mornings the little café is the whole world and that’s plenty. ☕🌧️', 'content', 21, 360);
  comment(pLuca, mei.id, 'on my way, save the window seat!!', 'bright', 21, 400);
  comment(pLuca, clara.id, 'Your espresso is the only thing in this town that is never sloppy. High praise. Do not let it go to your head.', 'wry', 21, 430);
  react(pLuca, mei.id, 'love', 21, 401); react(pLuca, 'player', 'like', 21, 420); react(pLuca, clara.id, 'like', 21, 431);

  // Clara — the difficult passage, finally clean
  const pClara = post(clara.id, 'life', 'The Brahms passage I have fought for a month is, as of 11:40 this morning, clean. I will allow myself precisely one caramel.', 'satisfied', 20, 700);
  comment(pClara, seojun.id, 'It carried all the way down the corridor. Worth every repetition. Well done.', 'warm', 20, 760);
  comment(pClara, 'player', 'one caramel? live a little, voss', 'teasing', 20, 800);
  comment(pClara, luca.id, 'I’ll put the second caramel on your tab. Consider it structural support.', 'fond', 20, 820);
  react(pClara, seojun.id, 'like', 20, 761); react(pClara, 'player', 'love', 20, 801); react(pClara, luca.id, 'wow', 20, 821);

  // Sofía — the boardwalk before the cranes
  const pSofia = post(sofia.id, 'life', 'shot the blue stall on the boardwalk today, golden hour, before they tear it down next week. some things you only get to keep on film. 🎞️', 'wistful', 21, 1080);
  comment(pSofia, minhAn.id, 'the light on the peeling paint is unreasonably good. save me a print or i riot.', 'wry', 21, 1120);
  comment(pSofia, seojun.id, 'Those stalls were hand-jointed. I am trying to save the wood, if not the paint. Send me the frame with the corner bracket.', 'cool', 21, 1160);
  comment(pSofia, 'player', 'it’s a beautiful one. you got it right.', 'sincere', 21, 1180);
  react(pSofia, 'player', 'love', 21, 1181); react(pSofia, mei.id, 'sad', 21, 1200); react(pSofia, minhAn.id, 'like', 21, 1122);

  // Minh An — devlog deadpan
  const pMinh = post(minhAn.id, 'life', 'devlog #47: fixed the bug where the cat clipped through the wall. now it clips through the floor. arguably worse. arguably funnier. shipping it.', 'deadpan', 19, 1340);
  comment(pMinh, sofia.id, 'floor cat is canon now. i won’t hear otherwise.', 'playful', 19, 1380);
  comment(pMinh, mei.id, 'i would die for floor cat', 'earnest', 19, 1400);
  comment(pMinh, 'player', 'ship it. floor cat is a feature.', 'fond', 19, 1410);
  react(pMinh, sofia.id, 'laugh', 19, 1381); react(pMinh, mei.id, 'love', 19, 1401); react(pMinh, 'player', 'laugh', 19, 1411);

  // Seo-jun — the lighthouse stair
  const pSeojun = post(seojun.id, 'life', 'Two hundred years and the third stair of the lighthouse still holds. People keep wanting to replace it. They don’t see what they’d be throwing away.', 'quiet', 18, 600);
  comment(pSeojun, clara.id, 'You see things the rest of us walk straight past. The town is lucky to have you on that scaffolding.', 'warm', 18, 660);
  comment(pSeojun, 'player', 'the old wood remembers the hand that cut it. you taught me that.', 'tender', 18, 680);
  react(pSeojun, clara.id, 'like', 18, 661); react(pSeojun, 'player', 'love', 18, 681); react(pSeojun, luca.id, 'like', 18, 700);

  // Player — Star Festival night
  const pStar = post('player', 'status', 'First foggy night of the season. Lanterns going up the whole boardwalk to the lighthouse. I ran sound all day and somehow the quietest five minutes were the best ones. 🏮', 'full', 18, 1200);
  comment(pStar, luca.id, 'Those five minutes were mine and I’m keeping them. Best night this café-keeper’s had in years.', 'overflowing', 18, 1240);
  comment(pStar, mei.id, 'the lanterns from the aquarium roof were SO pretty i cried a normal amount', 'giddy', 18, 1260);
  comment(pStar, clara.id, 'It was, I concede, not unromantic.', 'dry', 18, 1280);
  react(pStar, luca.id, 'love', 18, 1241); react(pStar, mei.id, 'love', 18, 1261); react(pStar, seojun.id, 'like', 18, 1300); react(pStar, clara.id, 'like', 18, 1281);

  // Luca — moving-in milestone
  const pMove = post(luca.id, 'milestone', 'Someone’s cables now live next to my aunt’s old espresso machine. The flat finally feels lived in. I, uh. I’m really happy. That’s the whole post.', 'overflowing', 19, 520);
  comment(pMove, mei.id, 'LUCA. luca i’m so happy i could cry into the ray tank', 'delighted', 19, 560);
  comment(pMove, clara.id, 'Congratulations. Do not turn the café into a recording studio. The acoustics are terrible.', 'deadpan', 19, 600);
  react(pMove, mei.id, 'love', 19, 561); react(pMove, clara.id, 'love', 19, 601); react(pMove, 'player', 'like', 19, 620);

  // Seo-jun — the dignified hurt (ties to the on-the-rocks arc)
  const pHurt = post(seojun.id, 'jealousy', 'Funny how a thing can be true and careful and then someone hears one sentence on the boardwalk and it’s weather again. I’ll be at the lighthouse if anyone means it.', 'hurt', 19, 1280);
  comment(pHurt, clara.id, 'Come down off the scaffolding for one evening. My door is open and the kettle is on.', 'gentle', 19, 1340);
  react(pHurt, clara.id, 'sad', 19, 1341); react(pHurt, 'player', 'sad', 19, 1360);

  // --- More minigame scores, for a fuller "best of" board --------------------
  minigameResultsRepo.insert(MinigameResultSchema.parse({ id: newId('mg'), worldId: world.id, minigameId: 'timing_meter', characterId: sofia.id, score: 94, grade: 'S', reward: { dating: {}, relationship: { chemistry: 5 }, money: 38 }, createdAt: at(18) }));
  minigameResultsRepo.insert(MinigameResultSchema.parse({ id: newId('mg'), worldId: world.id, minigameId: 'two_truths_a_lie', characterId: minhAn.id, score: 80, grade: 'A', reward: { dating: {}, relationship: { trust: 3 }, money: 24 }, createdAt: at(17) }));
  minigameResultsRepo.insert(MinigameResultSchema.parse({ id: newId('mg'), worldId: world.id, minigameId: 'rhythm_serenade', characterId: mei.id, score: 71, grade: 'B', reward: { dating: {}, relationship: { affection: 2 }, money: 16 }, createdAt: at(20) }));
  minigameResultsRepo.insert(MinigameResultSchema.parse({ id: newId('mg'), worldId: world.id, minigameId: 'lore_quiz', characterId: seojun.id, score: 95, grade: 'S', reward: { dating: {}, relationship: { respect: 5 }, money: 40 }, createdAt: at(16) }));

  // --- A DATE IN PROGRESS with Minh An (auto-resumes on the Date tab) --------
  // Left mid-conversation on the current evening so the showcase opens straight
  // into a live date — the deepest surface of the whole system. `ended: false`
  // is what makes getActiveDateForWorld pick it up; updatedAt ≈ now keeps it the
  // freshest active session.
  {
    const start = NOW - 18 * MIN;
    const activeDate = sessionsRepo.insert(ConversationSessionSchema.parse({
      id: newId('sess'), characterId: minhAn.id, locationId: arcade.id, mode: 'date',
      summary: '', ended: false, createdAt: start, updatedAt: NOW,
    }));
    const dateLines: Array<{ role: 'player' | 'character'; text: string }> = [
      { role: 'character', text: 'You’re early. The corner cabinet’s still warm, I didn’t save you the stool. …It’s the one on the left. The one I didn’t save. Sit down.' },
      { role: 'player', text: 'You saved me the stool.' },
      { role: 'character', text: 'I reject the premise. (she scoots it out half an inch with her foot anyway.)' },
      { role: 'player', text: 'What are you working on? You closed the laptop fast when I walked up.' },
      { role: 'character', text: 'Nothing. The ending. …The ending of the game. I’ve been stuck on it for three weeks and I haven’t told anyone that, so. There. That’s the date going well, I assume.' },
      { role: 'player', text: 'Stuck how? Walk me through it. I won’t poke at the cat bug, I promise.' },
      { role: 'character', text: 'It’s not a bug. That’s the problem. Everything works. The rotation puzzle, the floor cat, all of it. I just can’t make the last room *mean* anything. You solve it and then it’s… over. And I sit here at 2am thinking, that’s it? After all of it, the player just leaves?' },
      { role: 'player', text: 'Maybe that’s the feeling. Maybe the last room isn’t a puzzle. Maybe it’s just letting them stand in the thing they built before they go.' },
      { role: 'character', text: '(she is very quiet. she turns the stool to face you, which she does not do.)' },
      { role: 'character', text: '…That’s annoyingly good. Don’t look pleased. You look pleased.' },
      { role: 'player', text: 'I’m not just talking about the game, Minh An.' },
      { role: 'character', text: 'I know. (a long beat, the arcade humming around you both.) I know you’re not. That’s the part I haven’t worked out how to ship either.' },
      { role: 'character', text: 'Okay. Okay — here. (she opens the laptop and turns it toward you, the unfinished build glowing.) Don’t make it weird that I’m letting you see the last room first. Just… tell me what you feel when it ends. Honestly. I’ll know if you lie.' },
    ];
    dateLines.forEach((l, i) => {
      messagesRepo.insert(MessageSchema.parse({
        id: newId('msg'), sessionId: activeDate.id, role: l.role, text: l.text, metadata: {},
        createdAt: start + i * MIN,
      }));
    });
    // Author the live rapport so the resume card shows a real vibe, not neutral.
    // 70 → "warming to you": a guarded character (Minh An, guardedness 52) who has
    // clearly thawed over this conversation — the laptop just came around — without
    // overshooting into "really into it". This persists via session_rapport.
    sessionRapportRepo.upsert(activeDate.id, 70, NOW);
  }

  // --- In-world emails (companies / strangers, never characters) ------------
  const email = (senderName: string, senderHandle: string, subject: string, body: string, day: number, read: boolean): void => {
    emailsRepo.insert(EmailSchema.parse({
      id: newId('email'), playerId: DEFAULT_PLAYER_ID, worldId: world.id, senderName, senderHandle, subject, body,
      status: 'delivered', read, dayNumber: day, scheduledPhase: null, deliveredAt: at(day, 500 * MIN), createdAt: at(day, 500 * MIN),
    }));
  };
  email('Star Festival Committee', 'stages@asterfall-festival.bay', 'Festival stages — sound tech confirmed', 'Hi Rowan — you’re confirmed as stage sound for this year’s Star Festival on the boardwalk. Load-in at the lighthouse end from four; lantern release at dusk, so we go quiet for it. The new monitors arrived (finally). — Committee', 21, false);
  email('Asterfall Almanac', 'tides@asterfall-almanac.bay', 'Star Festival — clear skies forecast', 'The Almanac calls clear skies and a low tide for Festival night. Boardwalk stalls reopen at dusk; the lantern climb starts at the lighthouse. Bring someone. — The Almanac', 22, false);
  email('Harborlight Aquarium', 'no-reply@harborlight.bay', 'Volunteer night-feed schedule', 'This is a courtesy note that your guest pass for after-hours night feeds remains active on the volunteers’ list, per a certain volunteer’s instruction. No reply needed.', 20, true);
  email('Harbor Self-Storage', 'billing@harbor-storage.bay', 'Unit 14 — autopay receipt', 'Thank you. Your monthly payment for Unit 14 (gear & cable overflow) was received. Balance: 0.', 16, true);
  email('Quayside Lettings', 'leases@quayside-lettings.bay', 'Quayside Studio — rent due in two days', 'A friendly reminder that weekly rent on the Quayside Studio (95) comes due on day 26. Autopay is off; pay from the Property app to avoid a notice. — Quayside Lettings', 23, false);
  email('Bayfront Brokerage', 'alerts@bayfront-brokerage.bay', 'Portfolio alert — HRBL up 3.8%', 'Harborlight Marine Labs (HRBL) moved on renewed-grant news. Your position is up on the day. Asterfall Light & Power (ASLP) slipped on maintenance guidance. Full breakdown in the Stocks app.', 24, false);
  email('The Lucky Anchor', 'noreply@luckyanchor-casino.bay', 'Your players-club statement', 'Thanks for playing at The Lucky Anchor. This period: 7 rounds, net +35 chips, one jackpot line on the Lucky Sevens. Please play within your daily limit. The house wishes you fog and fortune.', 19, true);
  email('Asterfall Conservatory', 'boxoffice@asterfall-conservatory.bay', 'Spring Concerto — seat confirmed', 'Your ticket for the Spring Concerto night is confirmed. A certain second-chair violinist is, we’re told, performing. Doors at seven. No reply needed.', 17, true);

  // --- World clock state ----------------------------------------------------
  const existingState = worldStatesRepo.get(world.id);
  const stateRow = WorldStateSchema.parse({
    worldId: world.id, day: CURRENT_DAY, phase: 'evening', stamina: 2, staminaMax: 3,
    actionsToday: 1, lastRecapDay: CURRENT_DAY - 1, dayStartedAt: at(CURRENT_DAY), createdAt: at(1), updatedAt: NOW,
  });
  if (existingState) worldStatesRepo.update(stateRow);
  else worldStatesRepo.insert(stateRow);

  // eslint-disable-next-line no-console
  console.log(
    `Mock world "${MOCK_WORLD_NAME}" created: 6 characters, full histories, a date in progress with Nguyễn Minh An, ` +
      `${feedPostsRepo.listByWorld(world.id).length} feed posts, ${propertiesRepo.listByWorld(world.id).length} properties, ` +
      `${companiesRepo.listByWorld(world.id).length} companies, ${gamblingRoundsRepo.list().filter((r) => r.worldId === world.id).length} casino rounds, ` +
      `${dayRecordsRepo.listByWorld(world.id).length} day recaps, ${minigameResultsRepo.listByWorld(world.id).length} minigame scores, phone threads, emails, 1 epilogue. Day ${CURRENT_DAY}.`,
  );
}

mock();
