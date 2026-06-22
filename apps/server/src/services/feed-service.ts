import {
  CHARACTER_LINK_LABELS,
  CHARACTER_LINK_ORDER,
  DEFAULT_PLAYER_ID,
  FEED_AMBIENT_CHANCE,
  FEED_AMBIENT_MAX_PER_DAY,
  FEED_COMMENTERS_MAX,
  FEED_EVENT_POSTS_MAX_PER_DAY,
  FEED_MIN_WARMTH,
  FEED_NPC_COMMENT_CHANCE,
  FEED_NPC_COMMENTERS_MAX,
  FEED_NPC_ENGAGE_POSTS_MAX,
  FEED_NPC_REACT_CHANCE,
  FEED_REACT_BASE_CHANCE,
  FeedCommentDraftSchema,
  FeedCommentSchema,
  FeedPostSchema,
  FeedReactionSchema,
  JEALOUSY,
  KNOWLEDGE_GOSSIP_MIN_FIDELITY,
  NpcFeedPostSchema,
  currentStatus,
  deriveCalendar,
  isBrokenUp,
  linkTo,
  warmthOf,
  type Character,
  type CharacterLinkKind,
  type CharacterMemory,
  type FeedCommentView,
  type FeedPost,
  type FeedPostKind,
  type FeedPostView,
  type FeedReactionView,
  type FeedView,
  type CreateFeedPostResponse,
  type ReactionKind,
  type Relationship,
} from '@dsim/shared';
import {
  charactersRepo,
  eventsRepo,
  feedCommentsRepo,
  feedPostsRepo,
  feedReactionsRepo,
  feedSeenRepo,
  npcEdgesRepo,
  npcKnowledgeRepo,
} from '../db/repositories';
import { notFound } from '../lib/errors';
import { hasDated } from './text-message-service';
import { pickGossipKnowledge } from './gossip-service';
import { getRelationship } from './relationship-service';
import { getOrCreatePlayer } from './player-service';
import { listMemories } from './memory-service';
import { ensureWorldState } from './world-clock-service';
import { moodForCharacter, weatherForDay } from './ambiance-service';
import { getLlmSettings } from './settings-service';
import { callStructuredLlm } from '../llm/structured';
import {
  buildFeedCommentMessages,
  buildNpcFeedCommentMessages,
  buildNpcFeedPostMessages,
} from '../prompt/prompt-builder';
import { newId, playerIdForWorldOrDefault } from '../lib/ids';
import { hashFloat, type SeededRandom } from '../lib/seeded-random';
import { recordEvent } from './event-service';

/**
 * "Faces" — the in-world social feed. NARRATIVE ONLY: every function here READS
 * relationship state but NEVER mutates stats. Two surfaces:
 *  - At day start, NPCs author event-driven posts (jealousy / milestone / breakup
 *    / reconcile) and rare ambient "life" posts (mirrors generateGossipForDay).
 *  - In-request, the player posts a status and engaged NPCs synchronously comment
 *    + react (mirrors sendPlayerText). All generation is fail-safe.
 */

// --- event types that drive feed posts --------------------------------------
const FEED_NEWS_TYPES = new Set([
  'jealousy_triggered',
  'milestone_reached',
  'dtr_accepted',
  'breakup',
  'reconciled',
]);

/** Post kinds that are genuinely ABOUT the player — only these carry the author's
 *  relationship to the player + memories of them into the prompt. A 'life' /
 *  knowledge post by someone the player has never met must not be framed that way. */
const PLAYER_RELATED_KINDS = new Set<FeedPostKind>(['jealousy', 'milestone', 'breakup', 'reconcile']);

/** A few top memories (importance, then recency) for personalizing a post. */
function topMemoriesFor(characterId: string, limit = 5): CharacterMemory[] {
  return [...listMemories(characterId)]
    .sort((a, b) => (b.importance !== a.importance ? b.importance - a.importance : b.createdAt - a.createdAt))
    .slice(0, limit);
}

/** Engaged characters in a world (the player has actually dated them). */
function engagedWorldChars(worldId: string): Character[] {
  return charactersRepo.listByWorld(worldId).filter((c) => hasDated(c.id));
}

// --- day-start generation ---------------------------------------------------

/**
 * At day start, characters in the social web post to Faces about yesterday's
 * notable events and (rarely) about their day. Mirrors generateGossipForDay:
 * scan recent events, keep yesterday's, build a plain-English SITUATION, and
 * call the LLM fail-safe. Event-driven posts are idempotent via
 * feedPostsRepo.existsForEvent; ambient posts via existsForAuthorDayKind.
 * Per-world scoped. `rng` is injectable for tests.
 */
export async function generateFeedForDay(
  worldId: string,
  day: number,
  playerId: string = DEFAULT_PLAYER_ID,
  rng: SeededRandom = hashFloat,
): Promise<void> {
  const yesterday = day - 1;
  const settings = getLlmSettings();
  const playerName = getOrCreatePlayer(playerIdForWorldOrDefault(worldId)).name;
  const worldChars = charactersRepo.listByWorld(worldId);

  // --- 1. EVENT-DRIVEN posts (idempotent per (event, author)) ---------------
  const notable = eventsRepo
    .list(300)
    .filter((e) => FEED_NEWS_TYPES.has(e.type) && (e.payload as Record<string, unknown>).day === yesterday);

  let eventPosts = 0; // bounds the day-start LLM fan-out on a busy day
  for (const event of notable) {
    if (eventPosts >= FEED_EVENT_POSTS_MAX_PER_DAY) break;
    const p = event.payload as Record<string, unknown>;
    const subjectId = String(p.characterId ?? '');
    const subject = charactersRepo.get(subjectId);
    if (!subject || subject.worldId !== worldId) continue;

    if (event.type === 'jealousy_triggered') {
      // The hurt character (by definition engaged) posts about the betrayal.
      // NEVER name the other person — the guardrail keeps it vague/tasteful.
      const committed = p.committed === true;
      const linkKind = typeof p.link === 'string' ? p.link : null;
      let situation = committed
        ? "You've just discovered the person you were committed to has also been seeing someone else — you feel betrayed."
        : "You've just found out they have also been seeing someone else.";
      if (linkKind === 'ex') {
        situation += " And it's an ex of yours, which stings more.";
      }
      if (
        await emitNpcPost({
          worldId,
          day,
          author: subject,
          kind: 'jealousy',
          situation,
          sourceEventId: event.id,
          playerName,
          settings,
        })
      )
        eventPosts += 1;
      continue;
    }

    if (event.type === 'breakup' || event.type === 'reconciled') {
      const kind: FeedPostKind = event.type === 'breakup' ? 'breakup' : 'reconcile';
      let situation: string;
      if (event.type === 'breakup') {
        const initiator = typeof p.initiator === 'string' ? p.initiator : 'mutual';
        const count = typeof p.breakupCount === 'number' ? p.breakupCount : 1;
        situation =
          initiator === 'character'
            ? 'You ended things with the person you were seeing. Post something that fits how you feel about it.'
            : 'Things with the person you were seeing have ended. Post something that fits how you feel about it.';
        if (count > 1) situation += ' This is not the first time the two of you have split.';
      } else {
        situation = "You and the person you were seeing have found your way back to each other.";
      }
      if (
        await emitNpcPost({
          worldId,
          day,
          author: subject,
          kind,
          situation,
          sourceEventId: event.id,
          playerName,
          settings,
        })
      )
        eventPosts += 1;
      continue;
    }

    if (event.type === 'milestone_reached' || event.type === 'dtr_accepted') {
      // Characters LINKED to the subject react publicly to the couple's news —
      // a friend, ex, or rival of the subject would have an opinion whether or not
      // they've met the player. The subject's name IS public here, so the situation
      // may use it.
      const onlookers = worldChars
        .filter((g) => g.id !== subjectId && linkTo(g.links, subjectId) != null)
        .slice(0, 2);
      for (const g of onlookers) {
        if (eventPosts >= FEED_EVENT_POSTS_MAX_PER_DAY) break;
        const link = linkTo(g.links, subjectId)!;
        const situation = milestoneSituation(link.kind, subject.name, playerName);
        if (
          await emitNpcPost({
            worldId,
            day,
            author: g,
            kind: 'milestone',
            situation,
            sourceEventId: event.id,
            playerName,
            settings,
          })
        )
          eventPosts += 1;
      }
      continue;
    }
  }

  // --- 2. AMBIENT "life" posts (rare, capped per day) -----------------------
  // EVERY character in the world can post — not just the ones you've dated — so the
  // feed is populated by the whole neighborhood, including people you've never met.
  for (const c of worldChars) {
    if (feedPostsRepo.countAmbientForDay(worldId, day) >= FEED_AMBIENT_MAX_PER_DAY) break;
    if (rng(`feed|${worldId}|${day}|${c.id}|ambient`) >= FEED_AMBIENT_CHANCE) continue;
    if (feedPostsRepo.existsForAuthorDayKind(worldId, c.id, day, 'life')) continue;

    const situation = ambientSituation(worldId, day, c, rng);
    await emitNpcPost({
      worldId,
      day,
      author: c,
      kind: 'life',
      situation,
      sourceEventId: null,
      playerName,
      settings,
      // TOCTOU guard: a concurrent pass may have inserted between the gate and now.
      recheckAmbient: true,
    });
  }

  // --- 3. KNOWLEDGE posts: an NPC shares neighborhood news on the feed -------
  // (any character may share what they've heard; shares the ambient cap; idempotent
  // per knowledge row via a synthetic source key).
  for (const c of worldChars) {
    if (feedPostsRepo.countAmbientForDay(worldId, day) >= FEED_AMBIENT_MAX_PER_DAY) break;
    if (rng(`feed|${worldId}|${day}|${c.id}|knews`) >= FEED_AMBIENT_CHANCE) continue;
    if (feedPostsRepo.existsForAuthorDayKind(worldId, c.id, day, 'life')) continue; // one life-ish post per char/day

    const pick = pickGossipKnowledge(c.id, worldId);
    if (!pick) continue;

    await emitNpcPost({
      worldId,
      day,
      author: c,
      kind: 'life',
      situation: knowledgeSituation(pick.subjectName, pick.claim, pick.fidelity >= 80),
      sourceEventId: `knews:${pick.knowledgeId}`, // dedups via UNIQUE(source_event_id, author_id)
      playerName,
      settings,
      recheckAmbient: true,
    });
  }

  // --- 4. NPC↔NPC ENGAGEMENT: connected characters comment on + react to today's
  //         posts (friends/family warmly, exes/rivals rarely + pointedly). -------
  await generateNpcEngagement(worldId, day, settings, rng);
}

/** Build the SITUATION for a feed post where a character shares neighborhood news. */
function knowledgeSituation(subjectName: string, claim: string, confident: boolean): string {
  return (
    `You heard a bit of news about ${subjectName}: "${claim}". ` +
    `${confident ? 'You heard it pretty reliably.' : 'You only half-heard it, so keep it vague.'} ` +
    `Post a casual, friendly update that mentions ${subjectName} and this little bit of news — neighborhood-feed style, never mean.`
  );
}

/** Build the SITUATION for a linked onlooker's milestone post, keyed by link kind. */
function milestoneSituation(linkKind: string, subjectName: string, playerName: string): string {
  const label = CHARACTER_LINK_LABELS[linkKind as keyof typeof CHARACTER_LINK_LABELS]?.toLowerCase() ?? 'someone you know';
  switch (linkKind) {
    case 'friend':
      return `${subjectName} — your ${label} — is getting close with ${playerName}. You're happy for them and can't resist a little teasing.`;
    case 'rival':
      return `${subjectName}, your ${label}, is getting close with ${playerName}. Stay cool and a touch competitive about it.`;
    case 'ex':
      return `${subjectName} is growing close to ${playerName} — and ${subjectName} is your ex. It's wistful, maybe a little pointed.`;
    case 'family':
      return `${subjectName} — your ${label} — is getting serious with ${playerName}. You're protective and a bit nosy about it.`;
    case 'partner':
      return `${subjectName}, your ${label}, is growing close with ${playerName}. It lands as a quiet wound.`;
    case 'crush':
      return `${subjectName} — someone you've quietly carried a torch for — is growing close with ${playerName}. It stings, but you keep it to yourself.`;
    case 'roommate':
      return `${subjectName}, your ${label}, is getting close with ${playerName}. You've had a front-row seat, so you're warm and a little teasing about it.`;
    case 'mentor':
      return `${subjectName} — your ${label} — is getting close with ${playerName}. You're quietly glad for them.`;
    case 'coworker':
    case 'classmate':
    case 'neighbor':
      return `${subjectName}, your ${label}, is getting close with ${playerName}. You're friendly and lightly happy for them.`;
    default:
      return `${subjectName} is getting close with ${playerName}.`;
  }
}

/**
 * Build the SITUATION for an ambient "life" post. Real people rarely post about
 * the weather, so this leads with something specific to WHO the character is — an
 * interest, a goal, a quirk, a craving, a small opinion, or simply the kind of
 * thing their posting style suggests — and keeps weather/season/holiday as a
 * minority of the angle pool (flavor, not the default). The focus is chosen
 * deterministically from `rng`, so a re-run of the same day reproduces it.
 */
function ambientSituation(worldId: string, day: number, c: Character, rng: SeededRandom): string {
  const weather = weatherForDay(worldId, day);
  const mood = moodForCharacter(worldId, day, c).mood;
  const cal = deriveCalendar(day);

  // Concrete things to post ABOUT, drawn from who this character actually is — so
  // the feed reads like a neighborhood of people, not a wall of weather updates.
  const angles: string[] = [];
  for (const like of c.likes) angles.push(`something about ${like} — a thought, a recommendation, or a little enthusiasm`);
  for (const goal of c.goals) angles.push(`how ${goal} is going — a small update, a win, or a bit of frustration`);
  for (const quirk of c.quirks) angles.push(`a little moment that shows you being you (${quirk})`);
  for (const want of c.physicalDesires) angles.push(`a craving or want on your mind: ${want}`);
  for (const dislike of c.dislikes) angles.push(`a mild, good-humored gripe about ${dislike}`);
  if (c.onlinePersona) angles.push(`exactly the kind of thing you usually post (your posting style: ${c.onlinePersona})`);
  // Generic-but-human fallbacks so a sparsely-written character still varies.
  angles.push('a small, specific observation about something you noticed today');
  angles.push('a random thought, a joke, or a fun fact you felt like sharing');
  // Weather / season / holiday: a MINORITY of the pool — flavor, never the default.
  if (cal.holiday) angles.push(`a quick note about ${cal.holiday.name}`);
  angles.push(`a passing mention of the weather (${weather.label.toLowerCase()}) or the ${cal.season} season, but ONLY if it genuinely fits your mood`);

  const idx = Math.floor(rng(`feedangle|${worldId}|${day}|${c.id}`) * angles.length);
  const focus = angles[Math.min(idx, angles.length - 1)];

  return (
    `You're feeling ${mood}. Post a short, ordinary update in your own voice — make it ${focus}. ` +
    `Do NOT default to talking about the weather or the season unless that truly fits this post.`
  );
}

/**
 * Generate one NPC post fail-safe and insert it. Idempotent for event-driven
 * posts via existsForEvent; ambient posts re-check existsForAuthorDayKind after
 * the await (TOCTOU guard). Records a 'feed_post' / 'feed_post_failed' event.
 * Returns true iff a post was actually inserted (so callers can count toward caps).
 */
async function emitNpcPost(args: {
  worldId: string;
  day: number;
  author: Character;
  kind: FeedPostKind;
  situation: string;
  sourceEventId: string | null;
  playerName: string;
  settings: ReturnType<typeof getLlmSettings>;
  recheckAmbient?: boolean;
}): Promise<boolean> {
  const { worldId, day, author, kind, situation, sourceEventId, playerName, settings } = args;

  // Idempotency for event-driven posts: skip the LLM call entirely if it exists.
  if (sourceEventId && feedPostsRepo.existsForEvent(sourceEventId, author.id)) return false;

  // Only posts that are ABOUT the player carry the author's relationship to them +
  // memories of them — and only when the author has actually met the player.
  const playerContext =
    PLAYER_RELATED_KINDS.has(kind) && hasDated(author.id)
      ? { playerName, relationship: getRelationship(author.id), memories: topMemoriesFor(author.id) }
      : undefined;

  const result = await callStructuredLlm(
    NpcFeedPostSchema,
    buildNpcFeedPostMessages({ character: author, kind, situation, playerContext }),
    { settings, task: `Write ${author.name}'s ${kind} feed post.`, schemaName: 'NpcFeedPost' },
  );
  if (!result.ok) {
    recordEvent('feed_post_failed', { characterId: author.id, error: result.error });
    return false;
  }

  // Re-check idempotency AFTER the await (no suspension point before the insert).
  if (sourceEventId && feedPostsRepo.existsForEvent(sourceEventId, author.id)) return false;
  if (args.recheckAmbient && feedPostsRepo.existsForAuthorDayKind(worldId, author.id, day, kind)) return false;

  feedPostsRepo.insert(
    FeedPostSchema.parse({
      id: newId('fpost'),
      worldId,
      authorType: 'character',
      authorId: author.id,
      body: result.data.body,
      kind,
      mood: result.data.mood,
      sourceEventId,
      dayNumber: day,
      phase: null,
      createdAt: Date.now(),
    }),
  );
  recordEvent('feed_post', { characterId: author.id, kind, sourceEventId, day });
  return true;
}

// --- NPC ↔ NPC engagement (the social circle reacting to each other) ---------

/** Canonical undirected key for an npc_edges pair (matches the repo's a<b order). */
function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * How `viewer` relates to `target`, from the viewer's side: their own AUTHORED
 * link wins, else a world-sim-derived edge (promoted → friend, else acquaintance).
 * Returns null when there's no tie at all (a stranger doesn't chime in). Authored
 * non-rival links are kept mutual elsewhere, so reading the viewer's own links is
 * enough; a one-sided rival is captured because the rival is the one who declared it.
 * `edges` is the world's derived edges, preloaded once (no per-pair SQL).
 */
function tieKind(
  viewer: Character,
  targetId: string,
  edges: ReadonlyMap<string, { promoted: boolean }>,
): CharacterLinkKind | null {
  const authored = linkTo(viewer.links, targetId);
  if (authored) return authored.kind;
  const edge = edges.get(edgeKey(viewer.id, targetId));
  if (edge) return edge.promoted ? 'friend' : 'acquaintance';
  return null;
}

/** A few short things `knower` actually knows about `subject` — shared memories
 *  (world-sim meetings etc.) plus a bit of neighborhood gossip — so a comment can
 *  reference real history rather than read as generic filler. */
function npcKnowledgeAbout(knowerId: string, subjectId: string, worldId: string): string[] {
  const out: string[] = [];
  const mems = listMemories(knowerId)
    .filter((m) => m.relatedCharacterId === subjectId)
    .sort((a, b) => (b.importance !== a.importance ? b.importance - a.importance : b.createdAt - a.createdAt))
    .slice(0, 2);
  for (const m of mems) out.push(m.text);
  const gossip = npcKnowledgeRepo
    .listByKnower(knowerId, 16)
    .find((k) => k.subjectId === subjectId && k.fidelity >= KNOWLEDGE_GOSSIP_MIN_FIDELITY);
  if (gossip) out.push(`You've heard around town: ${gossip.claim}`);
  return out;
}

/** A deterministic reaction kind for an NPC reacting to a connected poster's post.
 *  Heavy posts (breakup/jealousy) draw empathy from people who care — and a rare
 *  smirk from a rival; everything else is a warm like/love. */
function npcReactionForLink(kind: CharacterLinkKind, postKind: FeedPostKind): ReactionKind | null {
  const heavy = postKind === 'breakup' || postKind === 'jealousy';
  switch (kind) {
    case 'partner':
      return heavy ? 'sad' : 'love';
    case 'family':
      return heavy ? 'sad' : 'love';
    case 'friend':
      return heavy ? 'sad' : 'like';
    case 'ex':
      return heavy ? 'sad' : 'like';
    case 'rival':
      return heavy ? 'laugh' : 'like';
    case 'crush':
      return heavy ? 'sad' : 'love';
    case 'roommate':
      return heavy ? 'sad' : 'love';
    default:
      return 'like';
  }
}

/**
 * After the day's NPC posts exist, let socially-connected characters COMMENT on
 * and REACT to each other's posts — friends/family warmly, exes/rivals rarely and
 * pointedly — drawing on what they actually know about the poster. NARRATIVE ONLY
 * (never touches stats). Idempotent: comments dedupe per (post, author), reactions
 * per (post, actor); the per-candidate rolls are deterministic via `rng`, so
 * re-running a day adds nothing. Only today's posts are engaged (when they're fresh).
 */
async function generateNpcEngagement(
  worldId: string,
  day: number,
  settings: ReturnType<typeof getLlmSettings>,
  rng: SeededRandom,
): Promise<void> {
  const chars = charactersRepo.listByWorld(worldId);
  const byId = new Map(chars.map((c) => [c.id, c]));
  // Load the world's derived edges ONCE so candidate-building is pure in-memory.
  const edges = new Map<string, { promoted: boolean }>();
  for (const e of npcEdgesRepo.listByWorld(worldId)) edges.set(edgeKey(e.aId, e.bId), e);

  const todaysPosts = feedPostsRepo
    .listCharacterPostsForDay(worldId, day)
    .slice(0, FEED_NPC_ENGAGE_POSTS_MAX);

  for (const post of todaysPosts) {
    const poster = byId.get(post.authorId);
    if (!poster) continue;

    // Everyone with a tie TO the poster is a candidate, closest bonds first so the
    // limited comment slots go to the people who'd most plausibly speak up.
    const candidates = chars
      .filter((c) => c.id !== poster.id)
      .map((c) => ({ c, kind: tieKind(c, poster.id, edges) }))
      .filter((x): x is { c: Character; kind: CharacterLinkKind } => x.kind != null)
      .sort((a, b) => CHARACTER_LINK_ORDER.indexOf(a.kind) - CHARACTER_LINK_ORDER.indexOf(b.kind));

    // Choose the comment set as a PURE function of the deterministic rolls: take the
    // first FEED_NPC_COMMENTERS_MAX candidates (closest bonds first) whose roll passes
    // — counting any who ALREADY commented toward the cap — THEN drop the ones already
    // present. So a re-run of the day picks the identical set and inserts nothing new
    // (an already-committed top commenter still occupies its slot, never freeing it for
    // a lower-priority candidate). Generate in parallel, fail-safe, deduped before insert.
    const commenters = candidates
      .filter((cand) => rng(`feednpccmt|${worldId}|${day}|${post.id}|${cand.c.id}`) < FEED_NPC_COMMENT_CHANCE[cand.kind])
      .slice(0, FEED_NPC_COMMENTERS_MAX)
      .filter((cand) => !feedCommentsRepo.existsByAuthor(post.id, cand.c.id));
    await Promise.allSettled(
      commenters.map(async ({ c, kind }) => {
        const result = await callStructuredLlm(
          FeedCommentDraftSchema,
          buildNpcFeedCommentMessages({
            commenter: c,
            posterName: poster.name,
            postBody: post.body,
            postKind: post.kind,
            linkKind: kind,
            knownAboutPoster: npcKnowledgeAbout(c.id, poster.id, worldId),
          }),
          { settings, task: `Write ${c.name}'s comment on ${poster.name}'s post.`, schemaName: 'FeedCommentDraft' },
        );
        if (!result.ok) {
          recordEvent('feed_comment_failed', { characterId: c.id, error: result.error });
          return;
        }
        // Re-check AFTER the await (TOCTOU): a concurrent pass may have inserted.
        if (feedCommentsRepo.existsByAuthor(post.id, c.id)) return;
        feedCommentsRepo.insert(
          FeedCommentSchema.parse({
            id: newId('fcmt'),
            postId: post.id,
            authorType: 'character',
            authorId: c.id,
            body: result.data.body,
            tone: result.data.tone,
            createdAt: Date.now(),
          }),
        );
      }),
    );

    // Reactions — a separate, no-LLM deterministic roll over the same candidates.
    for (const { c, kind } of candidates) {
      if (feedReactionsRepo.getByActor(post.id, c.id)) continue;
      if (rng(`feednpcreact|${worldId}|${day}|${post.id}|${c.id}`) >= FEED_NPC_REACT_CHANCE[kind]) continue;
      const reaction = npcReactionForLink(kind, post.kind);
      if (!reaction) continue;
      feedReactionsRepo.insert(
        FeedReactionSchema.parse({
          id: newId('freact'),
          postId: post.id,
          actorType: 'character',
          actorId: c.id,
          kind: reaction,
          createdAt: Date.now(),
        }),
      );
    }
  }
}

// --- player post + synchronous NPC reactions --------------------------------

/**
 * The player posts a status. Insert it, then SYNCHRONOUSLY let the most relevant
 * engaged characters comment + react (mirrors sendPlayerText). NARRATIVE ONLY —
 * never touches stats. All generation is fail-safe.
 */
export async function createPlayerPost(
  input: { body: string; worldId: string },
  playerId: string = DEFAULT_PLAYER_ID,
): Promise<CreateFeedPostResponse> {
  const state = ensureWorldState(input.worldId);
  const now = Date.now();
  const post = feedPostsRepo.insert(
    FeedPostSchema.parse({
      id: newId('fpost'),
      worldId: input.worldId,
      authorType: 'player',
      authorId: playerId,
      body: input.body,
      kind: 'status',
      mood: '',
      sourceEventId: null,
      dayNumber: state.day,
      phase: state.phase,
      createdAt: now,
    }),
  );

  const playerName = getOrCreatePlayer(playerIdForWorldOrDefault(input.worldId)).name;
  const settings = getLlmSettings();

  // Eligible reactors: engaged characters warm enough to bother. Ranked so the
  // most relevant (jealous / broken-up / freshly-hurt, then warmest) go first.
  const eligible = engagedWorldChars(input.worldId)
    .map((c) => ({ c, rel: getRelationship(c.id) }))
    .filter(({ rel }) => warmthOf(rel) >= FEED_MIN_WARMTH || isBrokenUp(rel) || rel.flags['state:jealous'] === true)
    .map((e) => ({ ...e, score: relevanceScore(e.c.id, e.rel, state.day) }))
    .sort((a, b) => b.score - a.score);

  const commenters = eligible.slice(0, FEED_COMMENTERS_MAX);

  // Comments — generated in parallel, fail-safe, inserted as they resolve.
  await Promise.allSettled(
    commenters.map(async ({ c, rel }) => {
      const situation = commentSituation(rel);
      const result = await callStructuredLlm(
        FeedCommentDraftSchema,
        buildFeedCommentMessages({
          character: c,
          relationship: rel,
          playerName,
          postAuthorName: playerName,
          postBody: input.body,
          postKind: 'status',
          situation,
          memories: topMemoriesFor(c.id),
        }),
        { settings, task: `Write ${c.name}'s comment on the player's post.`, schemaName: 'FeedCommentDraft' },
      );
      if (!result.ok) {
        recordEvent('feed_comment_failed', { characterId: c.id, error: result.error });
        return;
      }
      feedCommentsRepo.insert(
        FeedCommentSchema.parse({
          id: newId('fcmt'),
          postId: post.id,
          authorType: 'character',
          authorId: c.id,
          body: result.data.body,
          tone: result.data.tone,
          createdAt: Date.now(),
        }),
      );
    }),
  );

  // Reactions — a separate warmth-weighted roll. Sentiment picks the kind; hurt
  // / jealous characters either skip or react 'sad' rather than 'like'.
  for (const { c, rel } of eligible) {
    const warmth = warmthOf(rel);
    if (warmth < FEED_MIN_WARMTH) continue;
    if (hashFloat(`feedreact|${post.id}|${c.id}`) >= FEED_REACT_BASE_CHANCE * (warmth / 100)) continue;
    const kind = reactionForSentiment(rel);
    if (!kind) continue;
    feedReactionsRepo.insert(
      FeedReactionSchema.parse({
        id: newId('freact'),
        postId: post.id,
        actorType: 'character',
        actorId: c.id,
        kind,
        createdAt: Date.now(),
      }),
    );
  }

  // The player is in the feed right now and sees these freshly-generated comments
  // in the response — so mark the feed seen, or the comments on their own post
  // would wrongly light the home-screen badge the moment they leave.
  markFeedSeen(input.worldId, playerId);

  return { post: toPostView(post, playerId) };
}

/** Rank a candidate reactor: hurt/jealous/broken-up first, then by warmth. */
function relevanceScore(characterId: string, rel: Relationship, currentDay: number): number {
  let score = warmthOf(rel);
  if (rel.flags['state:jealous'] === true) score += 1000;
  if (isBrokenUp(rel)) score += 800;
  // A fresh jealousy beat — triggered within the recency window (in-world days),
  // not merely among the character's last 50 events — bumps relevance.
  const recentJealousy = eventsRepo.listByCharacter(characterId, 50).some((e) => {
    if (e.type !== 'jealousy_triggered') return false;
    const d = (e.payload as Record<string, unknown>).day;
    return typeof d === 'number' && currentDay - d <= JEALOUSY.recencyDays;
  });
  if (recentJealousy) score += 500;
  return score;
}

/** Server-composed context line for a comment, derived from relationship flags. */
function commentSituation(rel: Relationship): string {
  if (rel.flags['state:jealous'] === true) return 'You are quietly jealous of them right now — keep it cool and a little pointed.';
  if (isBrokenUp(rel)) return 'The two of you have broken up — your comment is distant or cool, not warm.';
  const status = currentStatus(rel);
  if (status === 'exclusive' || status === 'cohabiting') return 'You are committed to them — your comment is affectionate.';
  if (warmthOf(rel) >= 65) return 'You are close — your comment is warm and fond.';
  return 'You are on friendly terms — keep your comment light and friendly.';
}

/** Pick a reaction kind from relationship sentiment (null = skip). */
function reactionForSentiment(rel: Relationship): ReactionKind | null {
  if (rel.flags['state:jealous'] === true || isBrokenUp(rel)) {
    // Hurt characters mostly stay silent; occasionally a 'sad' react.
    return rel.flags['state:jealous'] === true ? null : 'sad';
  }
  const status = currentStatus(rel);
  if (status === 'exclusive' || status === 'cohabiting' || warmthOf(rel) >= 65) return 'love';
  return 'like';
}

// --- reads / mutations on existing posts ------------------------------------

export function getFeedView(worldId: string, playerId: string = DEFAULT_PLAYER_ID): FeedView {
  const posts = feedPostsRepo.listByWorld(worldId).map((p) => toPostView(p, playerId));
  return { posts };
}

/**
 * Toggle/upsert the player's reaction on a post. Re-sending the SAME kind turns
 * it off; a different kind replaces it. Returns the reassembled view.
 */
export function reactToPost(
  postId: string,
  kind: ReactionKind,
  playerId: string = DEFAULT_PLAYER_ID,
): FeedPostView {
  const existing = feedReactionsRepo.getByActor(postId, playerId);
  if (existing && existing.kind === kind) {
    feedReactionsRepo.delete(postId, playerId);
  } else {
    feedReactionsRepo.insert(
      FeedReactionSchema.parse({
        id: existing?.id ?? newId('freact'),
        postId,
        actorType: 'player',
        actorId: playerId,
        kind,
        createdAt: Date.now(),
      }),
    );
  }
  return reassemble(postId, playerId);
}

/**
 * The player comments on a post. If the post's author is an engaged character,
 * optionally generate ONE in-character reply (fail-safe). Returns the view.
 */
export async function commentOnPost(
  postId: string,
  body: string,
  playerId: string = DEFAULT_PLAYER_ID,
): Promise<FeedPostView> {
  const post = feedPostsRepo.get(postId);
  feedCommentsRepo.insert(
    FeedCommentSchema.parse({
      id: newId('fcmt'),
      postId,
      authorType: 'player',
      authorId: playerId,
      body,
      tone: '',
      createdAt: Date.now(),
    }),
  );

  // An engaged character whose post the player commented on may reply once.
  if (post && post.authorType === 'character') {
    const author = charactersRepo.get(post.authorId);
    if (author && hasDated(author.id)) {
      const rel = getRelationship(author.id);
      const settings = getLlmSettings();
      const playerName = getOrCreatePlayer(playerIdForWorldOrDefault(post.worldId)).name;
      const result = await callStructuredLlm(
        FeedCommentDraftSchema,
        buildFeedCommentMessages({
          character: author,
          relationship: rel,
          playerName,
          postAuthorName: author.name,
          postBody: post.body,
          postKind: post.kind,
          situation: `${playerName} just commented on your post: "${body}". Reply briefly, in character. ${commentSituation(rel)}`,
          memories: topMemoriesFor(author.id),
        }),
        { settings, task: `Write ${author.name}'s reply to the player's comment.`, schemaName: 'FeedCommentDraft' },
      );
      if (result.ok) {
        feedCommentsRepo.insert(
          FeedCommentSchema.parse({
            id: newId('fcmt'),
            postId,
            authorType: 'character',
            authorId: author.id,
            body: result.data.body,
            tone: result.data.tone,
            createdAt: Date.now(),
          }),
        );
      } else {
        recordEvent('feed_comment_failed', { characterId: author.id, error: result.error });
      }
    }
  }

  // The player just acted in the feed and sees any reply in the response — keep the
  // home-screen badge clear for content generated by their own interaction.
  if (post) markFeedSeen(post.worldId, playerId);

  return reassemble(postId, playerId);
}

export function markFeedSeen(worldId: string, playerId: string = DEFAULT_PLAYER_ID): void {
  feedSeenRepo.set(worldId, playerId, Date.now());
}

/** Unread = NPC posts + NPC comments in this world since the player last opened Faces. */
export function feedUnreadCount(worldId: string, playerId: string = DEFAULT_PLAYER_ID): number {
  const since = feedSeenRepo.get(worldId, playerId);
  return (
    feedPostsRepo.countCharacterPostsSince(worldId, since) +
    feedCommentsRepo.countCharacterCommentsSince(worldId, since)
  );
}

// --- view assembly ----------------------------------------------------------

/** Re-read a post by id and assemble its view. Throws 404 if it's gone. */
function reassemble(postId: string, playerId: string): FeedPostView {
  const post = feedPostsRepo.get(postId);
  if (!post) throw notFound('That post no longer exists.');
  return toPostView(post, playerId);
}

interface Display {
  name: string;
  portraitAssetId: string | null;
}

/** Resolve an author's display name + portrait. Returns null if a character was deleted.
 *  The player's display name uses the per-world persona (the post's world). */
function displayFor(
  authorType: 'player' | 'character',
  authorId: string,
  worldId: string,
): Display | null {
  if (authorType === 'player') {
    return { name: getOrCreatePlayer(playerIdForWorldOrDefault(worldId)).name, portraitAssetId: null };
  }
  const c = charactersRepo.get(authorId);
  if (!c) return null;
  return { name: c.name, portraitAssetId: c.portraitAssetId };
}

/** Assemble a stored FeedPost into the display FeedPostView. */
function toPostView(post: FeedPost, playerId: string): FeedPostView {
  const author = displayFor(post.authorType, post.authorId, post.worldId);

  // Reactions grouped by kind: exact count + up to 3 actor names. Skip the
  // reactions of any character that was deleted.
  const groups = new Map<ReactionKind, { count: number; actorNames: string[] }>();
  let playerReaction: ReactionKind | null = null;
  for (const r of feedReactionsRepo.listByPost(post.id)) {
    if (r.actorType === 'player' && r.actorId === playerId) playerReaction = r.kind;
    const disp = displayFor(r.actorType, r.actorId, post.worldId);
    if (!disp) continue;
    const g = groups.get(r.kind) ?? { count: 0, actorNames: [] };
    g.count += 1;
    if (g.actorNames.length < 3) g.actorNames.push(disp.name);
    groups.set(r.kind, g);
  }
  const reactions: FeedReactionView[] = [...groups.entries()].map(([kind, g]) => ({
    kind,
    count: g.count,
    actorNames: g.actorNames,
  }));

  const comments: FeedCommentView[] = [];
  for (const cm of feedCommentsRepo.listByPost(post.id)) {
    const disp = displayFor(cm.authorType, cm.authorId, post.worldId);
    if (!disp) continue; // author character was deleted
    comments.push({
      id: cm.id,
      authorType: cm.authorType,
      authorId: cm.authorId,
      authorName: disp.name,
      portraitAssetId: disp.portraitAssetId,
      body: cm.body,
      tone: cm.tone,
      createdAt: cm.createdAt,
    });
  }

  return {
    id: post.id,
    authorType: post.authorType,
    authorId: post.authorId,
    authorName: author?.name ?? 'Unknown',
    portraitAssetId: author?.portraitAssetId ?? null,
    body: post.body,
    kind: post.kind,
    mood: post.mood,
    dayNumber: post.dayNumber,
    createdAt: post.createdAt,
    reactions,
    playerReaction,
    comments,
  };
}
