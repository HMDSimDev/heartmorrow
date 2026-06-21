import {
  AssetSchema,
  CharacterSchema,
  CharacterMemorySchema,
  ConversationSessionSchema,
  GameEventSchema,
  InventoryItemSchema,
  MessageSchema,
  PlayerProfileSchema,
  RelationshipSchema,
  ShopItemSchema,
  WorldNoteSchema,
  WorldSchema,
  MinigameResultSchema,
  WorldStateSchema,
  NpcEdgeSchema,
  NpcKnowledgeSchema,
  CanonFactSchema,
  MessageThreadSchema,
  TextMessageSchema,
  EmailSchema,
  CharacterChronicleSchema,
  CharacterEndingSchema,
  DayRecordSchema,
  FeedPostSchema,
  FeedCommentSchema,
  FeedReactionSchema,
  PropertySchema,
  PropertyOwnershipSchema,
  PropertyLeaseSchema,
  LandlordNoticeSchema,
  CompanySchema,
  StockHoldingSchema,
  StockPriceSchema,
  MarketNewsSchema,
  GamblingRoundSchema,
  type Asset,
  type Character,
  type WorldState,
  type NpcEdge,
  type NpcKnowledge,
  type CanonFact,
  type CanonFactStatus,
  type MessageThread,
  type TextMessage,
  type Email,
  type CharacterChronicle,
  type CharacterEnding,
  type DayRecord,
  type FeedPost,
  type FeedComment,
  type FeedReaction,
  type Property,
  type PropertyOwnership,
  type PropertyLease,
  type LandlordNotice,
  type Company,
  type StockHolding,
  type StockPrice,
  type MarketNews,
  type CharacterMemory,
  type ConversationSession,
  type GameEvent,
  type InventoryItem,
  type Message,
  type MinigameResult,
  type PlayerProfile,
  type Relationship,
  type ShopItem,
  type WorldNote,
  type World,
  type GamblingRound,
} from '@dsim/shared';
import { getDb } from './index';
import type { Row } from './sqlite';

// --- mapping helpers --------------------------------------------------------

const j = (v: unknown): string => JSON.stringify(v ?? null);
function fromJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}
const boolToInt = (b: boolean): number => (b ? 1 : 0);
const intToBool = (v: unknown): boolean => v === 1 || v === true || v === '1';
const nNum = (v: unknown): number | null => (v == null ? null : Number(v));
const nStr = (v: unknown): string | null => (v == null ? null : String(v));

// --- worlds -----------------------------------------------------------------

function rowToWorld(r: Row): World {
  return WorldSchema.parse({
    id: r.id,
    name: r.name,
    summary: r.summary,
    tone: r.tone,
    globalNotes: r.global_notes,
    locations: fromJson(r.locations, []),
    rules: r.rules,
    lore: r.lore,
    featureFlags: fromJson(r.feature_flags, {}),
    gamblingConfig: fromJson(r.gambling_config, {}),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  });
}

export const worldsRepo = {
  get(id: string): World | undefined {
    const r = getDb().get<Row>('SELECT * FROM worlds WHERE id = ?', id);
    return r ? rowToWorld(r) : undefined;
  },
  list(): World[] {
    return getDb()
      .all<Row>('SELECT * FROM worlds ORDER BY created_at ASC')
      .map(rowToWorld);
  },
  insert(w: World): World {
    getDb().run(
      `INSERT INTO worlds (id,name,summary,tone,global_notes,locations,rules,lore,feature_flags,gambling_config,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      w.id, w.name, w.summary, w.tone, w.globalNotes, j(w.locations), w.rules, w.lore, j(w.featureFlags), j(w.gamblingConfig), w.createdAt, w.updatedAt,
    );
    return w;
  },
  update(w: World): World {
    getDb().run(
      `UPDATE worlds SET name=?,summary=?,tone=?,global_notes=?,locations=?,rules=?,lore=?,feature_flags=?,gambling_config=?,updated_at=? WHERE id=?`,
      w.name, w.summary, w.tone, w.globalNotes, j(w.locations), w.rules, w.lore, j(w.featureFlags), j(w.gamblingConfig), w.updatedAt, w.id,
    );
    return w;
  },
  delete(id: string): void {
    getDb().run('DELETE FROM worlds WHERE id = ?', id);
  },
};

// --- world notes ------------------------------------------------------------

function rowToWorldNote(r: Row): WorldNote {
  return WorldNoteSchema.parse({
    id: r.id,
    worldId: r.world_id,
    title: r.title,
    body: r.body,
    tags: fromJson(r.tags, []),
    scope: r.scope,
    importance: Number(r.importance),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  });
}

export const worldNotesRepo = {
  get(id: string): WorldNote | undefined {
    const r = getDb().get<Row>('SELECT * FROM world_notes WHERE id = ?', id);
    return r ? rowToWorldNote(r) : undefined;
  },
  listByWorld(worldId: string): WorldNote[] {
    return getDb()
      .all<Row>('SELECT * FROM world_notes WHERE world_id = ? ORDER BY importance DESC, created_at ASC', worldId)
      .map(rowToWorldNote);
  },
  insert(n: WorldNote): WorldNote {
    getDb().run(
      `INSERT INTO world_notes (id,world_id,title,body,tags,scope,importance,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      n.id, n.worldId, n.title, n.body, j(n.tags), n.scope, n.importance, n.createdAt, n.updatedAt,
    );
    return n;
  },
  update(n: WorldNote): WorldNote {
    getDb().run(
      `UPDATE world_notes SET title=?,body=?,tags=?,scope=?,importance=?,updated_at=? WHERE id=?`,
      n.title, n.body, j(n.tags), n.scope, n.importance, n.updatedAt, n.id,
    );
    return n;
  },
  delete(id: string): void {
    getDb().run('DELETE FROM world_notes WHERE id = ?', id);
  },
};

// --- characters -------------------------------------------------------------

function rowToCharacter(r: Row): Character {
  return CharacterSchema.parse({
    id: r.id,
    worldId: nStr(r.world_id),
    name: r.name,
    age: Number(r.age),
    pronouns: r.pronouns,
    gender: r.gender ?? 'unspecified',
    sexuality: r.sexuality ?? 'unspecified',
    shortDescription: r.short_description,
    personality: r.personality,
    creatorNotes: r.creator_notes,
    speechStyle: r.speech_style,
    likes: fromJson(r.likes, []),
    dislikes: fromJson(r.dislikes, []),
    boundaries: fromJson(r.boundaries, []),
    goals: fromJson(r.goals, []),
    relationshipPreferences: r.relationship_preferences,
    relationshipStyle: r.relationship_style ?? 'monogamous',
    guardedness: Number(r.guardedness ?? 30),
    links: fromJson(r.links, []),
    favoriteWeather: fromJson(r.favorite_weather, []),
    dislikedWeather: fromJson(r.disliked_weather, []),
    roomDescription: r.room_description ?? '',
    appearance: r.appearance ?? '',
    physicalNeeds: fromJson(r.physical_needs, []),
    physicalDesires: fromJson(r.physical_desires, []),
    physicalDislikes: fromJson(r.physical_dislikes, []),
    textingStyle: r.texting_style ?? '',
    onlinePersona: r.online_persona ?? '',
    loveLanguage: r.love_language ?? '',
    insecurities: fromJson(r.insecurities, []),
    quirks: fromJson(r.quirks, []),
    employment: fromJson(r.employment, null),
    allowsExCanonization: Number(r.allows_ex_canonization ?? 0) === 1,
    datingStats: fromJson(r.dating_stats, {}),
    portraitAssetId: nStr(r.portrait_asset_id),
    expressionAssets: fromJson(r.expression_assets, {}),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  });
}

export const charactersRepo = {
  get(id: string): Character | undefined {
    const r = getDb().get<Row>('SELECT * FROM characters WHERE id = ?', id);
    return r ? rowToCharacter(r) : undefined;
  },
  list(): Character[] {
    return getDb()
      .all<Row>('SELECT * FROM characters ORDER BY created_at ASC')
      .map(rowToCharacter);
  },
  listByWorld(worldId: string): Character[] {
    return getDb()
      .all<Row>('SELECT * FROM characters WHERE world_id = ? ORDER BY created_at ASC', worldId)
      .map(rowToCharacter);
  },
  insert(c: Character): Character {
    getDb().run(
      `INSERT INTO characters (id,world_id,name,age,pronouns,gender,sexuality,short_description,personality,creator_notes,speech_style,likes,dislikes,boundaries,goals,relationship_preferences,relationship_style,guardedness,links,favorite_weather,disliked_weather,room_description,appearance,physical_needs,physical_desires,physical_dislikes,texting_style,online_persona,love_language,insecurities,quirks,employment,allows_ex_canonization,dating_stats,portrait_asset_id,expression_assets,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      c.id, c.worldId, c.name, c.age, c.pronouns, c.gender, c.sexuality, c.shortDescription, c.personality, c.creatorNotes, c.speechStyle,
      j(c.likes), j(c.dislikes), j(c.boundaries), j(c.goals), c.relationshipPreferences, c.relationshipStyle, c.guardedness, j(c.links),
      j(c.favoriteWeather), j(c.dislikedWeather), c.roomDescription,
      c.appearance, j(c.physicalNeeds), j(c.physicalDesires), j(c.physicalDislikes), c.textingStyle, c.onlinePersona, c.loveLanguage, j(c.insecurities), j(c.quirks), j(c.employment), c.allowsExCanonization ? 1 : 0,
      j(c.datingStats), c.portraitAssetId, j(c.expressionAssets), c.createdAt, c.updatedAt,
    );
    return c;
  },
  update(c: Character): Character {
    getDb().run(
      `UPDATE characters SET world_id=?,name=?,age=?,pronouns=?,gender=?,sexuality=?,short_description=?,personality=?,creator_notes=?,speech_style=?,likes=?,dislikes=?,boundaries=?,goals=?,relationship_preferences=?,relationship_style=?,guardedness=?,links=?,favorite_weather=?,disliked_weather=?,room_description=?,appearance=?,physical_needs=?,physical_desires=?,physical_dislikes=?,texting_style=?,online_persona=?,love_language=?,insecurities=?,quirks=?,employment=?,allows_ex_canonization=?,dating_stats=?,portrait_asset_id=?,expression_assets=?,updated_at=? WHERE id=?`,
      c.worldId, c.name, c.age, c.pronouns, c.gender, c.sexuality, c.shortDescription, c.personality, c.creatorNotes, c.speechStyle,
      j(c.likes), j(c.dislikes), j(c.boundaries), j(c.goals), c.relationshipPreferences, c.relationshipStyle, c.guardedness, j(c.links),
      j(c.favoriteWeather), j(c.dislikedWeather), c.roomDescription,
      c.appearance, j(c.physicalNeeds), j(c.physicalDesires), j(c.physicalDislikes), c.textingStyle, c.onlinePersona, c.loveLanguage, j(c.insecurities), j(c.quirks), j(c.employment), c.allowsExCanonization ? 1 : 0,
      j(c.datingStats), c.portraitAssetId, j(c.expressionAssets), c.updatedAt, c.id,
    );
    return c;
  },
  delete(id: string): void {
    getDb().run('DELETE FROM characters WHERE id = ?', id);
  },
};

// --- character memories -----------------------------------------------------

function rowToMemory(r: Row): CharacterMemory {
  return CharacterMemorySchema.parse({
    id: r.id,
    characterId: r.character_id,
    text: r.text,
    importance: Number(r.importance),
    tags: fromJson(r.tags, []),
    sourceEventId: nStr(r.source_event_id),
    relatedCharacterId: nStr(r.related_character_id),
    createdAt: Number(r.created_at),
    lastUsedAt: nNum(r.last_used_at),
  });
}

export const memoriesRepo = {
  get(id: string): CharacterMemory | undefined {
    const r = getDb().get<Row>('SELECT * FROM character_memories WHERE id = ?', id);
    return r ? rowToMemory(r) : undefined;
  },
  listByCharacter(characterId: string): CharacterMemory[] {
    return getDb()
      .all<Row>('SELECT * FROM character_memories WHERE character_id = ? ORDER BY created_at DESC', characterId)
      .map(rowToMemory);
  },
  insert(m: CharacterMemory): CharacterMemory {
    getDb().run(
      `INSERT INTO character_memories (id,character_id,text,importance,tags,source_event_id,related_character_id,created_at,last_used_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      m.id, m.characterId, m.text, m.importance, j(m.tags), m.sourceEventId, m.relatedCharacterId, m.createdAt, m.lastUsedAt,
    );
    return m;
  },
  /** Rewrite a memory's text in place — used by the world-sim to upgrade a templated
   *  meeting memory ("Caught up with Mara.") with the colored gist once it's back. */
  updateText(id: string, text: string): void {
    getDb().run('UPDATE character_memories SET text = ? WHERE id = ?', text, id);
  },
  touch(id: string, when: number): void {
    getDb().run('UPDATE character_memories SET last_used_at = ? WHERE id = ?', when, id);
  },
  delete(id: string): void {
    getDb().run('DELETE FROM character_memories WHERE id = ?', id);
  },
};

// --- relationships ----------------------------------------------------------

function rowToRelationship(r: Row): Relationship {
  return RelationshipSchema.parse({
    id: r.id,
    characterId: r.character_id,
    playerId: r.player_id,
    affection: Number(r.affection),
    trust: Number(r.trust),
    chemistry: Number(r.chemistry),
    comfort: Number(r.comfort),
    respect: Number(r.respect),
    curiosity: Number(r.curiosity),
    tension: Number(r.tension),
    flags: fromJson(r.flags, {}),
    updatedAt: Number(r.updated_at),
  });
}

export const relationshipsRepo = {
  getByCharacter(characterId: string, playerId: string): Relationship | undefined {
    const r = getDb().get<Row>(
      'SELECT * FROM relationships WHERE character_id = ? AND player_id = ?',
      characterId,
      playerId,
    );
    return r ? rowToRelationship(r) : undefined;
  },
  insert(rel: Relationship): Relationship {
    getDb().run(
      `INSERT INTO relationships (id,character_id,player_id,affection,trust,chemistry,comfort,respect,curiosity,tension,flags,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      rel.id, rel.characterId, rel.playerId, rel.affection, rel.trust, rel.chemistry, rel.comfort, rel.respect,
      rel.curiosity, rel.tension, j(rel.flags), rel.updatedAt,
    );
    return rel;
  },
  update(rel: Relationship): Relationship {
    getDb().run(
      `UPDATE relationships SET affection=?,trust=?,chemistry=?,comfort=?,respect=?,curiosity=?,tension=?,flags=?,updated_at=? WHERE id=?`,
      rel.affection, rel.trust, rel.chemistry, rel.comfort, rel.respect, rel.curiosity, rel.tension, j(rel.flags),
      rel.updatedAt, rel.id,
    );
    return rel;
  },
};

// --- players ----------------------------------------------------------------

function rowToPlayer(r: Row): PlayerProfile {
  return PlayerProfileSchema.parse({
    id: r.id,
    name: r.name,
    pronouns: r.pronouns,
    gender: r.gender ?? 'unspecified',
    sexuality: r.sexuality ?? 'unspecified',
    personaNotes: r.persona_notes,
    money: Number(r.money),
    career: fromJson(r.career, {}),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  });
}

export const playersRepo = {
  get(id: string): PlayerProfile | undefined {
    const r = getDb().get<Row>('SELECT * FROM players WHERE id = ?', id);
    return r ? rowToPlayer(r) : undefined;
  },
  insert(p: PlayerProfile): PlayerProfile {
    getDb().run(
      `INSERT INTO players (id,name,pronouns,gender,sexuality,persona_notes,money,career,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      p.id, p.name, p.pronouns, p.gender, p.sexuality, p.personaNotes, p.money, j(p.career), p.createdAt, p.updatedAt,
    );
    return p;
  },
  update(p: PlayerProfile): PlayerProfile {
    getDb().run(
      `UPDATE players SET name=?,pronouns=?,gender=?,sexuality=?,persona_notes=?,money=?,career=?,updated_at=? WHERE id=?`,
      p.name, p.pronouns, p.gender, p.sexuality, p.personaNotes, p.money, j(p.career), p.updatedAt, p.id,
    );
    return p;
  },
};

// --- assets -----------------------------------------------------------------

function rowToAsset(r: Row): Asset {
  return AssetSchema.parse({
    id: r.id,
    type: r.type,
    path: r.path,
    filename: r.filename,
    mimeType: r.mime_type,
    altText: r.alt_text,
    tags: fromJson(r.tags, []),
    metadata: fromJson(r.metadata, {}),
    createdAt: Number(r.created_at),
  });
}

export const assetsRepo = {
  get(id: string): Asset | undefined {
    const r = getDb().get<Row>('SELECT * FROM assets WHERE id = ?', id);
    return r ? rowToAsset(r) : undefined;
  },
  list(): Asset[] {
    return getDb().all<Row>('SELECT * FROM assets ORDER BY created_at DESC').map(rowToAsset);
  },
  insert(a: Asset): Asset {
    getDb().run(
      `INSERT INTO assets (id,type,path,filename,mime_type,alt_text,tags,metadata,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      a.id, a.type, a.path, a.filename, a.mimeType, a.altText, j(a.tags), j(a.metadata), a.createdAt,
    );
    return a;
  },
  delete(id: string): void {
    getDb().run('DELETE FROM assets WHERE id = ?', id);
  },
};

// --- sessions + messages ----------------------------------------------------

function rowToSession(r: Row): ConversationSession {
  return ConversationSessionSchema.parse({
    id: r.id,
    characterId: r.character_id,
    locationId: nStr(r.location_id),
    mode: r.mode,
    summary: r.summary,
    ended: intToBool(r.ended),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  });
}

export const sessionsRepo = {
  get(id: string): ConversationSession | undefined {
    const r = getDb().get<Row>('SELECT * FROM conversation_sessions WHERE id = ?', id);
    return r ? rowToSession(r) : undefined;
  },
  list(): ConversationSession[] {
    return getDb()
      .all<Row>('SELECT * FROM conversation_sessions ORDER BY updated_at DESC')
      .map(rowToSession);
  },
  /** Not-yet-ended sessions, most-recently-updated first — the source for resuming
   *  an in-progress date after a navigation/refresh. */
  listActive(): ConversationSession[] {
    return getDb()
      .all<Row>('SELECT * FROM conversation_sessions WHERE ended = 0 ORDER BY updated_at DESC')
      .map(rowToSession);
  },
  listByCharacter(characterId: string): ConversationSession[] {
    return getDb()
      .all<Row>('SELECT * FROM conversation_sessions WHERE character_id = ? ORDER BY updated_at DESC', characterId)
      .map(rowToSession);
  },
  insert(s: ConversationSession): ConversationSession {
    getDb().run(
      `INSERT INTO conversation_sessions (id,character_id,location_id,mode,summary,ended,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      s.id, s.characterId, s.locationId, s.mode, s.summary, boolToInt(s.ended), s.createdAt, s.updatedAt,
    );
    return s;
  },
  update(s: ConversationSession): ConversationSession {
    getDb().run(
      `UPDATE conversation_sessions SET location_id=?,mode=?,summary=?,ended=?,updated_at=? WHERE id=?`,
      s.locationId, s.mode, s.summary, boolToInt(s.ended), s.updatedAt, s.id,
    );
    return s;
  },
  delete(id: string): void {
    getDb().run('DELETE FROM conversation_sessions WHERE id = ?', id);
  },
};

function rowToMessage(r: Row): Message {
  return MessageSchema.parse({
    id: r.id,
    sessionId: r.session_id,
    role: r.role,
    text: r.text,
    metadata: fromJson(r.metadata, {}),
    createdAt: Number(r.created_at),
  });
}

export const messagesRepo = {
  listBySession(sessionId: string): Message[] {
    return getDb()
      .all<Row>('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC', sessionId)
      .map(rowToMessage);
  },
  countBySession(sessionId: string): number {
    const r = getDb().get<Row>('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?', sessionId);
    return r ? Number(r.n) : 0;
  },
  /** Whether the session has at least one message in the given role (e.g. a real
   *  player turn). Lets a date that the character only opened still not "count". */
  hasRole(sessionId: string, role: Message['role']): boolean {
    const r = getDb().get<Row>('SELECT 1 AS n FROM messages WHERE session_id = ? AND role = ? LIMIT 1', sessionId, role);
    return r != null;
  },
  insert(m: Message): Message {
    getDb().run(
      `INSERT INTO messages (id,session_id,role,text,metadata,created_at) VALUES (?,?,?,?,?,?)`,
      m.id, m.sessionId, m.role, m.text, j(m.metadata), m.createdAt,
    );
    return m;
  },
};

// --- shop + inventory -------------------------------------------------------

function rowToShopItem(r: Row): ShopItem {
  return ShopItemSchema.parse({
    id: r.id,
    name: r.name,
    description: r.description,
    price: Number(r.price),
    category: r.category,
    rarity: r.rarity,
    effects: fromJson(r.effects, []),
    infiniteStock: intToBool(r.infinite_stock),
    stock: Number(r.stock),
    assetId: nStr(r.asset_id),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  });
}

export const shopItemsRepo = {
  get(id: string): ShopItem | undefined {
    const r = getDb().get<Row>('SELECT * FROM shop_items WHERE id = ?', id);
    return r ? rowToShopItem(r) : undefined;
  },
  list(): ShopItem[] {
    return getDb().all<Row>('SELECT * FROM shop_items ORDER BY price ASC').map(rowToShopItem);
  },
  insert(s: ShopItem): ShopItem {
    getDb().run(
      `INSERT INTO shop_items (id,name,description,price,category,rarity,effects,infinite_stock,stock,asset_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      s.id, s.name, s.description, s.price, s.category, s.rarity, j(s.effects), boolToInt(s.infiniteStock), s.stock,
      s.assetId, s.createdAt, s.updatedAt,
    );
    return s;
  },
  update(s: ShopItem): ShopItem {
    getDb().run(
      `UPDATE shop_items SET name=?,description=?,price=?,category=?,rarity=?,effects=?,infinite_stock=?,stock=?,asset_id=?,updated_at=? WHERE id=?`,
      s.name, s.description, s.price, s.category, s.rarity, j(s.effects), boolToInt(s.infiniteStock), s.stock,
      s.assetId, s.updatedAt, s.id,
    );
    return s;
  },
  delete(id: string): void {
    getDb().run('DELETE FROM shop_items WHERE id = ?', id);
  },
};

function rowToInventory(r: Row): InventoryItem {
  return InventoryItemSchema.parse({
    id: r.id,
    playerId: r.player_id,
    shopItemId: r.shop_item_id,
    quantity: Number(r.quantity),
    acquiredAt: Number(r.acquired_at),
  });
}

export const inventoryRepo = {
  get(id: string): InventoryItem | undefined {
    const r = getDb().get<Row>('SELECT * FROM inventory_items WHERE id = ?', id);
    return r ? rowToInventory(r) : undefined;
  },
  listByPlayer(playerId: string): InventoryItem[] {
    return getDb()
      .all<Row>('SELECT * FROM inventory_items WHERE player_id = ? AND quantity > 0 ORDER BY acquired_at DESC', playerId)
      .map(rowToInventory);
  },
  /** All rows for a player including quantity-0 (used for faithful export). */
  listAllByPlayer(playerId: string): InventoryItem[] {
    return getDb()
      .all<Row>('SELECT * FROM inventory_items WHERE player_id = ? ORDER BY acquired_at DESC', playerId)
      .map(rowToInventory);
  },
  getByPlayerAndItem(playerId: string, shopItemId: string): InventoryItem | undefined {
    const r = getDb().get<Row>(
      'SELECT * FROM inventory_items WHERE player_id = ? AND shop_item_id = ?',
      playerId,
      shopItemId,
    );
    return r ? rowToInventory(r) : undefined;
  },
  insert(i: InventoryItem): InventoryItem {
    getDb().run(
      `INSERT INTO inventory_items (id,player_id,shop_item_id,quantity,acquired_at) VALUES (?,?,?,?,?)`,
      i.id, i.playerId, i.shopItemId, i.quantity, i.acquiredAt,
    );
    return i;
  },
  update(i: InventoryItem): InventoryItem {
    getDb().run('UPDATE inventory_items SET quantity=?,acquired_at=? WHERE id=?', i.quantity, i.acquiredAt, i.id);
    return i;
  },
};

// --- minigame results -------------------------------------------------------

function rowToMinigameResult(r: Row): MinigameResult {
  return MinigameResultSchema.parse({
    id: r.id,
    minigameId: r.minigame_id,
    characterId: nStr(r.character_id),
    worldId: nStr(r.world_id),
    score: Number(r.score),
    grade: r.grade,
    reward: fromJson(r.reward, {}),
    createdAt: Number(r.created_at),
  });
}

export const minigameResultsRepo = {
  list(): MinigameResult[] {
    return getDb()
      .all<Row>('SELECT * FROM minigame_results ORDER BY created_at DESC LIMIT 100')
      .map(rowToMinigameResult);
  },
  /** Recent results for ONE world (per-world highscore board). */
  listByWorld(worldId: string): MinigameResult[] {
    return getDb()
      .all<Row>('SELECT * FROM minigame_results WHERE world_id = ? ORDER BY created_at DESC LIMIT 100', worldId)
      .map(rowToMinigameResult);
  },
  insert(m: MinigameResult): MinigameResult {
    getDb().run(
      `INSERT INTO minigame_results (id,minigame_id,character_id,world_id,score,grade,reward,created_at) VALUES (?,?,?,?,?,?,?,?)`,
      m.id, m.minigameId, m.characterId, m.worldId, m.score, m.grade, j(m.reward), m.createdAt,
    );
    return m;
  },
  /** Highest prior score for a (game, character|solo) pairing in a world, or null
   *  if none. A null worldId matches legacy rows only (pre per-world highscores). */
  bestScore(minigameId: string, characterId: string | null, worldId: string | null): number | null {
    const charClause = characterId === null ? 'character_id IS NULL' : 'character_id = ?';
    const worldClause = worldId === null ? 'world_id IS NULL' : 'world_id = ?';
    const params: Array<string> = [minigameId];
    if (characterId !== null) params.push(characterId);
    if (worldId !== null) params.push(worldId);
    const row = getDb().get<{ best: number | null }>(
      `SELECT MAX(score) AS best FROM minigame_results WHERE minigame_id = ? AND ${charClause} AND ${worldClause}`,
      ...params,
    );
    return row && row.best !== null && row.best !== undefined ? Number(row.best) : null;
  },
};

// --- game events ------------------------------------------------------------

function rowToEvent(r: Row): GameEvent {
  return GameEventSchema.parse({
    id: r.id,
    type: r.type,
    worldId: nStr(r.world_id),
    payload: fromJson(r.payload, {}),
    createdAt: Number(r.created_at),
  });
}

export const eventsRepo = {
  list(limit = 100): GameEvent[] {
    return getDb()
      .all<Row>('SELECT * FROM game_events ORDER BY created_at DESC LIMIT ?', limit)
      .map(rowToEvent);
  },
  /** Events created at or after a timestamp, oldest first (for the day recap).
   *  `rowid` breaks created_at ties so insertion order is stable (the day-record
   *  backfill segments this stream by day_advanced markers and relies on it). */
  listSince(since: number): GameEvent[] {
    return getDb()
      .all<Row>('SELECT * FROM game_events WHERE created_at >= ? ORDER BY created_at ASC, rowid ASC', since)
      .map(rowToEvent);
  },
  /** A single world's events at or after a timestamp, oldest first — the
   *  world-scoped recap query. Legacy NULL-world rows are intentionally excluded
   *  (they predate world-keying), so one world's recap never narrates another's. */
  listSinceByWorld(worldId: string, since: number): GameEvent[] {
    return getDb()
      .all<Row>(
        'SELECT * FROM game_events WHERE world_id = ? AND created_at >= ? ORDER BY created_at ASC, rowid ASC',
        worldId,
        since,
      )
      .map(rowToEvent);
  },
  /** Events whose payload.characterId matches, newest first (for the Moments timeline). */
  listByCharacter(characterId: string, limit = 300): GameEvent[] {
    return getDb()
      .all<Row>(
        `SELECT * FROM game_events WHERE json_extract(payload, '$.characterId') = ?
         ORDER BY created_at DESC LIMIT ?`,
        characterId,
        limit,
      )
      .map(rowToEvent);
  },
  insert(e: GameEvent): GameEvent {
    getDb().run(
      'INSERT INTO game_events (id,type,world_id,payload,created_at) VALUES (?,?,?,?,?)',
      e.id, e.type, e.worldId, j(e.payload), e.createdAt,
    );
    return e;
  },
};

// --- world state (per-world clock) ------------------------------------------

function rowToWorldState(r: Row): WorldState {
  return WorldStateSchema.parse({
    worldId: r.world_id,
    day: Number(r.day),
    phase: r.phase,
    stamina: Number(r.stamina),
    staminaMax: Number(r.stamina_max),
    actionsToday: Number(r.actions_today),
    lastRecapDay: Number(r.last_recap_day),
    lastWorldSimDay: Number(r.last_world_sim_day ?? 0),
    lastRentCalculatedDay: Number(r.last_rent_calculated_day ?? 0),
    lastStockCalculatedDay: Number(r.last_stock_calculated_day ?? 0),
    dayStartedAt: Number(r.day_started_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  });
}

export const worldStatesRepo = {
  get(worldId: string): WorldState | undefined {
    const r = getDb().get<Row>('SELECT * FROM world_states WHERE world_id = ?', worldId);
    return r ? rowToWorldState(r) : undefined;
  },
  insert(s: WorldState): WorldState {
    getDb().run(
      `INSERT INTO world_states (world_id,day,phase,stamina,stamina_max,actions_today,last_recap_day,last_world_sim_day,last_rent_calculated_day,last_stock_calculated_day,day_started_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      s.worldId, s.day, s.phase, s.stamina, s.staminaMax, s.actionsToday, s.lastRecapDay, s.lastWorldSimDay, s.lastRentCalculatedDay, s.lastStockCalculatedDay, s.dayStartedAt, s.createdAt, s.updatedAt,
    );
    return s;
  },
  update(s: WorldState): WorldState {
    getDb().run(
      `UPDATE world_states SET day=?,phase=?,stamina=?,stamina_max=?,actions_today=?,last_recap_day=?,last_world_sim_day=?,last_rent_calculated_day=?,last_stock_calculated_day=?,day_started_at=?,updated_at=? WHERE world_id=?`,
      s.day, s.phase, s.stamina, s.staminaMax, s.actionsToday, s.lastRecapDay, s.lastWorldSimDay, s.lastRentCalculatedDay, s.lastStockCalculatedDay, s.dayStartedAt, s.updatedAt, s.worldId,
    );
    return s;
  },
};

// --- phone: threads + texts -------------------------------------------------

function rowToThread(r: Row): MessageThread {
  return MessageThreadSchema.parse({
    id: r.id,
    characterId: r.character_id,
    playerId: r.player_id,
    lastMessageAt: nNum(r.last_message_at),
    unreadCount: Number(r.unread_count),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  });
}

export const threadsRepo = {
  getByCharacter(characterId: string, playerId: string): MessageThread | undefined {
    const r = getDb().get<Row>(
      'SELECT * FROM message_threads WHERE character_id = ? AND player_id = ?',
      characterId,
      playerId,
    );
    return r ? rowToThread(r) : undefined;
  },
  get(id: string): MessageThread | undefined {
    const r = getDb().get<Row>('SELECT * FROM message_threads WHERE id = ?', id);
    return r ? rowToThread(r) : undefined;
  },
  listByPlayer(playerId: string): MessageThread[] {
    return getDb()
      .all<Row>('SELECT * FROM message_threads WHERE player_id = ? ORDER BY last_message_at DESC NULLS LAST, created_at DESC', playerId)
      .map(rowToThread);
  },
  insert(t: MessageThread): MessageThread {
    getDb().run(
      `INSERT INTO message_threads (id,character_id,player_id,last_message_at,unread_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
      t.id, t.characterId, t.playerId, t.lastMessageAt, t.unreadCount, t.createdAt, t.updatedAt,
    );
    return t;
  },
  update(t: MessageThread): MessageThread {
    getDb().run(
      `UPDATE message_threads SET last_message_at=?,unread_count=?,updated_at=? WHERE id=?`,
      t.lastMessageAt, t.unreadCount, t.updatedAt, t.id,
    );
    return t;
  },
};

function rowToText(r: Row): TextMessage {
  return TextMessageSchema.parse({
    id: r.id,
    threadId: r.thread_id,
    sender: r.sender,
    body: r.body,
    status: r.status,
    dayNumber: nNum(r.day_number),
    scheduledPhase: nStr(r.scheduled_phase),
    attachment: fromJson(r.attachment, null),
    imageAssetId: nStr(r.image_asset_id),
    deliveredAt: nNum(r.delivered_at),
    createdAt: Number(r.created_at),
  });
}

export const textMessagesRepo = {
  get(id: string): TextMessage | undefined {
    const r = getDb().get<Row>('SELECT * FROM text_messages WHERE id = ?', id);
    return r ? rowToText(r) : undefined;
  },
  listDeliveredByThread(threadId: string): TextMessage[] {
    // Order by ARRIVAL time (delivered_at) so a daily text generated at dawn but
    // delivered in the evening appears in the right place, not back at the top.
    return getDb()
      .all<Row>(
        `SELECT * FROM text_messages WHERE thread_id = ? AND status = 'delivered'
         ORDER BY COALESCE(delivered_at, created_at) ASC, rowid ASC`,
        threadId,
      )
      .map(rowToText);
  },
  /** All texts (delivered + still-queued) for a thread — used for faithful export. */
  listAllByThread(threadId: string): TextMessage[] {
    return getDb()
      .all<Row>('SELECT * FROM text_messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC', threadId)
      .map(rowToText);
  },
  lastDelivered(threadId: string): TextMessage | undefined {
    const r = getDb().get<Row>(
      `SELECT * FROM text_messages WHERE thread_id = ? AND status = 'delivered'
       ORDER BY COALESCE(delivered_at, created_at) DESC, rowid DESC LIMIT 1`,
      threadId,
    );
    return r ? rowToText(r) : undefined;
  },
  listQueued(): TextMessage[] {
    // Deterministic order so the per-thread delivery throttle always releases the
    // OLDEST queued text first (a swept prior-day text drains before today's).
    return getDb()
      .all<Row>(`SELECT * FROM text_messages WHERE status = 'queued' ORDER BY day_number ASC, created_at ASC, rowid ASC`)
      .map(rowToText);
  },
  insert(m: TextMessage): TextMessage {
    getDb().run(
      `INSERT INTO text_messages (id,thread_id,sender,body,status,day_number,scheduled_phase,attachment,image_asset_id,delivered_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      m.id, m.threadId, m.sender, m.body, m.status, m.dayNumber, m.scheduledPhase,
      m.attachment ? j(m.attachment) : null, m.imageAssetId, m.deliveredAt, m.createdAt,
    );
    return m;
  },
  update(m: TextMessage): TextMessage {
    getDb().run(
      `UPDATE text_messages SET body=?,status=?,attachment=?,delivered_at=? WHERE id=?`,
      m.body, m.status, m.attachment ? j(m.attachment) : null, m.deliveredAt, m.id,
    );
    return m;
  },
};

// --- phone: emails ----------------------------------------------------------

function rowToEmail(r: Row): Email {
  return EmailSchema.parse({
    id: r.id,
    playerId: r.player_id,
    worldId: nStr(r.world_id),
    senderName: r.sender_name,
    senderHandle: r.sender_handle,
    subject: r.subject,
    body: r.body,
    status: r.status,
    read: intToBool(r.read),
    dayNumber: nNum(r.day_number),
    scheduledPhase: nStr(r.scheduled_phase),
    deliveredAt: nNum(r.delivered_at),
    createdAt: Number(r.created_at),
  });
}

export const emailsRepo = {
  get(id: string): Email | undefined {
    const r = getDb().get<Row>('SELECT * FROM emails WHERE id = ?', id);
    return r ? rowToEmail(r) : undefined;
  },
  listDeliveredByPlayer(playerId: string): Email[] {
    return getDb()
      .all<Row>(`SELECT * FROM emails WHERE player_id = ? AND status = 'delivered' ORDER BY delivered_at DESC, created_at DESC`, playerId)
      .map(rowToEmail);
  },
  /** Delivered emails for a player scoped to one world (legacy null-world rows excluded). */
  listDeliveredByPlayerAndWorld(playerId: string, worldId: string): Email[] {
    return getDb()
      .all<Row>(
        `SELECT * FROM emails WHERE player_id = ? AND world_id = ? AND status = 'delivered' ORDER BY delivered_at DESC, created_at DESC`,
        playerId,
        worldId,
      )
      .map(rowToEmail);
  },
  listQueued(): Email[] {
    return getDb().all<Row>(`SELECT * FROM emails WHERE status = 'queued'`).map(rowToEmail);
  },
  countUnread(playerId: string): number {
    const r = getDb().get<Row>(`SELECT COUNT(*) AS n FROM emails WHERE player_id = ? AND status = 'delivered' AND read = 0`, playerId);
    return r ? Number(r.n) : 0;
  },
  countUnreadByWorld(playerId: string, worldId: string): number {
    const r = getDb().get<Row>(
      `SELECT COUNT(*) AS n FROM emails WHERE player_id = ? AND world_id = ? AND status = 'delivered' AND read = 0`,
      playerId,
      worldId,
    );
    return r ? Number(r.n) : 0;
  },
  countByPlayerWorldAndDay(playerId: string, worldId: string, day: number): number {
    const r = getDb().get<Row>(
      `SELECT COUNT(*) AS n FROM emails WHERE player_id = ? AND world_id = ? AND day_number = ?`,
      playerId,
      worldId,
      day,
    );
    return r ? Number(r.n) : 0;
  },
  insert(e: Email): Email {
    getDb().run(
      `INSERT INTO emails (id,player_id,world_id,sender_name,sender_handle,subject,body,status,read,day_number,scheduled_phase,delivered_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      e.id, e.playerId, e.worldId, e.senderName, e.senderHandle, e.subject, e.body, e.status, boolToInt(e.read),
      e.dayNumber, e.scheduledPhase, e.deliveredAt, e.createdAt,
    );
    return e;
  },
  update(e: Email): Email {
    getDb().run(
      `UPDATE emails SET status=?,read=?,delivered_at=? WHERE id=?`,
      e.status, boolToInt(e.read), e.deliveredAt, e.id,
    );
    return e;
  },
};

// --- character chronicles (cross-date history) ------------------------------

function rowToChronicle(r: Row): CharacterChronicle {
  return CharacterChronicleSchema.parse({
    characterId: r.character_id,
    playerId: r.player_id,
    chronicle: r.chronicle,
    recentLines: fromJson(r.recent_lines, []),
    sessionCount: Number(r.session_count),
    updatedAt: Number(r.updated_at),
  });
}

export const chroniclesRepo = {
  getByCharacter(characterId: string, playerId: string): CharacterChronicle | undefined {
    const r = getDb().get<Row>(
      'SELECT * FROM character_chronicles WHERE character_id = ? AND player_id = ?',
      characterId,
      playerId,
    );
    return r ? rowToChronicle(r) : undefined;
  },
  list(): CharacterChronicle[] {
    return getDb().all<Row>('SELECT * FROM character_chronicles').map(rowToChronicle);
  },
  insert(c: CharacterChronicle): CharacterChronicle {
    getDb().run(
      `INSERT INTO character_chronicles (character_id,player_id,chronicle,recent_lines,session_count,updated_at)
       VALUES (?,?,?,?,?,?)`,
      c.characterId, c.playerId, c.chronicle, j(c.recentLines), c.sessionCount, c.updatedAt,
    );
    return c;
  },
  update(c: CharacterChronicle): CharacterChronicle {
    getDb().run(
      `UPDATE character_chronicles SET chronicle=?,recent_lines=?,session_count=?,updated_at=? WHERE character_id=? AND player_id=?`,
      c.chronicle, j(c.recentLines), c.sessionCount, c.updatedAt, c.characterId, c.playerId,
    );
    return c;
  },
};

// --- character endings (the "happy ending" gallery) -------------------------

function rowToEnding(r: Row): CharacterEnding {
  return CharacterEndingSchema.parse({
    characterId: r.character_id,
    playerId: r.player_id,
    title: r.title,
    epilogue: r.epilogue,
    day: Number(r.day),
    createdAt: Number(r.created_at),
  });
}

export const endingsRepo = {
  getByCharacter(characterId: string, playerId: string): CharacterEnding | undefined {
    const r = getDb().get<Row>(
      'SELECT * FROM character_endings WHERE character_id = ? AND player_id = ?',
      characterId,
      playerId,
    );
    return r ? rowToEnding(r) : undefined;
  },
  list(): CharacterEnding[] {
    return getDb().all<Row>('SELECT * FROM character_endings ORDER BY created_at ASC').map(rowToEnding);
  },
  insert(e: CharacterEnding): CharacterEnding {
    getDb().run(
      `INSERT INTO character_endings (character_id,player_id,title,epilogue,day,created_at) VALUES (?,?,?,?,?,?)`,
      e.characterId, e.playerId, e.title, e.epilogue, e.day, e.createdAt,
    );
    return e;
  },
};

// --- day records (the almanac: one summary per world-day) -------------------

function rowToDayRecord(r: Row): DayRecord {
  return DayRecordSchema.parse({
    worldId: r.world_id,
    day: Number(r.day),
    headline: r.headline,
    narrative: r.narrative,
    highlights: fromJson(r.highlights, []),
    beats: fromJson(r.beats, []),
    income: Number(r.income),
    reconstructed: intToBool(r.reconstructed),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  });
}

export const dayRecordsRepo = {
  get(worldId: string, day: number): DayRecord | undefined {
    const r = getDb().get<Row>('SELECT * FROM day_records WHERE world_id = ? AND day = ?', worldId, day);
    return r ? rowToDayRecord(r) : undefined;
  },
  listByWorld(worldId: string): DayRecord[] {
    return getDb()
      .all<Row>('SELECT * FROM day_records WHERE world_id = ? ORDER BY day ASC', worldId)
      .map(rowToDayRecord);
  },
  /** The set of days that already have a record (for gap-filling backfill). */
  daysForWorld(worldId: string): Set<number> {
    return new Set(
      getDb().all<Row>('SELECT day FROM day_records WHERE world_id = ?', worldId).map((r) => Number(r.day)),
    );
  },
  list(): DayRecord[] {
    return getDb().all<Row>('SELECT * FROM day_records ORDER BY world_id, day ASC').map(rowToDayRecord);
  },
  /** Insert or replace the record for (world, day) — the day is the natural key. */
  upsert(rec: DayRecord): DayRecord {
    getDb().run(
      `INSERT INTO day_records (world_id,day,headline,narrative,highlights,beats,income,reconstructed,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(world_id,day) DO UPDATE SET
         headline=excluded.headline, narrative=excluded.narrative, highlights=excluded.highlights,
         beats=excluded.beats, income=excluded.income, reconstructed=excluded.reconstructed,
         updated_at=excluded.updated_at`,
      rec.worldId, rec.day, rec.headline, rec.narrative, j(rec.highlights), j(rec.beats),
      rec.income, boolToInt(rec.reconstructed), rec.createdAt, rec.updatedAt,
    );
    return rec;
  },
  insert(rec: DayRecord): DayRecord {
    return this.upsert(rec);
  },
};

// --- settings (key/value) ---------------------------------------------------

export const settingsRepo = {
  getRaw(key: string): string | undefined {
    const r = getDb().get<Row>('SELECT value FROM app_settings WHERE key = ?', key);
    return r ? String(r.value) : undefined;
  },
  set(key: string, value: string): void {
    getDb().run(
      `INSERT INTO app_settings (key,value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  },
};

// --- Faces: social feed (posts / comments / reactions / seen marker) --------

function rowToFeedPost(r: Row): FeedPost {
  return FeedPostSchema.parse({
    id: r.id,
    worldId: r.world_id,
    authorType: r.author_type,
    authorId: r.author_id,
    body: r.body,
    kind: r.kind,
    mood: r.mood,
    sourceEventId: nStr(r.source_event_id),
    dayNumber: nNum(r.day_number),
    phase: nStr(r.phase),
    createdAt: Number(r.created_at),
  });
}

export const feedPostsRepo = {
  get(id: string): FeedPost | undefined {
    const r = getDb().get<Row>('SELECT * FROM feed_posts WHERE id = ?', id);
    return r ? rowToFeedPost(r) : undefined;
  },
  listByWorld(worldId: string, limit = 100): FeedPost[] {
    return getDb()
      .all<Row>('SELECT * FROM feed_posts WHERE world_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', worldId, limit)
      .map(rowToFeedPost);
  },
  /** All posts (every world), oldest first — used for faithful export. */
  list(): FeedPost[] {
    return getDb().all<Row>('SELECT * FROM feed_posts ORDER BY created_at ASC, rowid ASC').map(rowToFeedPost);
  },
  /** A world's character-authored posts for ONE day, oldest first. Day-scoped (not
   *  a recency-limited slice) so NPC↔NPC engagement covers every post made that day,
   *  even on a high-volume day. */
  listCharacterPostsForDay(worldId: string, dayNumber: number): FeedPost[] {
    return getDb()
      .all<Row>(
        `SELECT * FROM feed_posts WHERE world_id = ? AND day_number = ? AND author_type = 'character'
         ORDER BY created_at ASC, rowid ASC`,
        worldId,
        dayNumber,
      )
      .map(rowToFeedPost);
  },
  /** True once an NPC has already posted about this (event, author) pair. */
  existsForEvent(sourceEventId: string, authorId: string): boolean {
    const r = getDb().get<Row>(
      'SELECT 1 AS n FROM feed_posts WHERE source_event_id = ? AND author_id = ? LIMIT 1',
      sourceEventId,
      authorId,
    );
    return !!r;
  },
  /** True if this author already made a post of `kind` on `dayNumber` (ambient idempotency). */
  existsForAuthorDayKind(worldId: string, authorId: string, dayNumber: number, kind: string): boolean {
    const r = getDb().get<Row>(
      'SELECT 1 AS n FROM feed_posts WHERE world_id = ? AND author_id = ? AND day_number = ? AND kind = ? LIMIT 1',
      worldId,
      authorId,
      dayNumber,
      kind,
    );
    return !!r;
  },
  /** Count of NPC posts in a world since a timestamp (for the unread badge). */
  countCharacterPostsSince(worldId: string, since: number): number {
    const r = getDb().get<Row>(
      `SELECT COUNT(*) AS n FROM feed_posts WHERE world_id = ? AND author_type = 'character' AND created_at > ?`,
      worldId,
      since,
    );
    return r ? Number(r.n) : 0;
  },
  /** Count of ambient NPC posts already made in a world on a day (per-day cap). */
  countAmbientForDay(worldId: string, dayNumber: number): number {
    const r = getDb().get<Row>(
      `SELECT COUNT(*) AS n FROM feed_posts WHERE world_id = ? AND day_number = ? AND kind = 'life'`,
      worldId,
      dayNumber,
    );
    return r ? Number(r.n) : 0;
  },
  insert(p: FeedPost): FeedPost {
    // ON CONFLICT guards event-driven idempotency (UNIQUE(source_event_id,author_id));
    // NULL source rows (player + ambient posts) are always distinct, so they insert freely.
    getDb().run(
      `INSERT INTO feed_posts (id,world_id,author_type,author_id,body,kind,mood,source_event_id,day_number,phase,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(source_event_id,author_id) DO NOTHING`,
      p.id, p.worldId, p.authorType, p.authorId, p.body, p.kind, p.mood, p.sourceEventId, p.dayNumber, p.phase, p.createdAt,
    );
    return p;
  },
};

function rowToFeedComment(r: Row): FeedComment {
  return FeedCommentSchema.parse({
    id: r.id,
    postId: r.post_id,
    authorType: r.author_type,
    authorId: r.author_id,
    body: r.body,
    tone: r.tone,
    createdAt: Number(r.created_at),
  });
}

export const feedCommentsRepo = {
  listByPost(postId: string): FeedComment[] {
    return getDb()
      .all<Row>('SELECT * FROM feed_comments WHERE post_id = ? ORDER BY created_at ASC, rowid ASC', postId)
      .map(rowToFeedComment);
  },
  /** All comments (every world), oldest first — used for faithful export. */
  list(): FeedComment[] {
    return getDb().all<Row>('SELECT * FROM feed_comments ORDER BY created_at ASC, rowid ASC').map(rowToFeedComment);
  },
  /** True once `authorId` has already commented on `postId` — keeps NPC↔NPC
   *  day-start commenting idempotent (one comment per character per post). */
  existsByAuthor(postId: string, authorId: string): boolean {
    const r = getDb().get<Row>(
      'SELECT 1 AS n FROM feed_comments WHERE post_id = ? AND author_id = ? LIMIT 1',
      postId,
      authorId,
    );
    return !!r;
  },
  /** Count of NPC comments in a world since a timestamp (for the unread badge). */
  countCharacterCommentsSince(worldId: string, since: number): number {
    const r = getDb().get<Row>(
      `SELECT COUNT(*) AS n FROM feed_comments fc JOIN feed_posts fp ON fp.id = fc.post_id
       WHERE fp.world_id = ? AND fc.author_type = 'character' AND fc.created_at > ?`,
      worldId,
      since,
    );
    return r ? Number(r.n) : 0;
  },
  insert(c: FeedComment): FeedComment {
    getDb().run(
      `INSERT INTO feed_comments (id,post_id,author_type,author_id,body,tone,created_at) VALUES (?,?,?,?,?,?,?)`,
      c.id, c.postId, c.authorType, c.authorId, c.body, c.tone, c.createdAt,
    );
    return c;
  },
};

function rowToFeedReaction(r: Row): FeedReaction {
  return FeedReactionSchema.parse({
    id: r.id,
    postId: r.post_id,
    actorType: r.actor_type,
    actorId: r.actor_id,
    kind: r.kind,
    createdAt: Number(r.created_at),
  });
}

export const feedReactionsRepo = {
  listByPost(postId: string): FeedReaction[] {
    return getDb()
      .all<Row>('SELECT * FROM feed_reactions WHERE post_id = ? ORDER BY created_at ASC, rowid ASC', postId)
      .map(rowToFeedReaction);
  },
  /** All reactions (every world), oldest first — used for faithful export. */
  list(): FeedReaction[] {
    return getDb().all<Row>('SELECT * FROM feed_reactions ORDER BY created_at ASC, rowid ASC').map(rowToFeedReaction);
  },
  getByActor(postId: string, actorId: string): FeedReaction | undefined {
    const r = getDb().get<Row>('SELECT * FROM feed_reactions WHERE post_id = ? AND actor_id = ?', postId, actorId);
    return r ? rowToFeedReaction(r) : undefined;
  },
  insert(x: FeedReaction): FeedReaction {
    // One reaction per (post, actor): re-reacting just changes the kind.
    getDb().run(
      `INSERT INTO feed_reactions (id,post_id,actor_type,actor_id,kind,created_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(post_id,actor_id) DO UPDATE SET kind = excluded.kind`,
      x.id, x.postId, x.actorType, x.actorId, x.kind, x.createdAt,
    );
    return x;
  },
  delete(postId: string, actorId: string): void {
    getDb().run('DELETE FROM feed_reactions WHERE post_id = ? AND actor_id = ?', postId, actorId);
  },
};

export const feedSeenRepo = {
  /** Epoch ms the player last opened Faces for this world (0 if never). */
  get(worldId: string, playerId: string): number {
    const r = getDb().get<Row>('SELECT seen_at FROM feed_seen WHERE world_id = ? AND player_id = ?', worldId, playerId);
    return r ? Number(r.seen_at) : 0;
  },
  set(worldId: string, playerId: string, seenAt: number): void {
    getDb().run(
      `INSERT INTO feed_seen (world_id,player_id,seen_at) VALUES (?,?,?)
       ON CONFLICT(world_id,player_id) DO UPDATE SET seen_at = excluded.seen_at`,
      worldId,
      playerId,
      seenAt,
    );
  },
};

// --- World-sim derived: NPC edges / knowledge / canon facts -----------------

/** Canonical pair order so (a,b) and (b,a) resolve to the same npc_edges row. */
export function npcPairKey(x: string, y: string): { aId: string; bId: string } {
  return x <= y ? { aId: x, bId: y } : { aId: y, bId: x };
}

function rowToNpcEdge(r: Row): NpcEdge {
  return NpcEdgeSchema.parse({
    worldId: r.world_id,
    aId: r.a_id,
    bId: r.b_id,
    warmth: Number(r.warmth),
    meetCount: Number(r.meet_count),
    lastDay: Number(r.last_day),
    promoted: Number(r.promoted) === 1,
  });
}

export const npcEdgesRepo = {
  get(worldId: string, x: string, y: string): NpcEdge | undefined {
    const { aId, bId } = npcPairKey(x, y);
    const r = getDb().get<Row>(
      'SELECT * FROM npc_edges WHERE world_id = ? AND a_id = ? AND b_id = ?',
      worldId,
      aId,
      bId,
    );
    return r ? rowToNpcEdge(r) : undefined;
  },
  listByWorld(worldId: string): NpcEdge[] {
    return getDb().all<Row>('SELECT * FROM npc_edges WHERE world_id = ? ORDER BY a_id, b_id', worldId).map(rowToNpcEdge);
  },
  /** All edges (every world) — used for faithful export. */
  list(): NpcEdge[] {
    return getDb().all<Row>('SELECT * FROM npc_edges ORDER BY world_id, a_id, b_id').map(rowToNpcEdge);
  },
  /** Insert or replace an edge; canonicalizes (a,b) order defensively. */
  upsert(e: NpcEdge): NpcEdge {
    const { aId, bId } = npcPairKey(e.aId, e.bId);
    getDb().run(
      `INSERT INTO npc_edges (world_id,a_id,b_id,warmth,meet_count,last_day,promoted)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(world_id,a_id,b_id) DO UPDATE SET
         warmth = excluded.warmth, meet_count = excluded.meet_count,
         last_day = excluded.last_day, promoted = excluded.promoted`,
      e.worldId, aId, bId, e.warmth, e.meetCount, e.lastDay, e.promoted ? 1 : 0,
    );
    return { ...e, aId, bId };
  },
};

function rowToNpcKnowledge(r: Row): NpcKnowledge {
  return NpcKnowledgeSchema.parse({
    id: r.id,
    worldId: r.world_id,
    knowerId: r.knower_id,
    subjectId: nStr(r.subject_id),
    topic: r.topic,
    claim: r.claim,
    fidelity: Number(r.fidelity),
    hops: Number(r.hops),
    sourceEventId: nStr(r.source_event_id),
    sourceCanonId: nStr(r.source_canon_id),
    sourceKnowerId: nStr(r.source_knower_id),
    day: Number(r.day),
    createdAt: Number(r.created_at),
  });
}

export const npcKnowledgeRepo = {
  listByKnower(knowerId: string, limit = 50): NpcKnowledge[] {
    return getDb()
      .all<Row>(
        'SELECT * FROM npc_knowledge WHERE knower_id = ? ORDER BY day DESC, created_at DESC LIMIT ?',
        knowerId,
        limit,
      )
      .map(rowToNpcKnowledge);
  },
  listBySubject(subjectId: string, limit = 50): NpcKnowledge[] {
    return getDb()
      .all<Row>(
        'SELECT * FROM npc_knowledge WHERE subject_id = ? ORDER BY day DESC, created_at DESC LIMIT ?',
        subjectId,
        limit,
      )
      .map(rowToNpcKnowledge);
  },
  /** All knowledge (every world) — used for faithful export. */
  list(): NpcKnowledge[] {
    return getDb().all<Row>('SELECT * FROM npc_knowledge ORDER BY created_at ASC, rowid ASC').map(rowToNpcKnowledge);
  },
  insert(k: NpcKnowledge): NpcKnowledge {
    // UNIQUE(knower_id,subject_id,topic,claim) dedups identical re-learned news.
    getDb().run(
      `INSERT INTO npc_knowledge (id,world_id,knower_id,subject_id,topic,claim,fidelity,hops,source_event_id,source_canon_id,source_knower_id,day,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(knower_id,subject_id,topic,claim) DO NOTHING`,
      k.id, k.worldId, k.knowerId, k.subjectId, k.topic, k.claim, k.fidelity, k.hops, k.sourceEventId, k.sourceCanonId, k.sourceKnowerId, k.day, k.createdAt,
    );
    return k;
  },
  /** A rejected canon fact's gossip residue goes stale (fidelity 0 → never surfaced). */
  markStaleByCanon(sourceCanonId: string): void {
    getDb().run('UPDATE npc_knowledge SET fidelity = 0 WHERE source_canon_id = ?', sourceCanonId);
  },
};

function rowToCanonFact(r: Row): CanonFact {
  return CanonFactSchema.parse({
    id: r.id,
    worldId: r.world_id,
    subjectId: r.subject_id,
    category: r.category,
    value: r.value,
    sensitivity: r.sensitivity,
    sourceSessionId: nStr(r.source_session_id),
    sourceEventId: nStr(r.source_event_id),
    sourceCharId: nStr(r.source_char_id),
    day: Number(r.day),
    status: r.status,
    createdAt: Number(r.created_at),
  });
}

export const canonFactsRepo = {
  listBySubject(subjectId: string, opts: { status?: CanonFactStatus } = {}): CanonFact[] {
    if (opts.status) {
      return getDb()
        .all<Row>(
          'SELECT * FROM canon_facts WHERE subject_id = ? AND status = ? ORDER BY day DESC, created_at DESC',
          subjectId,
          opts.status,
        )
        .map(rowToCanonFact);
    }
    return getDb()
      .all<Row>('SELECT * FROM canon_facts WHERE subject_id = ? ORDER BY day DESC, created_at DESC', subjectId)
      .map(rowToCanonFact);
  },
  /** All facts (every world) — used for faithful export. */
  list(): CanonFact[] {
    return getDb().all<Row>('SELECT * FROM canon_facts ORDER BY created_at ASC, rowid ASC').map(rowToCanonFact);
  },
  insert(f: CanonFact): CanonFact {
    // UNIQUE(subject_id,category,value) dedups the same fact stated twice.
    getDb().run(
      `INSERT INTO canon_facts (id,world_id,subject_id,category,value,sensitivity,source_session_id,source_event_id,source_char_id,day,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(subject_id,category,value) DO NOTHING`,
      f.id, f.worldId, f.subjectId, f.category, f.value, f.sensitivity, f.sourceSessionId, f.sourceEventId, f.sourceCharId, f.day, f.status, f.createdAt,
    );
    return f;
  },
  /** Reverse a canonization — reversible by design (status, not a hard delete). */
  reject(id: string): void {
    getDb().run("UPDATE canon_facts SET status = 'rejected' WHERE id = ?", id);
  },
};

// --- Wealth: properties + ownership -----------------------------------------

function rowToProperty(r: Row): Property {
  return PropertySchema.parse({
    id: r.id,
    worldId: r.world_id,
    name: r.name,
    description: r.description,
    category: r.category,
    buyPrice: Number(r.buy_price),
    rentAmount: Number(r.rent_amount ?? 0),
    rentCadence: r.rent_cadence ?? 'weekly',
    indoor: intToBool(r.indoor),
    tags: fromJson(r.tags, []),
    buffStat: nStr(r.buff_stat),
    buffAmount: Number(r.buff_amount),
    assetId: nStr(r.asset_id),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  });
}

export const propertiesRepo = {
  get(id: string): Property | undefined {
    const r = getDb().get<Row>('SELECT * FROM properties WHERE id = ?', id);
    return r ? rowToProperty(r) : undefined;
  },
  listByWorld(worldId: string): Property[] {
    return getDb()
      .all<Row>('SELECT * FROM properties WHERE world_id = ? ORDER BY buy_price ASC, created_at ASC', worldId)
      .map(rowToProperty);
  },
  /** All properties (every world) — used for faithful export. */
  list(): Property[] {
    return getDb().all<Row>('SELECT * FROM properties ORDER BY created_at ASC').map(rowToProperty);
  },
  insert(p: Property): Property {
    getDb().run(
      `INSERT INTO properties (id,world_id,name,description,category,buy_price,rent_amount,rent_cadence,indoor,tags,buff_stat,buff_amount,asset_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      p.id, p.worldId, p.name, p.description, p.category, p.buyPrice, p.rentAmount, p.rentCadence, boolToInt(p.indoor),
      j(p.tags), p.buffStat, p.buffAmount, p.assetId, p.createdAt, p.updatedAt,
    );
    return p;
  },
  update(p: Property): Property {
    getDb().run(
      `UPDATE properties SET name=?,description=?,category=?,buy_price=?,rent_amount=?,rent_cadence=?,indoor=?,tags=?,buff_stat=?,buff_amount=?,asset_id=?,updated_at=? WHERE id=?`,
      p.name, p.description, p.category, p.buyPrice, p.rentAmount, p.rentCadence, boolToInt(p.indoor),
      j(p.tags), p.buffStat, p.buffAmount, p.assetId, p.updatedAt, p.id,
    );
    return p;
  },
  delete(id: string): void {
    getDb().run('DELETE FROM properties WHERE id = ?', id);
  },
};

function rowToOwnership(r: Row): PropertyOwnership {
  return PropertyOwnershipSchema.parse({
    id: r.id,
    worldId: r.world_id,
    playerId: r.player_id,
    propertyId: r.property_id,
    purchasePrice: Number(r.purchase_price),
    acquiredAt: Number(r.acquired_at),
  });
}

export const propertyOwnershipRepo = {
  getByPlayerAndProperty(worldId: string, playerId: string, propertyId: string): PropertyOwnership | undefined {
    const r = getDb().get<Row>(
      'SELECT * FROM property_ownership WHERE world_id = ? AND player_id = ? AND property_id = ?',
      worldId,
      playerId,
      propertyId,
    );
    return r ? rowToOwnership(r) : undefined;
  },
  listByPlayer(worldId: string, playerId: string): PropertyOwnership[] {
    return getDb()
      .all<Row>(
        'SELECT * FROM property_ownership WHERE world_id = ? AND player_id = ? ORDER BY acquired_at ASC',
        worldId,
        playerId,
      )
      .map(rowToOwnership);
  },
  /** All ownership rows (every world) — used for faithful export. */
  list(): PropertyOwnership[] {
    return getDb().all<Row>('SELECT * FROM property_ownership ORDER BY acquired_at ASC').map(rowToOwnership);
  },
  insert(o: PropertyOwnership): PropertyOwnership {
    getDb().run(
      `INSERT INTO property_ownership (id,world_id,player_id,property_id,purchase_price,acquired_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(world_id,player_id,property_id) DO NOTHING`,
      o.id, o.worldId, o.playerId, o.propertyId, o.purchasePrice, o.acquiredAt,
    );
    return o;
  },
  delete(worldId: string, playerId: string, propertyId: string): void {
    getDb().run(
      'DELETE FROM property_ownership WHERE world_id = ? AND player_id = ? AND property_id = ?',
      worldId,
      playerId,
      propertyId,
    );
  },
};

function rowToLease(r: Row): PropertyLease {
  return PropertyLeaseSchema.parse({
    id: r.id,
    worldId: r.world_id,
    playerId: r.player_id,
    propertyId: r.property_id,
    nextDueDay: Number(r.next_due_day),
    status: r.status,
    graceUntilDay: nNum(r.grace_until_day),
    startedAt: Number(r.started_at),
  });
}

export const propertyLeasesRepo = {
  getByPlayerAndProperty(worldId: string, playerId: string, propertyId: string): PropertyLease | undefined {
    const r = getDb().get<Row>(
      'SELECT * FROM property_leases WHERE world_id = ? AND player_id = ? AND property_id = ?',
      worldId,
      playerId,
      propertyId,
    );
    return r ? rowToLease(r) : undefined;
  },
  listByPlayer(worldId: string, playerId: string): PropertyLease[] {
    return getDb()
      .all<Row>('SELECT * FROM property_leases WHERE world_id = ? AND player_id = ? ORDER BY started_at ASC', worldId, playerId)
      .map(rowToLease);
  },
  /** True if ANY player holds a lease on this property (guards rent→0 edits). */
  anyForProperty(propertyId: string): boolean {
    return getDb().get<Row>('SELECT 1 AS n FROM property_leases WHERE property_id = ? LIMIT 1', propertyId) != null;
  },
  /** All leases (every world) — used for faithful export. */
  list(): PropertyLease[] {
    return getDb().all<Row>('SELECT * FROM property_leases ORDER BY started_at ASC').map(rowToLease);
  },
  upsert(l: PropertyLease): PropertyLease {
    getDb().run(
      `INSERT INTO property_leases (id,world_id,player_id,property_id,next_due_day,status,grace_until_day,started_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(world_id,player_id,property_id) DO UPDATE SET
         next_due_day = excluded.next_due_day, status = excluded.status, grace_until_day = excluded.grace_until_day`,
      l.id, l.worldId, l.playerId, l.propertyId, l.nextDueDay, l.status, l.graceUntilDay, l.startedAt,
    );
    return l;
  },
  delete(worldId: string, playerId: string, propertyId: string): void {
    getDb().run(
      'DELETE FROM property_leases WHERE world_id = ? AND player_id = ? AND property_id = ?',
      worldId,
      playerId,
      propertyId,
    );
  },
};

function rowToNotice(r: Row): LandlordNotice {
  return LandlordNoticeSchema.parse({
    id: r.id,
    worldId: r.world_id,
    playerId: r.player_id,
    propertyId: r.property_id,
    kind: r.kind,
    body: r.body,
    dayNumber: Number(r.day_number),
    read: intToBool(r.read),
    createdAt: Number(r.created_at),
  });
}

export const landlordNoticesRepo = {
  listByPlayer(worldId: string, playerId: string): LandlordNotice[] {
    return getDb()
      .all<Row>('SELECT * FROM landlord_notices WHERE world_id = ? AND player_id = ? ORDER BY created_at ASC, rowid ASC', worldId, playerId)
      .map(rowToNotice);
  },
  countUnread(worldId: string, playerId: string): number {
    const r = getDb().get<Row>(
      'SELECT COUNT(*) AS n FROM landlord_notices WHERE world_id = ? AND player_id = ? AND read = 0',
      worldId,
      playerId,
    );
    return r ? Number(r.n) : 0;
  },
  markAllRead(worldId: string, playerId: string): void {
    getDb().run('UPDATE landlord_notices SET read = 1 WHERE world_id = ? AND player_id = ?', worldId, playerId);
  },
  /** Clear a deleted property's notices (no FK on property_id → cleaned in code). */
  deleteByProperty(propertyId: string): void {
    getDb().run('DELETE FROM landlord_notices WHERE property_id = ?', propertyId);
  },
  /** All notices (every world) — used for faithful export. */
  list(): LandlordNotice[] {
    return getDb().all<Row>('SELECT * FROM landlord_notices ORDER BY created_at ASC, rowid ASC').map(rowToNotice);
  },
  insert(n: LandlordNotice): LandlordNotice {
    getDb().run(
      `INSERT INTO landlord_notices (id,world_id,player_id,property_id,kind,body,day_number,read,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      n.id, n.worldId, n.playerId, n.propertyId, n.kind, n.body, n.dayNumber, boolToInt(n.read), n.createdAt,
    );
    return n;
  },
};

// --- Wealth: companies + holdings + prices + news ---------------------------

function rowToCompany(r: Row): Company {
  return CompanySchema.parse({
    id: r.id,
    worldId: r.world_id,
    name: r.name,
    ticker: r.ticker,
    description: r.description,
    sector: r.sector,
    basePrice: Number(r.base_price),
    volatility: Number(r.volatility),
    dividendPerShare: Number(r.dividend_per_share),
    linkedCharacterId: nStr(r.linked_character_id),
    assetId: nStr(r.asset_id),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  });
}

export const companiesRepo = {
  get(id: string): Company | undefined {
    const r = getDb().get<Row>('SELECT * FROM companies WHERE id = ?', id);
    return r ? rowToCompany(r) : undefined;
  },
  listByWorld(worldId: string): Company[] {
    return getDb()
      .all<Row>('SELECT * FROM companies WHERE world_id = ? ORDER BY name ASC', worldId)
      .map(rowToCompany);
  },
  /** All companies (every world) — used for faithful export. */
  list(): Company[] {
    return getDb().all<Row>('SELECT * FROM companies ORDER BY created_at ASC').map(rowToCompany);
  },
  insert(c: Company): Company {
    getDb().run(
      `INSERT INTO companies (id,world_id,name,ticker,description,sector,base_price,volatility,dividend_per_share,linked_character_id,asset_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      c.id, c.worldId, c.name, c.ticker, c.description, c.sector, c.basePrice, c.volatility, c.dividendPerShare,
      c.linkedCharacterId, c.assetId, c.createdAt, c.updatedAt,
    );
    return c;
  },
  update(c: Company): Company {
    getDb().run(
      `UPDATE companies SET name=?,ticker=?,description=?,sector=?,base_price=?,volatility=?,dividend_per_share=?,linked_character_id=?,asset_id=?,updated_at=? WHERE id=?`,
      c.name, c.ticker, c.description, c.sector, c.basePrice, c.volatility, c.dividendPerShare,
      c.linkedCharacterId, c.assetId, c.updatedAt, c.id,
    );
    return c;
  },
  delete(id: string): void {
    getDb().run('DELETE FROM companies WHERE id = ?', id);
  },
};

function rowToHolding(r: Row): StockHolding {
  return StockHoldingSchema.parse({
    id: r.id,
    worldId: r.world_id,
    playerId: r.player_id,
    companyId: r.company_id,
    shares: Number(r.shares),
    costBasis: Number(r.cost_basis),
    acquiredDay: Number(r.acquired_day ?? 0),
    updatedAt: Number(r.updated_at),
  });
}

export const stockHoldingsRepo = {
  getPosition(worldId: string, playerId: string, companyId: string): StockHolding | undefined {
    const r = getDb().get<Row>(
      'SELECT * FROM stock_holdings WHERE world_id = ? AND player_id = ? AND company_id = ?',
      worldId,
      playerId,
      companyId,
    );
    return r ? rowToHolding(r) : undefined;
  },
  listByPlayer(worldId: string, playerId: string): StockHolding[] {
    return getDb()
      .all<Row>(
        'SELECT * FROM stock_holdings WHERE world_id = ? AND player_id = ? AND shares > 0 ORDER BY updated_at DESC',
        worldId,
        playerId,
      )
      .map(rowToHolding);
  },
  /** All holdings (every world) — used for faithful export. */
  list(): StockHolding[] {
    return getDb().all<Row>('SELECT * FROM stock_holdings ORDER BY updated_at ASC').map(rowToHolding);
  },
  upsert(h: StockHolding): StockHolding {
    getDb().run(
      `INSERT INTO stock_holdings (id,world_id,player_id,company_id,shares,cost_basis,acquired_day,updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(world_id,player_id,company_id) DO UPDATE SET
         shares = excluded.shares, cost_basis = excluded.cost_basis,
         acquired_day = excluded.acquired_day, updated_at = excluded.updated_at`,
      h.id, h.worldId, h.playerId, h.companyId, h.shares, h.costBasis, h.acquiredDay, h.updatedAt,
    );
    return h;
  },
  delete(worldId: string, playerId: string, companyId: string): void {
    getDb().run(
      'DELETE FROM stock_holdings WHERE world_id = ? AND player_id = ? AND company_id = ?',
      worldId,
      playerId,
      companyId,
    );
  },
};

function rowToStockPrice(r: Row): StockPrice {
  return StockPriceSchema.parse({
    worldId: r.world_id,
    companyId: r.company_id,
    day: Number(r.day),
    price: Number(r.price),
    createdAt: Number(r.created_at),
  });
}

export const stockPricesRepo = {
  getForDay(worldId: string, companyId: string, day: number): StockPrice | undefined {
    const r = getDb().get<Row>(
      'SELECT * FROM stock_prices WHERE world_id = ? AND company_id = ? AND day = ?',
      worldId,
      companyId,
      day,
    );
    return r ? rowToStockPrice(r) : undefined;
  },
  /** The most recent priced day for a company on/before `day` (null if never priced). */
  latestUpTo(worldId: string, companyId: string, day: number): StockPrice | undefined {
    const r = getDb().get<Row>(
      'SELECT * FROM stock_prices WHERE world_id = ? AND company_id = ? AND day <= ? ORDER BY day DESC LIMIT 1',
      worldId,
      companyId,
      day,
    );
    return r ? rowToStockPrice(r) : undefined;
  },
  /** All prices in a world (every company/day) — used for faithful export. */
  listByWorld(worldId: string): StockPrice[] {
    return getDb()
      .all<Row>('SELECT * FROM stock_prices WHERE world_id = ? ORDER BY company_id, day ASC', worldId)
      .map(rowToStockPrice);
  },
  list(): StockPrice[] {
    return getDb().all<Row>('SELECT * FROM stock_prices ORDER BY world_id, company_id, day ASC').map(rowToStockPrice);
  },
  upsert(p: StockPrice): StockPrice {
    getDb().run(
      `INSERT INTO stock_prices (world_id,company_id,day,price,created_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(world_id,company_id,day) DO UPDATE SET price = excluded.price`,
      p.worldId, p.companyId, p.day, p.price, p.createdAt,
    );
    return p;
  },
};

function rowToMarketNews(r: Row): MarketNews {
  return MarketNewsSchema.parse({
    id: r.id,
    worldId: r.world_id,
    day: Number(r.day),
    companyId: nStr(r.company_id),
    ticker: r.ticker,
    headline: r.headline,
    body: r.body,
    sentiment: r.sentiment,
    createdAt: Number(r.created_at),
  });
}

export const marketNewsRepo = {
  listForDay(worldId: string, day: number): MarketNews[] {
    return getDb()
      .all<Row>('SELECT * FROM market_news WHERE world_id = ? AND day = ? ORDER BY created_at ASC', worldId, day)
      .map(rowToMarketNews);
  },
  listRecent(worldId: string, limit = 20): MarketNews[] {
    return getDb()
      .all<Row>('SELECT * FROM market_news WHERE world_id = ? ORDER BY day DESC, created_at DESC LIMIT ?', worldId, limit)
      .map(rowToMarketNews);
  },
  /** Whether any news already exists for (world, day) — per-day generation idempotency. */
  existsForDay(worldId: string, day: number): boolean {
    const r = getDb().get<Row>('SELECT 1 AS n FROM market_news WHERE world_id = ? AND day = ? LIMIT 1', worldId, day);
    return !!r;
  },
  /** All news (every world) — used for faithful export. */
  list(): MarketNews[] {
    return getDb().all<Row>('SELECT * FROM market_news ORDER BY created_at ASC').map(rowToMarketNews);
  },
  insert(n: MarketNews): MarketNews {
    getDb().run(
      `INSERT INTO market_news (id,world_id,day,company_id,ticker,headline,body,sentiment,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      n.id, n.worldId, n.day, n.companyId, n.ticker, n.headline, n.body, n.sentiment, n.createdAt,
    );
    return n;
  },
};

// --- Gambling ---------------------------------------------------------------

function rowToGamblingRound(r: Row): GamblingRound {
  return GamblingRoundSchema.parse({
    id: r.id,
    worldId: r.world_id,
    playerId: r.player_id,
    game: r.game,
    status: r.status,
    bet: Number(r.bet),
    payout: Number(r.payout),
    outcome: r.outcome,
    state: fromJson(r.state, {}),
    day: Number(r.day),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  });
}

export const gamblingRoundsRepo = {
  get(id: string): GamblingRound | undefined {
    const r = getDb().get<Row>('SELECT * FROM gambling_rounds WHERE id = ?', id);
    return r ? rowToGamblingRound(r) : undefined;
  },
  /** The player's currently-active interactive hand, if any (newest wins). */
  getActive(worldId: string, playerId: string): GamblingRound | undefined {
    const r = getDb().get<Row>(
      "SELECT * FROM gambling_rounds WHERE world_id = ? AND player_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
      worldId,
      playerId,
    );
    return r ? rowToGamblingRound(r) : undefined;
  },
  /** Total money wagered by a player on a given in-world day (drives the daily cap). */
  wageredOn(worldId: string, playerId: string, day: number): number {
    const r = getDb().get<Row>(
      'SELECT COALESCE(SUM(bet),0) AS n FROM gambling_rounds WHERE world_id = ? AND player_id = ? AND day = ?',
      worldId,
      playerId,
      day,
    );
    return r ? Number(r.n) : 0;
  },
  /** Recent settled rounds for the in-app history strip. */
  listRecent(worldId: string, playerId: string, limit = 12): GamblingRound[] {
    return getDb()
      .all<Row>(
        "SELECT * FROM gambling_rounds WHERE world_id = ? AND player_id = ? AND status = 'settled' ORDER BY created_at DESC LIMIT ?",
        worldId,
        playerId,
        limit,
      )
      .map(rowToGamblingRound);
  },
  /** All rounds (every world) — used for faithful export. */
  list(): GamblingRound[] {
    return getDb().all<Row>('SELECT * FROM gambling_rounds ORDER BY created_at ASC').map(rowToGamblingRound);
  },
  upsert(g: GamblingRound): GamblingRound {
    getDb().run(
      `INSERT INTO gambling_rounds (id,world_id,player_id,game,status,bet,payout,outcome,state,day,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status, bet = excluded.bet, payout = excluded.payout,
         outcome = excluded.outcome, state = excluded.state, updated_at = excluded.updated_at`,
      g.id, g.worldId, g.playerId, g.game, g.status, g.bet, g.payout, g.outcome, j(g.state), g.day, g.createdAt, g.updatedAt,
    );
    return g;
  },
  delete(id: string): void {
    getDb().run('DELETE FROM gambling_rounds WHERE id = ?', id);
  },
};

/** Durable live-date rapport (0..100) keyed by session — the persistent fallback
 *  behind the rapport-service's in-memory cache, so a resumed date keeps its vibe. */
export const sessionRapportRepo = {
  get(sessionId: string): number | undefined {
    const r = getDb().get<Row>('SELECT rapport FROM session_rapport WHERE session_id = ?', sessionId);
    return r ? Number(r.rapport) : undefined;
  },
  upsert(sessionId: string, rapport: number, updatedAt: number): void {
    getDb().run(
      `INSERT INTO session_rapport (session_id,rapport,updated_at) VALUES (?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET rapport = excluded.rapport, updated_at = excluded.updated_at`,
      sessionId, rapport, updatedAt,
    );
  },
  delete(sessionId: string): void {
    getDb().run('DELETE FROM session_rapport WHERE session_id = ?', sessionId);
  },
};
