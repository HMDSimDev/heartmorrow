/**
 * Database schema. Created idempotently on startup with `CREATE TABLE IF NOT
 * EXISTS`, so opening an existing database is a no-op. Booleans are stored as
 * INTEGER (0/1); arrays and objects are stored as JSON TEXT and decoded by the
 * repository layer.
 */
export const SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worlds (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  tone          TEXT NOT NULL DEFAULT '',
  global_notes  TEXT NOT NULL DEFAULT '',
  locations     TEXT NOT NULL DEFAULT '[]',
  rules         TEXT NOT NULL DEFAULT '',
  lore          TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS world_notes (
  id         TEXT PRIMARY KEY,
  world_id   TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '[]',
  scope      TEXT NOT NULL DEFAULT 'global',
  importance INTEGER NOT NULL DEFAULT 3,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_world_notes_world ON world_notes(world_id);

CREATE TABLE IF NOT EXISTS characters (
  id                       TEXT PRIMARY KEY,
  world_id                 TEXT REFERENCES worlds(id) ON DELETE SET NULL,
  name                     TEXT NOT NULL,
  age                      INTEGER NOT NULL,
  pronouns                 TEXT NOT NULL DEFAULT 'they/them',
  short_description        TEXT NOT NULL DEFAULT '',
  personality              TEXT NOT NULL DEFAULT '',
  creator_notes            TEXT NOT NULL DEFAULT '',
  speech_style             TEXT NOT NULL DEFAULT '',
  likes                    TEXT NOT NULL DEFAULT '[]',
  dislikes                 TEXT NOT NULL DEFAULT '[]',
  boundaries               TEXT NOT NULL DEFAULT '[]',
  goals                    TEXT NOT NULL DEFAULT '[]',
  relationship_preferences TEXT NOT NULL DEFAULT '',
  dating_stats             TEXT NOT NULL,
  portrait_asset_id        TEXT,
  expression_assets        TEXT NOT NULL DEFAULT '{}',
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_characters_world ON characters(world_id);

CREATE TABLE IF NOT EXISTS character_memories (
  id             TEXT PRIMARY KEY,
  character_id   TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  text           TEXT NOT NULL,
  importance     INTEGER NOT NULL DEFAULT 3,
  tags           TEXT NOT NULL DEFAULT '[]',
  source_event_id TEXT,
  created_at     INTEGER NOT NULL,
  last_used_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memories_character ON character_memories(character_id);

CREATE TABLE IF NOT EXISTS relationships (
  id           TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  player_id    TEXT NOT NULL,
  affection    INTEGER NOT NULL DEFAULT 5,
  trust        INTEGER NOT NULL DEFAULT 5,
  chemistry    INTEGER NOT NULL DEFAULT 5,
  comfort      INTEGER NOT NULL DEFAULT 5,
  respect      INTEGER NOT NULL DEFAULT 5,
  curiosity    INTEGER NOT NULL DEFAULT 10,
  tension      INTEGER NOT NULL DEFAULT 0,
  flags        TEXT NOT NULL DEFAULT '{}',
  updated_at   INTEGER NOT NULL,
  UNIQUE(character_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_relationships_character ON relationships(character_id);

CREATE TABLE IF NOT EXISTS players (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT 'Player',
  pronouns     TEXT NOT NULL DEFAULT 'they/them',
  persona_notes TEXT NOT NULL DEFAULT '',
  money        INTEGER NOT NULL DEFAULT 0,
  career       TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  path       TEXT NOT NULL,
  filename   TEXT NOT NULL,
  mime_type  TEXT NOT NULL,
  alt_text   TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '[]',
  metadata   TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_sessions (
  id           TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  location_id  TEXT,
  mode         TEXT NOT NULL DEFAULT 'chat',
  summary      TEXT NOT NULL DEFAULT '',
  ended        INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_character ON conversation_sessions(character_id);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  metadata   TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

CREATE TABLE IF NOT EXISTS shop_items (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  price          INTEGER NOT NULL DEFAULT 0,
  category       TEXT NOT NULL DEFAULT 'gift',
  rarity         TEXT NOT NULL DEFAULT 'common',
  effects        TEXT NOT NULL DEFAULT '[]',
  infinite_stock INTEGER NOT NULL DEFAULT 1,
  stock          INTEGER NOT NULL DEFAULT 0,
  asset_id       TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id           TEXT PRIMARY KEY,
  player_id    TEXT NOT NULL,
  shop_item_id TEXT NOT NULL REFERENCES shop_items(id) ON DELETE CASCADE,
  quantity     INTEGER NOT NULL DEFAULT 0,
  acquired_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inventory_player ON inventory_items(player_id);

CREATE TABLE IF NOT EXISTS minigame_results (
  id           TEXT PRIMARY KEY,
  minigame_id  TEXT NOT NULL,
  character_id TEXT,
  score        REAL NOT NULL,
  grade        TEXT NOT NULL,
  reward       TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS game_events (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_type ON game_events(type);
CREATE INDEX IF NOT EXISTS idx_events_created ON game_events(created_at);

CREATE TABLE IF NOT EXISTS world_states (
  world_id        TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  day             INTEGER NOT NULL DEFAULT 1,
  phase           TEXT NOT NULL DEFAULT 'morning',
  stamina         INTEGER NOT NULL DEFAULT 3,
  stamina_max     INTEGER NOT NULL DEFAULT 3,
  actions_today   INTEGER NOT NULL DEFAULT 0,
  last_recap_day  INTEGER NOT NULL DEFAULT 0,
  day_started_at  INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS message_threads (
  id              TEXT PRIMARY KEY,
  character_id    TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  player_id       TEXT NOT NULL,
  last_message_at INTEGER,
  unread_count    INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(character_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_threads_character ON message_threads(character_id);

CREATE TABLE IF NOT EXISTS text_messages (
  id              TEXT PRIMARY KEY,
  thread_id       TEXT NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
  sender          TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'delivered',
  day_number      INTEGER,
  scheduled_phase TEXT,
  attachment      TEXT,
  image_asset_id  TEXT,
  delivered_at    INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_text_messages_thread ON text_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_text_messages_status ON text_messages(status);

CREATE TABLE IF NOT EXISTS emails (
  id              TEXT PRIMARY KEY,
  player_id       TEXT NOT NULL,
  sender_name     TEXT NOT NULL,
  sender_handle   TEXT NOT NULL,
  subject         TEXT NOT NULL DEFAULT '',
  body            TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'delivered',
  read            INTEGER NOT NULL DEFAULT 0,
  day_number      INTEGER,
  scheduled_phase TEXT,
  delivered_at    INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_player ON emails(player_id);
CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status);

CREATE TABLE IF NOT EXISTS character_chronicles (
  character_id  TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  player_id     TEXT NOT NULL,
  chronicle     TEXT NOT NULL DEFAULT '',
  recent_lines  TEXT NOT NULL DEFAULT '[]',
  session_count INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (character_id, player_id)
);

CREATE TABLE IF NOT EXISTS character_endings (
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  player_id    TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  epilogue     TEXT NOT NULL DEFAULT '',
  day          INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (character_id, player_id)
);

-- The almanac: one persisted summary per world-day (headline/narrative/beats).
-- Written live when a day ends, or lazily reconstructed from game_events for days
-- that elapsed before this table existed. Cascades + is wiped with the world.
CREATE TABLE IF NOT EXISTS day_records (
  world_id      TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  day           INTEGER NOT NULL,
  headline      TEXT NOT NULL DEFAULT '',
  narrative     TEXT NOT NULL DEFAULT '',
  highlights    TEXT NOT NULL DEFAULT '[]',
  beats         TEXT NOT NULL DEFAULT '[]',
  income        INTEGER NOT NULL DEFAULT 0,
  reconstructed INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (world_id, day)
);
CREATE INDEX IF NOT EXISTS idx_day_records_world ON day_records(world_id, day);

CREATE TABLE IF NOT EXISTS feed_posts (
  id              TEXT PRIMARY KEY,
  world_id        TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  author_type     TEXT NOT NULL,
  author_id       TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  kind            TEXT NOT NULL DEFAULT 'status',
  mood            TEXT NOT NULL DEFAULT '',
  source_event_id TEXT,
  day_number      INTEGER,
  phase           TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE(source_event_id, author_id)
);
CREATE INDEX IF NOT EXISTS idx_feed_posts_world ON feed_posts(world_id, created_at);

CREATE TABLE IF NOT EXISTS feed_comments (
  id          TEXT PRIMARY KEY,
  post_id     TEXT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL,
  author_id   TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  tone        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_comments_post ON feed_comments(post_id, created_at);

CREATE TABLE IF NOT EXISTS feed_reactions (
  id          TEXT PRIMARY KEY,
  post_id     TEXT NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  actor_type  TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'like',
  created_at  INTEGER NOT NULL,
  UNIQUE(post_id, actor_id)
);
CREATE INDEX IF NOT EXISTS idx_feed_reactions_post ON feed_reactions(post_id);

CREATE TABLE IF NOT EXISTS feed_seen (
  world_id  TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  seen_at   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, player_id)
);

-- World simulation: DERIVED NPC life. world_id cascades with the world; character
-- ids carry NO foreign key (some columns hold the player id, and import prunes
-- orphans in app code rather than throwing). Wiped by resetProgress.
CREATE TABLE IF NOT EXISTS npc_edges (
  world_id   TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  a_id       TEXT NOT NULL,
  b_id       TEXT NOT NULL,
  warmth     INTEGER NOT NULL DEFAULT 0,
  meet_count INTEGER NOT NULL DEFAULT 0,
  last_day   INTEGER NOT NULL DEFAULT 0,
  promoted   INTEGER NOT NULL DEFAULT 0,
  romance_state TEXT NOT NULL DEFAULT 'none',
  romance_since INTEGER NOT NULL DEFAULT 0,
  soured     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (world_id, a_id, b_id)
);
CREATE INDEX IF NOT EXISTS idx_npc_edges_world ON npc_edges(world_id);

CREATE TABLE IF NOT EXISTS npc_knowledge (
  id              TEXT PRIMARY KEY,
  world_id        TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  knower_id       TEXT NOT NULL,
  subject_id      TEXT,
  topic           TEXT NOT NULL,
  claim           TEXT NOT NULL,
  fidelity        INTEGER NOT NULL DEFAULT 100,
  hops            INTEGER NOT NULL DEFAULT 0,
  source_event_id TEXT,
  source_canon_id TEXT,
  day             INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  UNIQUE(knower_id, subject_id, topic, claim)
);
CREATE INDEX IF NOT EXISTS idx_npc_knowledge_knower ON npc_knowledge(knower_id);
CREATE INDEX IF NOT EXISTS idx_npc_knowledge_world ON npc_knowledge(world_id);

CREATE TABLE IF NOT EXISTS canon_facts (
  id                TEXT PRIMARY KEY,
  world_id          TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  subject_id        TEXT NOT NULL,
  category          TEXT NOT NULL,
  value             TEXT NOT NULL,
  sensitivity       TEXT NOT NULL DEFAULT 'neutral',
  source_session_id TEXT,
  source_event_id   TEXT,
  source_char_id    TEXT,
  day               INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'active',
  created_at        INTEGER NOT NULL,
  UNIQUE(subject_id, category, value)
);
CREATE INDEX IF NOT EXISTS idx_canon_facts_subject ON canon_facts(subject_id);
CREATE INDEX IF NOT EXISTS idx_canon_facts_world ON canon_facts(world_id);

-- Wealth: AUTHORED properties (per world). Cascades + wiped with the world; the
-- definitions survive a progress-reset (only ownership is playthrough state).
CREATE TABLE IF NOT EXISTS properties (
  id           TEXT PRIMARY KEY,
  world_id     TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT 'residence',
  buy_price    INTEGER NOT NULL DEFAULT 0,
  rent_amount  INTEGER NOT NULL DEFAULT 0,
  rent_cadence TEXT NOT NULL DEFAULT 'weekly',
  indoor       INTEGER NOT NULL DEFAULT 1,
  tags         TEXT NOT NULL DEFAULT '[]',
  buff_stat    TEXT,
  buff_amount  INTEGER NOT NULL DEFAULT 0,
  asset_id     TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_properties_world ON properties(world_id);

-- Wealth: a player's active LEASE on a property (recurring rent; eviction on default).
CREATE TABLE IF NOT EXISTS property_leases (
  id              TEXT PRIMARY KEY,
  world_id        TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  player_id       TEXT NOT NULL,
  property_id     TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  next_due_day    INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  grace_until_day INTEGER,
  started_at      INTEGER NOT NULL,
  UNIQUE(world_id, player_id, property_id)
);
CREATE INDEX IF NOT EXISTS idx_property_leases_world ON property_leases(world_id, player_id);

-- Wealth: urgent landlord notices (overdue / eviction) — a non-character text channel.
CREATE TABLE IF NOT EXISTS landlord_notices (
  id          TEXT PRIMARY KEY,
  world_id    TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  player_id   TEXT NOT NULL,
  property_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  body        TEXT NOT NULL,
  day_number  INTEGER NOT NULL DEFAULT 0,
  read        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_landlord_notices_world ON landlord_notices(world_id, player_id);

-- Wealth: player property ownership (playthrough state; player_id = player:<worldId>).
CREATE TABLE IF NOT EXISTS property_ownership (
  id             TEXT PRIMARY KEY,
  world_id       TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  player_id      TEXT NOT NULL,
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  purchase_price INTEGER NOT NULL DEFAULT 0,
  acquired_at    INTEGER NOT NULL,
  UNIQUE(world_id, player_id, property_id)
);
CREATE INDEX IF NOT EXISTS idx_property_ownership_world ON property_ownership(world_id, player_id);

-- Wealth: AUTHORED stock-market companies (per world).
CREATE TABLE IF NOT EXISTS companies (
  id                  TEXT PRIMARY KEY,
  world_id            TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  ticker              TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  sector              TEXT NOT NULL DEFAULT 'tech',
  base_price          INTEGER NOT NULL DEFAULT 100,
  volatility          REAL NOT NULL DEFAULT 0.04,
  dividend_per_share  INTEGER NOT NULL DEFAULT 0,
  linked_character_id TEXT,
  asset_id            TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_companies_world ON companies(world_id);

-- Wealth: player stock holdings (playthrough state).
CREATE TABLE IF NOT EXISTS stock_holdings (
  id           TEXT PRIMARY KEY,
  world_id     TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  player_id    TEXT NOT NULL,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shares       INTEGER NOT NULL DEFAULT 0,
  cost_basis   INTEGER NOT NULL DEFAULT 0,
  acquired_day INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  UNIQUE(world_id, player_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_stock_holdings_world ON stock_holdings(world_id, player_id);

-- Wealth: derived per-day share prices (deterministic walk; idempotent natural key).
CREATE TABLE IF NOT EXISTS stock_prices (
  world_id   TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  day        INTEGER NOT NULL,
  price      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (world_id, company_id, day)
);
CREATE INDEX IF NOT EXISTS idx_stock_prices_world ON stock_prices(world_id, company_id);

-- Wealth: LLM-authored market-news headlines (flavor explaining a day's price moves).
CREATE TABLE IF NOT EXISTS market_news (
  id           TEXT PRIMARY KEY,
  world_id     TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  day          INTEGER NOT NULL,
  company_id   TEXT,
  ticker       TEXT NOT NULL DEFAULT '',
  headline     TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  sentiment    TEXT NOT NULL DEFAULT 'flat',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_news_world ON market_news(world_id, day);

-- Gambling: every play at the casino (playthrough state). Doubles as the in-flight
-- state for interactive hands (blackjack / video poker), the settled-bet history
-- log, and the per-day wager-cap ledger (today's wagered = SUM(bet) for the day).
CREATE TABLE IF NOT EXISTS gambling_rounds (
  id         TEXT PRIMARY KEY,
  world_id   TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  player_id  TEXT NOT NULL,
  game       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'settled',
  bet        INTEGER NOT NULL DEFAULT 0,
  payout     INTEGER NOT NULL DEFAULT 0,
  outcome    TEXT NOT NULL DEFAULT '',
  state      TEXT NOT NULL DEFAULT '{}',
  day        INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gambling_rounds_day ON gambling_rounds(world_id, player_id, day);
CREATE INDEX IF NOT EXISTS idx_gambling_rounds_active ON gambling_rounds(world_id, player_id, status);

-- Live-date rapport (0..100), persisted per session so a date RESUMED after a
-- server restart keeps its real vibe instead of snapping back to neutral. The
-- rapport-service keeps an in-memory write-through cache for hot live turns; this
-- table is the durable fallback. Cascades when the session is deleted.
CREATE TABLE IF NOT EXISTS session_rapport (
  session_id TEXT PRIMARY KEY REFERENCES conversation_sessions(id) ON DELETE CASCADE,
  rapport    INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Heartmorrow Bench: saved model-evaluation runs. The full BenchRunSummary lives
-- in the data column (JSON); the top columns are denormalized for cheap list ordering.
CREATE TABLE IF NOT EXISTS bench_runs (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bench_runs_created ON bench_runs(created_at);

-- Heartmorrow Bench: the human baselines for the scoring judges, keyed by case id
-- and persisted independently of any run so they're reused across runs.
CREATE TABLE IF NOT EXISTS bench_baselines (
  case_id    TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

-- Prompt Editor: installation-LOCAL overrides for the system prompts / guardrails,
-- keyed by the registry prompt id. Global (never per-world / per-character) and
-- deliberately NOT exported with worlds/characters, so a custom prompt set stays on
-- this machine. A missing row means "use the shipped default".
CREATE TABLE IF NOT EXISTS prompt_overrides (
  prompt_id     TEXT PRIMARY KEY,
  override_text TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);
`;

/**
 * Idempotent ALTERs for columns added after initial release. node:sqlite has no
 * migration system, so we add columns only when absent (checked via table_info).
 */
export const COLUMN_MIGRATIONS: Array<{ table: string; column: string; ddl: string }> = [
  {
    table: 'characters',
    column: 'relationship_style',
    ddl: `ALTER TABLE characters ADD COLUMN relationship_style TEXT NOT NULL DEFAULT 'monogamous'`,
  },
  {
    table: 'characters',
    column: 'links',
    ddl: `ALTER TABLE characters ADD COLUMN links TEXT NOT NULL DEFAULT '[]'`,
  },
  {
    table: 'characters',
    column: 'favorite_weather',
    ddl: `ALTER TABLE characters ADD COLUMN favorite_weather TEXT NOT NULL DEFAULT '[]'`,
  },
  {
    table: 'characters',
    column: 'disliked_weather',
    ddl: `ALTER TABLE characters ADD COLUMN disliked_weather TEXT NOT NULL DEFAULT '[]'`,
  },
  {
    table: 'characters',
    column: 'room_description',
    ddl: `ALTER TABLE characters ADD COLUMN room_description TEXT NOT NULL DEFAULT ''`,
  },
  {
    // Scopes in-world emails to the world they were generated for, so switching
    // the active world doesn't show another world's mail. Nullable: legacy rows
    // (pre-migration) stay un-scoped.
    table: 'emails',
    column: 'world_id',
    ddl: `ALTER TABLE emails ADD COLUMN world_id TEXT`,
  },
  // Richer character profile fields (feed prompts + "make the game feel alive").
  {
    table: 'characters',
    column: 'appearance',
    ddl: `ALTER TABLE characters ADD COLUMN appearance TEXT NOT NULL DEFAULT ''`,
  },
  {
    table: 'characters',
    column: 'physical_needs',
    ddl: `ALTER TABLE characters ADD COLUMN physical_needs TEXT NOT NULL DEFAULT '[]'`,
  },
  {
    table: 'characters',
    column: 'physical_desires',
    ddl: `ALTER TABLE characters ADD COLUMN physical_desires TEXT NOT NULL DEFAULT '[]'`,
  },
  {
    table: 'characters',
    column: 'physical_dislikes',
    ddl: `ALTER TABLE characters ADD COLUMN physical_dislikes TEXT NOT NULL DEFAULT '[]'`,
  },
  {
    table: 'characters',
    column: 'texting_style',
    ddl: `ALTER TABLE characters ADD COLUMN texting_style TEXT NOT NULL DEFAULT ''`,
  },
  {
    table: 'characters',
    column: 'online_persona',
    ddl: `ALTER TABLE characters ADD COLUMN online_persona TEXT NOT NULL DEFAULT ''`,
  },
  {
    table: 'characters',
    column: 'love_language',
    ddl: `ALTER TABLE characters ADD COLUMN love_language TEXT NOT NULL DEFAULT ''`,
  },
  {
    table: 'characters',
    column: 'insecurities',
    ddl: `ALTER TABLE characters ADD COLUMN insecurities TEXT NOT NULL DEFAULT '[]'`,
  },
  {
    table: 'characters',
    column: 'quirks',
    ddl: `ALTER TABLE characters ADD COLUMN quirks TEXT NOT NULL DEFAULT '[]'`,
  },
  {
    // Authored job (null = unemployed). DEFAULT is the JSON literal 'null' (NOT
    // '{}') so legacy rows decode to a valid null Employment — '{}' would parse
    // to an object missing the required title/place and throw in rowToCharacter.
    table: 'characters',
    column: 'employment',
    ddl: `ALTER TABLE characters ADD COLUMN employment TEXT NOT NULL DEFAULT 'null'`,
  },
  {
    // Durable per-(world,day) idempotency guard for the NPC world-sim.
    table: 'world_states',
    column: 'last_world_sim_day',
    ddl: `ALTER TABLE world_states ADD COLUMN last_world_sim_day INTEGER NOT NULL DEFAULT 0`,
  },
  {
    // Authored opt-in gating ex-canonization (0/1). Default OFF = immutable truth.
    table: 'characters',
    column: 'allows_ex_canonization',
    ddl: `ALTER TABLE characters ADD COLUMN allows_ex_canonization INTEGER NOT NULL DEFAULT 0`,
  },
  {
    // How slow to warm up on a date (0..100); drives starting/per-turn rapport.
    table: 'characters',
    column: 'guardedness',
    ddl: `ALTER TABLE characters ADD COLUMN guardedness INTEGER NOT NULL DEFAULT 30`,
  },
  {
    // World-scopes game events so per-world reads (notably the end-of-day recap)
    // never mix worlds. Nullable: world-less events (import/reset) and legacy rows
    // stay NULL. Stamped at write time in event-service (derived from the payload's
    // worldId, else the character/subject's world). Indexed for the recap query.
    table: 'game_events',
    column: 'world_id',
    ddl: `ALTER TABLE game_events ADD COLUMN world_id TEXT;
          CREATE INDEX IF NOT EXISTS idx_events_world ON game_events(world_id, created_at)`,
  },
  {
    // Per-world minigame highscores. Nullable: legacy plays stay NULL (excluded
    // from per-world result lists; personal-best falls back to global for them).
    table: 'minigame_results',
    column: 'world_id',
    ddl: `ALTER TABLE minigame_results ADD COLUMN world_id TEXT;
          CREATE INDEX IF NOT EXISTS idx_minigame_results_world ON minigame_results(world_id)`,
  },
  // Gender + sexuality (attraction compatibility). Default 'unspecified' = no gating,
  // so existing characters/players and their relationships are unaffected until set.
  {
    table: 'characters',
    column: 'gender',
    ddl: `ALTER TABLE characters ADD COLUMN gender TEXT NOT NULL DEFAULT 'unspecified'`,
  },
  {
    table: 'characters',
    column: 'sexuality',
    ddl: `ALTER TABLE characters ADD COLUMN sexuality TEXT NOT NULL DEFAULT 'unspecified'`,
  },
  // Emergent NPC romance: a world-sim NPC↔NPC edge can grow a crush → couple. Default
  // 'none'/0 so every legacy edge decodes to an unattached pair (unchanged behavior).
  {
    table: 'npc_edges',
    column: 'romance_state',
    ddl: `ALTER TABLE npc_edges ADD COLUMN romance_state TEXT NOT NULL DEFAULT 'none'`,
  },
  {
    table: 'npc_edges',
    column: 'romance_since',
    ddl: `ALTER TABLE npc_edges ADD COLUMN romance_since INTEGER NOT NULL DEFAULT 0`,
  },
  {
    // Emergent fallings-out: a world-sim NPC↔NPC edge can sour into a rivalry. Default 0
    // so every legacy edge decodes as un-soured (unchanged behavior).
    table: 'npc_edges',
    column: 'soured',
    ddl: `ALTER TABLE npc_edges ADD COLUMN soured INTEGER NOT NULL DEFAULT 0`,
  },
  {
    table: 'players',
    column: 'gender',
    ddl: `ALTER TABLE players ADD COLUMN gender TEXT NOT NULL DEFAULT 'unspecified'`,
  },
  {
    table: 'players',
    column: 'sexuality',
    ddl: `ALTER TABLE players ADD COLUMN sexuality TEXT NOT NULL DEFAULT 'unspecified'`,
  },
  {
    table: 'players',
    column: 'career',
    ddl: `ALTER TABLE players ADD COLUMN career TEXT NOT NULL DEFAULT '{}'`,
  },
  {
    // Player-sent photo on a text (uploaded asset id; vision model reads it).
    // Nullable: text-only messages and legacy rows stay NULL.
    table: 'text_messages',
    column: 'image_asset_id',
    ddl: `ALTER TABLE text_messages ADD COLUMN image_asset_id TEXT`,
  },
  {
    // The other person a (social) memory is about — lets a world-sim meeting memory
    // be looked up by "who it involves" and the two parties' memories of the same
    // encounter be cross-referenced. Nullable: ordinary memories and legacy rows stay NULL.
    table: 'character_memories',
    column: 'related_character_id',
    ddl: `ALTER TABLE character_memories ADD COLUMN related_character_id TEXT`,
  },
  {
    // The immediate teller of a piece of gossip, so a surfaced rumor about the player
    // can be attributed ("your friend Mara mentioned…"). Nullable: first-hand knowledge
    // and legacy rows stay NULL.
    table: 'npc_knowledge',
    column: 'source_knower_id',
    ddl: `ALTER TABLE npc_knowledge ADD COLUMN source_knower_id TEXT`,
  },
  {
    // Per-world opt-in mechanics (property ownership / stock market). JSON blob,
    // default '{}' → both OFF, so existing worlds gain nothing until the creator
    // enables them in the World editor.
    table: 'worlds',
    column: 'feature_flags',
    ddl: `ALTER TABLE worlds ADD COLUMN feature_flags TEXT NOT NULL DEFAULT '{}'`,
  },
  {
    // Idempotency guard: last day rent income was collected (never double-credit rent).
    table: 'world_states',
    column: 'last_rent_calculated_day',
    ddl: `ALTER TABLE world_states ADD COLUMN last_rent_calculated_day INTEGER NOT NULL DEFAULT 0`,
  },
  {
    // Idempotency guard: last day stock prices were rolled + dividends paid.
    table: 'world_states',
    column: 'last_stock_calculated_day',
    ddl: `ALTER TABLE world_states ADD COLUMN last_stock_calculated_day INTEGER NOT NULL DEFAULT 0`,
  },
  {
    // Property rent reworked from a per-date fee into a recurring lease: amount + cadence.
    // (The old rent_price / rent_per_day columns, if present, are left dead.)
    table: 'properties',
    column: 'rent_amount',
    ddl: `ALTER TABLE properties ADD COLUMN rent_amount INTEGER NOT NULL DEFAULT 0`,
  },
  {
    table: 'properties',
    column: 'rent_cadence',
    ddl: `ALTER TABLE properties ADD COLUMN rent_cadence TEXT NOT NULL DEFAULT 'weekly'`,
  },
  {
    // The in-world day shares were last bought — gates same-day dividend collection.
    table: 'stock_holdings',
    column: 'acquired_day',
    ddl: `ALTER TABLE stock_holdings ADD COLUMN acquired_day INTEGER NOT NULL DEFAULT 0`,
  },
  {
    // Per-world casino limits (maxBet / dailyWagerLimit). JSON blob, default '{}'
    // → the GAMBLING defaults apply until a creator overrides them in the editor.
    table: 'worlds',
    column: 'gambling_config',
    ddl: `ALTER TABLE worlds ADD COLUMN gambling_config TEXT NOT NULL DEFAULT '{}'`,
  },
];
