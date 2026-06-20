import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CharacterMemorySchema,
  ConversationSessionSchema,
  DEFAULT_DATING_STATS,
  DEFAULT_PLAYER_ID,
  FEED_NPC_COMMENTERS_MAX,
  MessageSchema,
  NpcEdgeSchema,
} from '@dsim/shared';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import type { ChatRequest, ChatResult } from '../llm/types';
import { setAdapterOverride } from '../llm/provider';
import {
  charactersRepo,
  eventsRepo,
  feedCommentsRepo,
  feedPostsRepo,
  feedReactionsRepo,
  memoriesRepo,
  messagesRepo,
  npcEdgesRepo,
  sessionsRepo,
} from '../db/repositories';

/** A ScriptedAdapter that also records every request, so a test can assert what
 *  reached a prompt (e.g. the facts a character knows about a poster). */
class CapturingAdapter extends ScriptedAdapter {
  readonly requests: ChatRequest[] = [];
  override async chat(req: ChatRequest): Promise<ChatResult> {
    this.requests.push(req);
    return super.chat(req);
  }
}

/** All text content across every captured request (for substring assertions). */
function capturedText(adapter: CapturingAdapter): string {
  return adapter.requests
    .flatMap((r) => r.messages.map((m) => (typeof m.content === 'string' ? m.content : '')))
    .join('\n');
}
import { newId } from '../lib/ids';
import { createCharacter, updateCharacter } from './character-service';
import { getRelationship } from './relationship-service';
import { buildNpcFeedCommentMessages, buildNpcFeedPostMessages } from '../prompt/prompt-builder';
import { applyRelationshipChange } from './stat-service';
import { ensureWorldState } from './world-clock-service';
import { recordEvent } from './event-service';
import { exportAll, importAll } from './data-service';
import {
  commentOnPost,
  createPlayerPost,
  feedUnreadCount,
  generateFeedForDay,
  getFeedView,
  markFeedSeen,
  reactToPost,
} from './feed-service';

/** Make hasDated(characterId) true without going through the availability gate. */
function markDated(characterId: string): void {
  const now = Date.now();
  const s = sessionsRepo.insert(
    ConversationSessionSchema.parse({
      id: newId('sess'),
      characterId,
      locationId: null,
      mode: 'date',
      summary: '',
      ended: true,
      createdAt: now,
      updatedAt: now,
    }),
  );
  messagesRepo.insert(
    MessageSchema.parse({ id: newId('msg'), sessionId: s.id, role: 'player', text: 'hi', metadata: {}, createdAt: now }),
  );
}

/** Warm a relationship past the eligibility floor so the character will engage. */
function warmUp(characterId: string): void {
  applyRelationshipChange(
    characterId,
    { affection: 70, trust: 70, chemistry: 70, comfort: 70, respect: 70 },
    { source: 'test' },
  );
}

const postReply = (body: string, mood = 'wistful') => JSON.stringify({ body, mood });
const commentReply = (body: string, tone = 'warm') => JSON.stringify({ body, tone });

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('generateFeedForDay — event-driven NPC posts', () => {
  it("creates a 'jealousy' post from the hurt character after a jealousy_triggered event", async () => {
    const { world, character } = seedWorldAndCharacter();
    markDated(character.id); // the hurt character is, by definition, someone the player has dated
    warmUp(character.id);
    ensureWorldState(world.id); // day 1
    // Yesterday (day 1) the player's other dalliance came to light.
    recordEvent('jealousy_triggered', {
      characterId: character.id,
      otherCharacterId: null,
      link: null,
      committed: false,
      day: 1,
    });
    setAdapterOverride(new ScriptedAdapter([postReply('cant believe this. thought we had something.')]));

    await generateFeedForDay(world.id, 2);

    const posts = feedPostsRepo.listByWorld(world.id, 50);
    const jealousy = posts.filter((p) => p.kind === 'jealousy');
    expect(jealousy).toHaveLength(1);
    expect(jealousy[0]!.authorType).toBe('character');
    expect(jealousy[0]!.authorId).toBe(character.id);
    expect(jealousy[0]!.body).toContain('thought we had something');
  });

  it("creates a 'milestone' post from a linked ex when the subject hits a milestone", async () => {
    const { world, character: subject } = seedWorldAndCharacter();
    // An ex of the subject, whom the player has also dated, reacts to the news.
    const ex = createCharacter({
      worldId: world.id,
      name: 'Old Flame',
      age: 29,
      datingStats: DEFAULT_DATING_STATS,
      links: [{ targetId: subject.id, kind: 'ex' }],
    });
    markDated(ex.id);
    warmUp(ex.id);
    ensureWorldState(world.id); // day 1
    recordEvent('milestone_reached', { characterId: subject.id, band: 'close', label: 'close', day: 1 });
    setAdapterOverride(new ScriptedAdapter([postReply('happy for them. mostly.')]));

    await generateFeedForDay(world.id, 2);

    const milestone = feedPostsRepo.listByWorld(world.id, 50).filter((p) => p.kind === 'milestone');
    expect(milestone).toHaveLength(1);
    expect(milestone[0]!.authorType).toBe('character');
    expect(milestone[0]!.authorId).toBe(ex.id); // the linked onlooker, not the subject
  });

  it('is IDEMPOTENT — re-running the same day does not duplicate event-driven posts', async () => {
    const { world, character } = seedWorldAndCharacter();
    markDated(character.id);
    warmUp(character.id);
    ensureWorldState(world.id);
    recordEvent('jealousy_triggered', { characterId: character.id, link: null, committed: false, day: 1 });
    setAdapterOverride(new ScriptedAdapter([postReply('ouch.')]));

    await generateFeedForDay(world.id, 2);
    await generateFeedForDay(world.id, 2); // dev re-fire / second day-start pass

    const jealousy = feedPostsRepo.listByWorld(world.id, 50).filter((p) => p.kind === 'jealousy');
    expect(jealousy).toHaveLength(1);
  });
});

describe('createPlayerPost — synchronous comments + reactions', () => {
  it('returns a post carrying NPC comments and reactions', async () => {
    const { world, character } = seedWorldAndCharacter();
    markDated(character.id);
    warmUp(character.id);
    ensureWorldState(world.id);
    // Comment + reaction both reuse the FeedCommentDraft/NpcFeedPost JSON shapes;
    // a single valid comment payload satisfies the comment call (reactions need no LLM).
    setAdapterOverride(new ScriptedAdapter([commentReply('love this for you!! 💛')]));

    const { post } = await createPlayerPost({ body: 'best day in ages', worldId: world.id }, DEFAULT_PLAYER_ID);

    expect(post.authorType).toBe('player');
    expect(post.kind).toBe('status');
    expect(post.comments.length).toBeGreaterThanOrEqual(1);
    expect(post.comments.some((c) => c.authorId === character.id)).toBe(true);
    // The comment carries a tone from the draft, and the view assembles cleanly.
    expect(post.comments.find((c) => c.authorId === character.id)!.tone).toBe('warm');
    // NPC reactions on a player post are gated by a deterministic per-(post,char)
    // hash (no injectable rng in the contract), so we don't assert they fire here;
    // the reaction PATH is covered deterministically by the toggle tests below.
    expect(Array.isArray(post.reactions)).toBe(true);
  });

  it('skips a failed comment LLM call without throwing, still returning the post', async () => {
    const { world, character } = seedWorldAndCharacter();
    markDated(character.id);
    warmUp(character.id);
    ensureWorldState(world.id);
    // Invalid JSON → the structured caller exhausts its retries and returns ok:false.
    setAdapterOverride(new ScriptedAdapter(['not json at all']));

    const { post } = await createPlayerPost({ body: 'rough night', worldId: world.id }, DEFAULT_PLAYER_ID);

    expect(post.authorType).toBe('player');
    expect(post.comments).toHaveLength(0); // the failed comment was skipped, not inserted
    // The failure was recorded fail-safe, never thrown.
    expect(eventsRepo.list(50).some((e) => e.type === 'feed_comment_failed')).toBe(true);
  });
});

describe('player-post engagement — only people you have dated', () => {
  it('a character the player has NOT dated neither comments nor reacts on a player post', async () => {
    const { world, character } = seedWorldAndCharacter();
    warmUp(character.id); // warm, but never dated → ineligible for PLAYER-post engagement
    ensureWorldState(world.id);
    setAdapterOverride(new ScriptedAdapter([commentReply('hi!')]));

    const { post } = await createPlayerPost({ body: 'anyone out there?', worldId: world.id }, DEFAULT_PLAYER_ID);

    expect(post.comments).toHaveLength(0);
    expect(post.reactions).toHaveLength(0);
  });
});

describe('open authoring — the whole neighborhood posts to Faces', () => {
  it('an UNDATED character DOES author a day-start ambient post', async () => {
    const { world, character } = seedWorldAndCharacter();
    // No dating at all — a complete stranger to the player still posts about their day.
    ensureWorldState(world.id);
    setAdapterOverride(new ScriptedAdapter([postReply('what a day')]));

    // rng forced to 0 → passes the ambient gate (which any character may now clear).
    await generateFeedForDay(world.id, 2, DEFAULT_PLAYER_ID, () => 0);

    const posts = feedPostsRepo.listByWorld(world.id, 50);
    const life = posts.filter((p) => p.kind === 'life' && p.authorId === character.id);
    expect(life).toHaveLength(1);
    expect(life[0]!.authorType).toBe('character');
  });

  it("a stranger's 'life' post is NOT framed around the player (no relationship/memory leak)", async () => {
    const { world } = seedWorldAndCharacter();
    ensureWorldState(world.id);
    const adapter = new CapturingAdapter([postReply('what a day')]);
    setAdapterOverride(adapter);

    await generateFeedForDay(world.id, 2, DEFAULT_PLAYER_ID, () => 0);

    const text = capturedText(adapter);
    expect(text).not.toContain('Your relationship with');
    expect(text).not.toContain('THINGS YOU REMEMBER');
  });
});

describe('NPC ↔ NPC engagement — the social circle reacts to each other', () => {
  /** rng that lets exactly `posterId` author an ambient post, suppresses knowledge
   *  posts, forces NPC comment rolls (value 0), and suppresses NPC reactions. */
  const engagementRng = (posterId: string) => (seed: string) => {
    if (seed.includes('|ambient')) return seed.includes(posterId) ? 0 : 1;
    if (seed.includes('|knews')) return 1;
    if (seed.startsWith('feednpccmt|')) return 0;
    return 1; // reactions + anything else off
  };

  it("a FRIEND comments on another character's post — even though neither has been dated", async () => {
    const { world, character: a } = seedWorldAndCharacter();
    const b = createCharacter({
      worldId: world.id,
      name: 'Bestie',
      age: 28,
      datingStats: DEFAULT_DATING_STATS,
      links: [{ targetId: a.id, kind: 'friend' }],
    });
    ensureWorldState(world.id);
    setAdapterOverride(
      new ScriptedAdapter([postReply('rainy day, good book', 'cozy'), commentReply('that is SO you 📖', 'warm')]),
    );

    await generateFeedForDay(world.id, 2, DEFAULT_PLAYER_ID, engagementRng(a.id));

    const aPost = feedPostsRepo.listByWorld(world.id, 50).find((p) => p.authorId === a.id && p.kind === 'life');
    expect(aPost).toBeDefined();
    const view = getFeedView(world.id, DEFAULT_PLAYER_ID).posts.find((p) => p.id === aPost!.id)!;
    expect(view.comments.some((c) => c.authorId === b.id)).toBe(true);
  });

  it('a RIVAL stays quieter than a friend (lower comment chance)', async () => {
    const { world, character: a } = seedWorldAndCharacter();
    const friend = createCharacter({
      worldId: world.id,
      name: 'Pal',
      age: 27,
      datingStats: DEFAULT_DATING_STATS,
      links: [{ targetId: a.id, kind: 'friend' }],
    });
    const rival = createCharacter({
      worldId: world.id,
      name: 'Foe',
      age: 27,
      datingStats: DEFAULT_DATING_STATS,
      links: [{ targetId: a.id, kind: 'rival' }],
    });
    ensureWorldState(world.id);
    // A comment roll of 0.16 clears the friend gate (0.5) but not the rival gate (0.15).
    const rng = (seed: string) => {
      if (seed.includes('|ambient')) return seed.includes(a.id) ? 0 : 1;
      if (seed.includes('|knews')) return 1;
      if (seed.startsWith('feednpccmt|')) return 0.16;
      return 1;
    };
    setAdapterOverride(
      new ScriptedAdapter([postReply('grey skies today', 'flat'), commentReply('chin up!', 'warm')]),
    );

    await generateFeedForDay(world.id, 2, DEFAULT_PLAYER_ID, rng);

    const aPost = feedPostsRepo.listByWorld(world.id, 50).find((p) => p.authorId === a.id && p.kind === 'life')!;
    const view = getFeedView(world.id, DEFAULT_PLAYER_ID).posts.find((p) => p.id === aPost.id)!;
    expect(view.comments.some((c) => c.authorId === friend.id)).toBe(true);
    expect(view.comments.some((c) => c.authorId === rival.id)).toBe(false);
  });

  it('NPC↔NPC commenting is IDEMPOTENT across a re-run of the same day', async () => {
    const { world, character: a } = seedWorldAndCharacter();
    const b = createCharacter({
      worldId: world.id,
      name: 'Bestie',
      age: 28,
      datingStats: DEFAULT_DATING_STATS,
      links: [{ targetId: a.id, kind: 'friend' }],
    });
    ensureWorldState(world.id);
    setAdapterOverride(
      new ScriptedAdapter([postReply('rainy day, good book', 'cozy'), commentReply('that is SO you 📖', 'warm')]),
    );

    await generateFeedForDay(world.id, 2, DEFAULT_PLAYER_ID, engagementRng(a.id));
    await generateFeedForDay(world.id, 2, DEFAULT_PLAYER_ID, engagementRng(a.id)); // re-fire

    const aPost = feedPostsRepo.listByWorld(world.id, 50).find((p) => p.authorId === a.id && p.kind === 'life')!;
    const bComments = feedCommentsRepo.listByPost(aPost.id).filter((c) => c.authorId === b.id);
    expect(bComments).toHaveLength(1);
  });

  it('caps NPC comments even when MORE candidates pass, and a re-run adds NONE (cap idempotency)', async () => {
    const { world, character: a } = seedWorldAndCharacter();
    // Three chatty ties — a partner and two friends — all of whom pass the roll.
    createCharacter({
      worldId: world.id,
      name: 'Partner',
      age: 29,
      datingStats: DEFAULT_DATING_STATS,
      links: [{ targetId: a.id, kind: 'partner' }],
    });
    createCharacter({
      worldId: world.id,
      name: 'Friend One',
      age: 26,
      datingStats: DEFAULT_DATING_STATS,
      links: [{ targetId: a.id, kind: 'friend' }],
    });
    createCharacter({
      worldId: world.id,
      name: 'Friend Two',
      age: 27,
      datingStats: DEFAULT_DATING_STATS,
      links: [{ targetId: a.id, kind: 'friend' }],
    });
    ensureWorldState(world.id);
    setAdapterOverride(
      new ScriptedAdapter([
        postReply('long day', 'tired'),
        commentReply('here for you', 'warm'),
        commentReply('always', 'warm'),
        commentReply('should-not-be-used', 'warm'),
      ]),
    );

    await generateFeedForDay(world.id, 2, DEFAULT_PLAYER_ID, engagementRng(a.id));
    await generateFeedForDay(world.id, 2, DEFAULT_PLAYER_ID, engagementRng(a.id)); // re-fire

    const aPost = feedPostsRepo.listByWorld(world.id, 50).find((p) => p.authorId === a.id && p.kind === 'life')!;
    const npcComments = feedCommentsRepo.listByPost(aPost.id).filter((c) => c.authorType === 'character');
    // Capped at FEED_NPC_COMMENTERS_MAX (2), NOT 3 — and the re-run promoted no one.
    expect(npcComments).toHaveLength(FEED_NPC_COMMENTERS_MAX);
  });

  it('a linked NPC REACTS to another character post, idempotently (no LLM)', async () => {
    const { world, character: a } = seedWorldAndCharacter();
    const b = createCharacter({
      worldId: world.id,
      name: 'Bestie',
      age: 28,
      datingStats: DEFAULT_DATING_STATS,
      links: [{ targetId: a.id, kind: 'friend' }],
    });
    ensureWorldState(world.id);
    setAdapterOverride(new ScriptedAdapter([postReply('rainy day, good book', 'cozy')]));
    // Suppress comments, force the reaction roll.
    const rng = (seed: string) => {
      if (seed.includes('|ambient')) return seed.includes(a.id) ? 0 : 1;
      if (seed.includes('|knews')) return 1;
      if (seed.startsWith('feednpccmt|')) return 1;
      if (seed.startsWith('feednpcreact|')) return 0;
      return 1;
    };

    await generateFeedForDay(world.id, 2, DEFAULT_PLAYER_ID, rng);
    await generateFeedForDay(world.id, 2, DEFAULT_PLAYER_ID, rng); // re-fire

    const aPost = feedPostsRepo.listByWorld(world.id, 50).find((p) => p.authorId === a.id && p.kind === 'life')!;
    const reactions = feedReactionsRepo.listByPost(aPost.id).filter((r) => r.actorType === 'character');
    expect(reactions).toHaveLength(1);
    expect(reactions[0]!.actorId).toBe(b.id);
    expect(reactions[0]!.kind).toBe('like'); // a friend on an ordinary 'life' post → 'like'
  });

  it('a comment is driven by what the commenter actually knows (a shared memory reaches the prompt)', async () => {
    const { world, character: a } = seedWorldAndCharacter();
    const b = createCharacter({
      worldId: world.id,
      name: 'Bestie',
      age: 28,
      datingStats: DEFAULT_DATING_STATS,
      links: [{ targetId: a.id, kind: 'friend' }],
    });
    ensureWorldState(world.id);
    // b remembers a shared moment with a (relatedCharacterId === poster).
    memoriesRepo.insert(
      CharacterMemorySchema.parse({
        id: newId('mem'),
        characterId: b.id,
        text: 'You two ran the charity 5k together last spring.',
        importance: 4,
        tags: [],
        sourceEventId: null,
        relatedCharacterId: a.id,
        createdAt: Date.now(),
        lastUsedAt: null,
      }),
    );
    const adapter = new CapturingAdapter([postReply('feeling grateful', 'warm'), commentReply('what a day that was', 'warm')]);
    setAdapterOverride(adapter);

    await generateFeedForDay(world.id, 2, DEFAULT_PLAYER_ID, engagementRng(a.id));

    // The shared memory was fed into b's comment prompt.
    expect(capturedText(adapter)).toContain('charity 5k');
  });

  it('a world-sim acquaintance edge engages with the LOW acquaintance chance, not the friend chance', async () => {
    const { world, character: a } = seedWorldAndCharacter();
    const b = createCharacter({ worldId: world.id, name: 'Neighbor', age: 30, datingStats: DEFAULT_DATING_STATS });
    ensureWorldState(world.id);
    // A run-in acquaintance edge — no authored link between them.
    npcEdgesRepo.upsert(
      NpcEdgeSchema.parse({ worldId: world.id, aId: a.id, bId: b.id, warmth: 5, meetCount: 1, lastDay: 1, promoted: false }),
    );
    // 0.07 fails the acquaintance gate (0.06) — but WOULD pass a friend gate (0.5).
    const rng = (seed: string) => {
      if (seed.includes('|ambient')) return seed.includes(a.id) ? 0 : 1;
      if (seed.includes('|knews')) return 1;
      if (seed.startsWith('feednpccmt|')) return 0.07;
      return 1;
    };
    setAdapterOverride(new ScriptedAdapter([postReply('out on the stoop', 'easy'), commentReply('hey neighbor', 'warm')]));

    await generateFeedForDay(world.id, 2, DEFAULT_PLAYER_ID, rng);

    const aPost = feedPostsRepo.listByWorld(world.id, 50).find((p) => p.authorId === a.id && p.kind === 'life')!;
    const view = getFeedView(world.id, DEFAULT_PLAYER_ID).posts.find((p) => p.id === aPost.id)!;
    expect(view.comments.some((c) => c.authorId === b.id)).toBe(false);
  });

  it('a PROMOTED world-sim edge is treated as a friend for engagement', async () => {
    const { world, character: a } = seedWorldAndCharacter();
    const b = createCharacter({ worldId: world.id, name: 'Grown Close', age: 30, datingStats: DEFAULT_DATING_STATS });
    ensureWorldState(world.id);
    npcEdgesRepo.upsert(
      NpcEdgeSchema.parse({ worldId: world.id, aId: a.id, bId: b.id, warmth: 40, meetCount: 6, lastDay: 1, promoted: true }),
    );
    // 0.4 passes the friend gate (0.5) but not the acquaintance gate (0.06).
    const rng = (seed: string) => {
      if (seed.includes('|ambient')) return seed.includes(a.id) ? 0 : 1;
      if (seed.includes('|knews')) return 1;
      if (seed.startsWith('feednpccmt|')) return 0.4;
      return 1;
    };
    setAdapterOverride(new ScriptedAdapter([postReply('out on the stoop', 'easy'), commentReply('proud of you', 'warm')]));

    await generateFeedForDay(world.id, 2, DEFAULT_PLAYER_ID, rng);

    const aPost = feedPostsRepo.listByWorld(world.id, 50).find((p) => p.authorId === a.id && p.kind === 'life')!;
    const view = getFeedView(world.id, DEFAULT_PLAYER_ID).posts.find((p) => p.id === aPost.id)!;
    expect(view.comments.some((c) => c.authorId === b.id)).toBe(true);
  });
});

describe('feed prompt — posting style + player framing', () => {
  it('foregrounds onlinePersona and omits player framing on a life post', () => {
    const { world } = seedWorldAndCharacter();
    const c = createCharacter({ worldId: world.id, name: 'Poster', age: 26, datingStats: DEFAULT_DATING_STATS });
    updateCharacter(c.id, { onlinePersona: 'cryptic one-liners, never capitalizes', textingStyle: 'all lowercase' });
    const msgs = buildNpcFeedPostMessages({
      character: charactersRepo.get(c.id)!,
      kind: 'life',
      situation: 'A quiet rainy day.',
    });
    const sys = msgs[0]!.content as string;
    expect(sys).toContain('cryptic one-liners');
    expect(sys).not.toContain('Your relationship with'); // a life post is not framed around the player
  });

  it('includes the player relationship framing on a jealousy post', () => {
    const { character } = seedWorldAndCharacter();
    const msgs = buildNpcFeedPostMessages({
      character,
      kind: 'jealousy',
      situation: 'You found out they have been seeing someone else.',
      playerContext: { playerName: 'Robin', relationship: getRelationship(character.id), memories: [] },
    });
    expect(msgs[0]!.content as string).toContain('Your relationship with Robin');
  });

  it('an NPC↔NPC comment carries the relationship + what they know about the poster', () => {
    const { world, character: poster } = seedWorldAndCharacter();
    const friend = createCharacter({ worldId: world.id, name: 'Pal', age: 27, datingStats: DEFAULT_DATING_STATS });
    const msgs = buildNpcFeedCommentMessages({
      commenter: charactersRepo.get(friend.id)!,
      posterName: poster.name,
      postBody: 'new haircut!',
      postKind: 'life',
      linkKind: 'friend',
      knownAboutPoster: ['You two grabbed coffee last week.'],
    });
    expect(msgs[0]!.content as string).toContain('a friend of yours');
    expect(msgs[1]!.content as string).toContain('grabbed coffee');
  });
});

describe('player reactions — toggle semantics', () => {
  it('reacting with the same kind twice ends with no player reaction', async () => {
    const { world } = seedWorldAndCharacter();
    ensureWorldState(world.id);
    // No eligible NPCs, so this post gets no NPC engagement — clean canvas.
    setAdapterOverride(new ScriptedAdapter([commentReply('x')]));
    const { post } = await createPlayerPost({ body: 'hello world', worldId: world.id }, DEFAULT_PLAYER_ID);

    const afterFirst = reactToPost(post.id, 'love', DEFAULT_PLAYER_ID);
    expect(afterFirst.playerReaction).toBe('love');

    const afterSecond = reactToPost(post.id, 'love', DEFAULT_PLAYER_ID);
    expect(afterSecond.playerReaction).toBeNull();
    // The toggle removed the row entirely (no orphaned reaction).
    expect(feedReactionsRepo.getByActor(post.id, DEFAULT_PLAYER_ID)).toBeUndefined();
  });

  it('switching to a different kind replaces the reaction', async () => {
    const { world } = seedWorldAndCharacter();
    ensureWorldState(world.id);
    setAdapterOverride(new ScriptedAdapter([commentReply('x')]));
    const { post } = await createPlayerPost({ body: 'switch test', worldId: world.id }, DEFAULT_PLAYER_ID);

    reactToPost(post.id, 'like', DEFAULT_PLAYER_ID);
    const after = reactToPost(post.id, 'laugh', DEFAULT_PLAYER_ID);
    expect(after.playerReaction).toBe('laugh');
  });
});

describe('unread badge', () => {
  it('markFeedSeen clears the unread count', async () => {
    const { world, character } = seedWorldAndCharacter();
    markDated(character.id);
    warmUp(character.id);
    ensureWorldState(world.id);
    recordEvent('jealousy_triggered', { characterId: character.id, link: null, committed: false, day: 1 });
    setAdapterOverride(new ScriptedAdapter([postReply('hurt.')]));

    await generateFeedForDay(world.id, 2);
    expect(feedUnreadCount(world.id, DEFAULT_PLAYER_ID)).toBeGreaterThan(0);

    markFeedSeen(world.id, DEFAULT_PLAYER_ID);
    expect(feedUnreadCount(world.id, DEFAULT_PLAYER_ID)).toBe(0);
  });
});

describe('NARRATIVE-ONLY — a full feed cycle never changes stats', () => {
  it('records ZERO relationship_change events across generate + post + comment + react', async () => {
    const { world, character } = seedWorldAndCharacter();
    markDated(character.id);
    warmUp(character.id);
    ensureWorldState(world.id);
    recordEvent('jealousy_triggered', { characterId: character.id, link: null, committed: false, day: 1 });

    // From here on, NOTHING the feed does should emit a relationship_change.
    const baseline = eventsRepo.list(1000).filter((e) => e.type === 'relationship_change').length;
    setAdapterOverride(new ScriptedAdapter([commentReply('right here with you 💛')]));

    await generateFeedForDay(world.id, 2);
    const { post } = await createPlayerPost({ body: 'feeling a lot today', worldId: world.id }, DEFAULT_PLAYER_ID);
    reactToPost(post.id, 'love', DEFAULT_PLAYER_ID);
    await commentOnPost(post.id, 'thanks everyone', DEFAULT_PLAYER_ID);

    const after = eventsRepo.list(1000).filter((e) => e.type === 'relationship_change').length;
    expect(after).toBe(baseline);
  });
});

describe('export / import round-trip', () => {
  it('preserves feed posts, comments, and reactions', async () => {
    const { world, character } = seedWorldAndCharacter();
    markDated(character.id);
    warmUp(character.id);
    ensureWorldState(world.id);
    setAdapterOverride(new ScriptedAdapter([commentReply('so happy for you')]));

    const { post } = await createPlayerPost({ body: 'round-trip me', worldId: world.id }, DEFAULT_PLAYER_ID);
    reactToPost(post.id, 'love', DEFAULT_PLAYER_ID);

    const postsBefore = feedPostsRepo.list().length;
    const commentsBefore = feedCommentsRepo.list().length;
    const reactionsBefore = feedReactionsRepo.list().length;
    expect(postsBefore).toBeGreaterThan(0);
    expect(commentsBefore).toBeGreaterThan(0);
    expect(reactionsBefore).toBeGreaterThan(0);

    importAll(exportAll());

    expect(feedPostsRepo.list().length).toBe(postsBefore);
    expect(feedCommentsRepo.list().length).toBe(commentsBefore);
    expect(feedReactionsRepo.list().length).toBe(reactionsBefore);

    // The body survives the round-trip and re-assembles into the view.
    const view = getFeedView(world.id, DEFAULT_PLAYER_ID);
    expect(view.posts.some((p) => p.body === 'round-trip me')).toBe(true);
  });

  it('round-trips a character carrying all 9 new profile fields', () => {
    const { world } = seedWorldAndCharacter();
    const rich = createCharacter({
      worldId: world.id,
      name: 'Profiled Person',
      age: 27,
      datingStats: DEFAULT_DATING_STATS,
    });
    updateCharacter(rich.id, {
      appearance: 'tall, ink-stained fingers, a habit of rolled-up sleeves',
      physicalNeeds: ['quiet mornings', 'strong coffee'],
      physicalDesires: ['slow dancing'],
      physicalDislikes: ['crowded rooms'],
      textingStyle: 'lowercase, lots of em-dashes',
      onlinePersona: 'posts black-and-white photos and terse captions',
      loveLanguage: 'acts of service',
      insecurities: ['being forgotten'],
      quirks: ['names every houseplant'],
    });

    importAll(exportAll());

    const restored = charactersRepo.get(rich.id)!;
    expect(restored.appearance).toBe('tall, ink-stained fingers, a habit of rolled-up sleeves');
    expect(restored.physicalNeeds).toEqual(['quiet mornings', 'strong coffee']);
    expect(restored.physicalDesires).toEqual(['slow dancing']);
    expect(restored.physicalDislikes).toEqual(['crowded rooms']);
    expect(restored.textingStyle).toBe('lowercase, lots of em-dashes');
    expect(restored.onlinePersona).toBe('posts black-and-white photos and terse captions');
    expect(restored.loveLanguage).toBe('acts of service');
    expect(restored.insecurities).toEqual(['being forgotten']);
    expect(restored.quirks).toEqual(['names every houseplant']);
  });
});
