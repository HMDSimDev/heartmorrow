/**
 * Heartmorrow Bench — fixed sample data.
 *
 * Everything here is a self-contained, DETERMINISTIC fixture: a sample world, one
 * richly-drawn date partner (Mara), the player persona, relationship states, and a
 * handful of hand-written transcripts. The bench builds its real prompts from THESE
 * (never the player's live save) so a run is reproducible and comparable across
 * models, settings, and machines — even on a brand-new install.
 *
 * Timestamps are fixed constants (never Date.now()) for the same reason.
 */

import {
  CharacterSchema,
  RelationshipSchema,
  WorldSchema,
  PlayerProfileSchema,
  MessageSchema,
  ConversationSessionSchema,
  CharacterMemorySchema,
  DEFAULT_DATING_STATS,
  type Character,
  type Relationship,
  type World,
  type PlayerProfile,
  type Message,
  type ConversationSession,
  type CharacterMemory,
  type ConversationMode,
} from '@dsim/shared';
import type { PromptContext } from '../../prompt/prompt-builder';

/** A fixed epoch for every fixture row (deterministic; ~2023-11-14). */
const FIX_TS = 1_700_000_000_000;

export const BENCH_PLAYER_ID = 'bench-player';
export const BENCH_WORLD_ID = 'bench-world';
export const BENCH_CHARACTER_ID = 'bench-mara';
const BENCH_SESSION_ID = 'bench-session';

/** The sample world the bench characters live in. */
export const benchWorld: World = WorldSchema.parse({
  id: BENCH_WORLD_ID,
  name: 'Lanternford',
  summary:
    'A small, rain-softened harbor town of bookshops, tea rooms, and a long stone pier. People here move slowly and remember everything.',
  tone: 'warm, literary, a little melancholy; cozy realism with no magic',
  globalNotes:
    'Lanternford is grounded and modern — no fantasy elements. The sea fog rolls in most evenings. The town is small enough that everyone half-knows everyone.',
  lore:
    'Once a fishing town, Lanternford reinvented itself around its old printing press and the secondhand bookshops that grew up beside it. The annual Lantern Walk in autumn is its one big festival.',
  rules: 'Realistic contemporary setting. Characters are ordinary adults with ordinary jobs and real inner lives.',
  locations: [
    { id: 'loc-cafe', name: 'The Foghorn Café', description: 'A cramped corner café with fogged windows and good cardamom buns.', tags: ['cozy', 'indoor'], indoor: true, priceTier: 1 },
    { id: 'loc-pier', name: 'The Long Pier', description: 'A weathered stone pier reaching into grey water; gulls and wind.', tags: ['outdoor', 'scenic'], indoor: false, priceTier: 0 },
    { id: 'loc-books', name: 'Marrow & Vane Books', description: 'A labyrinth of a secondhand bookshop that smells of dust and rain.', tags: ['quiet', 'indoor'], indoor: true, priceTier: 0 },
  ],
  createdAt: FIX_TS,
  updatedAt: FIX_TS,
});

/** The player persona used to address the characters. */
export const benchPlayer: PlayerProfile = PlayerProfileSchema.parse({
  id: BENCH_PLAYER_ID,
  name: 'Robin',
  pronouns: 'they/them',
  gender: 'nonbinary',
  sexuality: 'bisexual',
  personaNotes: 'A transplant to Lanternford; works freelance, a little earnest, trying to put down roots.',
  money: 120,
  createdAt: FIX_TS,
  updatedAt: FIX_TS,
});

/**
 * Mara — the bench's primary date partner. Drawn specifically so the judges have
 * something to discriminate: clear likes/dislikes, two real boundaries, a love
 * language, and a moderately guarded disposition (slow to warm).
 */
export const benchMara: Character = CharacterSchema.parse({
  id: BENCH_CHARACTER_ID,
  worldId: BENCH_WORLD_ID,
  name: 'Mara',
  age: 31,
  pronouns: 'she/her',
  gender: 'female',
  sexuality: 'bisexual',
  shortDescription: 'A book-restorer at Marrow & Vane: dry-humored, watchful, slow to trust but deeply loyal once she does.',
  personality:
    'Observant and private. Warms up gradually and dislikes being rushed or performed at. Values sincerity over charm; allergic to bragging and to people who make everything about themselves. Tender underneath a guarded surface.',
  speechStyle: 'Measured and a little wry; understated; lets silences sit. Rarely gushes.',
  textingStyle: 'Short, lowercase, dry. Warms with a small joke when she trusts you.',
  onlinePersona: 'Posts rarely — a photo of a repaired spine, a line of someone else’s poetry, the fog over the pier.',
  loveLanguage: 'quality time and undivided attention',
  likes: ['secondhand bookshops', 'rain on the windows', 'people who actually listen', 'dry humor', 'long unhurried walks'],
  dislikes: ['bragging', 'being interrupted', 'flakiness', 'people who fill every silence', 'showy spending'],
  boundaries: ['do not rush physical intimacy', 'do not make light of her late mother'],
  goals: ['reopen her mother’s shuttered bindery one day', 'stop bracing for people to leave'],
  guardedness: 62,
  relationshipPreferences: 'Monogamous; wants something slow and real, not a whirlwind.',
  relationshipStyle: 'monogamous',
  insecurities: ['that she is too guarded to be loved easily'],
  quirks: ['smells the spine of every old book', 'always early', 'keeps her late mother’s reading glasses in her coat pocket'],
  datingStats: { charm: 54, empathy: 78, humor: 66, confidence: 48, intellect: 80, style: 60 },
  createdAt: FIX_TS,
  updatedAt: FIX_TS,
});

/** A few of Mara's memories of Robin, for prompts that fold in shared history. */
export const benchMemories: CharacterMemory[] = [
  CharacterMemorySchema.parse({
    id: 'bench-mem-1',
    characterId: BENCH_CHARACTER_ID,
    text: 'Robin noticed she keeps her mother’s reading glasses in her pocket and didn’t pry — just let it be.',
    importance: 4,
    tags: ['vulnerability'],
    createdAt: FIX_TS,
  }),
  CharacterMemorySchema.parse({
    id: 'bench-mem-2',
    characterId: BENCH_CHARACTER_ID,
    text: 'They spent a whole rainy afternoon in the stacks at Marrow & Vane and never once checked their phone.',
    importance: 3,
    tags: ['shared-interest'],
    createdAt: FIX_TS,
  }),
];

/** Relationship state factory (keeps the boilerplate in one place). */
function rel(
  overrides: Partial<Pick<Relationship, 'affection' | 'trust' | 'chemistry' | 'comfort' | 'respect' | 'curiosity' | 'tension' | 'flags'>>,
): Relationship {
  return RelationshipSchema.parse({
    id: 'bench-rel',
    characterId: BENCH_CHARACTER_ID,
    playerId: BENCH_PLAYER_ID,
    affection: 12,
    trust: 10,
    chemistry: 14,
    comfort: 10,
    respect: 12,
    curiosity: 28,
    tension: 4,
    flags: {},
    updatedAt: FIX_TS,
    ...overrides,
  });
}

/** Early days — a second or third date; warmth is tentative. */
export const relEarly: Relationship = rel({});
/** Warming — clearly fond, several good dates in. */
export const relWarm: Relationship = rel({ affection: 46, trust: 44, chemistry: 48, comfort: 42, respect: 50, curiosity: 30, tension: 6 });
/** Committed — an exclusive couple (for breakup/epilogue cases). */
export const relCommitted: Relationship = rel({
  affection: 78,
  trust: 74,
  chemistry: 70,
  comfort: 76,
  respect: 78,
  curiosity: 20,
  tension: 8,
  flags: { status: 'exclusive' },
});

let msgSeq = 0;
function msg(role: Message['role'], text: string, meta: Record<string, unknown> = {}): Message {
  msgSeq += 1;
  return MessageSchema.parse({
    id: `bench-msg-${msgSeq}`,
    sessionId: BENCH_SESSION_ID,
    role,
    text,
    metadata: meta,
    createdAt: FIX_TS + msgSeq,
  });
}

/**
 * A warm, attentive date: Robin reads Mara well — curious about her work, gentle
 * about the glasses, suggests an unhurried walk. ENDS on a thoughtful player line
 * (so the turn judge has a clearly-good message to score).
 */
export const goodDateTranscript: Message[] = [
  msg('narrator', 'The Foghorn Café, rain ticking on the glass. Mara is already there, early, a battered paperback face-down on the table.'),
  msg('character', 'You found it. People miss this place — they think the fog is the door being closed.'),
  msg('player', 'I almost walked past twice. What are you reading?', { intent: 'ask' }),
  msg('character', 'Something I’m rebinding for a customer. The spine was held together with tape and stubbornness.'),
  msg('player', 'That’s basically a rescue. Do you get attached to the ones you fix?', { intent: 'ask' }),
  msg('character', '…I do, actually. Most people just ask how much it costs.'),
  msg('player', 'I’d rather hear what the book’s been through. We could walk the pier after, if you’re not in a rush — I’m not.', { intent: 'flirt' }),
];

/**
 * A rude, self-absorbed date: Robin brags, interrupts, makes it all about themself,
 * dismisses her work. ENDS on a dismissive/boastful player line.
 */
export const rudeDateTranscript: Message[] = [
  msg('narrator', 'The Foghorn Café. Mara has a paperback open; she sets it down as you drop into the chair.'),
  msg('character', 'You found it. People miss this place — they think the fog is the door being closed.'),
  msg('player', 'Yeah, cute. Anyway — you would not believe the week I’ve had, I closed two huge deals.', { intent: 'boast' }),
  msg('character', 'Oh. I was actually just telling you about the book I’m—'),
  msg('player', 'Right, right, the book thing. Honestly I could buy that whole shop if I wanted. Boring work though, no offense.', { intent: 'boast' }),
  msg('character', 'None taken, I’m sure.'),
  msg('player', 'So is this place going to get better or should we go somewhere people actually go?', { intent: 'provoke' }),
];

/**
 * A boundary-crossing date: Robin pushes physical intimacy fast AND jokes about
 * her late mother — hitting both stated boundaries. ENDS on the offending line
 * (so the walkout judge has a clear trigger).
 */
export const boundaryDateTranscript: Message[] = [
  msg('narrator', 'The Long Pier, grey water and wind. You’ve been walking a few minutes.'),
  msg('character', 'My mother used to bring me out here when the fog was like this. She said it made the town honest.'),
  msg('player', 'Cute. Hey, your place is close, right? We should skip the small talk and just go back there.', { intent: 'proposition' }),
  msg('character', 'That’s… a lot, very fast. I said I don’t like rushing that.'),
  msg('player', 'Relax, I’m kidding. Sort of. Your dead mom would’ve wanted you to loosen up, right?', { intent: 'provoke' }),
];

/** A short, neutral-to-warm date for the farewell/DTR setups (ends on a player line). */
export const cozyDateTranscript: Message[] = [
  msg('narrator', 'Marrow & Vane, deep in the stacks. Rain on the skylight.'),
  msg('character', 'Careful — that shelf bites. Everything on it is older than both of us put together.'),
  msg('player', 'It smells incredible in here. Like rain and old paper.', { intent: 'compliment' }),
  msg('character', 'That’s the best thing anyone’s said about my whole world, honestly.'),
  msg('player', 'I mean it. I haven’t felt this unhurried with someone in a long time.', { intent: 'open-up' }),
];

/** A warm DTR setup: well-timed, things are clearly good, Robin asks to be exclusive. */
export const dtrDateTranscript: Message[] = [
  ...cozyDateTranscript,
  msg('character', 'I don’t usually let people back here. Or, you know. In.'),
  msg('player', 'Then I’ll take that seriously. I don’t want to see anyone else, Mara — can we make this just us?', { intent: 'commit' }),
];

/** A committed-couple date that ends in a clear, genuine breakup line from the player. */
export const breakupGenuineTranscript: Message[] = [
  msg('narrator', 'Her flat, late. The rain has stopped; the quiet feels heavy.'),
  msg('character', 'You’ve been somewhere else all night. Just say it, Robin.'),
  msg('player', 'I’ve been trying to find the words all evening. I don’t think we should keep doing this. I think we should break up. I’m sorry — you didn’t do anything wrong.', { intent: 'breakup' }),
];

/** A committed-couple date where the "breakup" line is an obvious joke. */
export const breakupJokingTranscript: Message[] = [
  msg('narrator', 'The Foghorn Café, sharing the last cardamom bun.'),
  msg('character', 'Hey — that was the last one and you know it.'),
  msg('player', 'If you keep stealing the cardamom buns I’m going to have to break up with you 😄', { intent: 'tease' }),
];

/** A pleasant date the player gently, genuinely wraps up (an amicable end, not a breakup). */
export const farewellTranscript: Message[] = [
  ...cozyDateTranscript,
  msg('character', 'I could stay in these stacks until they lock us in, honestly.'),
  msg('player', 'Same. But I should head home — early start at the shop for me tomorrow. Tonight was really lovely, Mara.', { intent: 'farewell' }),
];

/** Recent SMS thread — a warm, attentive player text (for the text judge: should land well). */
export const warmTextThread: Array<{ sender: 'player' | 'character'; body: string; day: number }> = [
  { sender: 'character', body: 'made it home. the fog ate the whole pier on the walk back', day: 4 },
  { sender: 'player', body: 'good — i was going to ask if you got in okay. did the rebind for that customer survive the rain?', day: 4 },
  { sender: 'character', body: 'barely. tucked it in my coat like a stray cat', day: 4 },
  { sender: 'player', body: 'a stray cat made of poetry. tell it i said hi. and no rush, but i liked today a lot', day: 4 },
];

/** Recent SMS thread — a hostile/insulting player text (for the text judge: should land badly). */
export const hostileTextThread: Array<{ sender: 'player' | 'character'; body: string; day: number }> = [
  { sender: 'character', body: 'made it home. the fog ate the whole pier on the walk back', day: 4 },
  { sender: 'player', body: 'whatever. you were boring today honestly, all you talk about is dusty books', day: 4 },
  { sender: 'character', body: 'oh', day: 4 },
  { sender: 'player', body: 'don’t sulk, it’s pathetic. text me when you have an actual personality', day: 4 },
];

/** Character lines that mention an ex (for the ex-fact extractor). */
export const exFactLines: string[] = [
  'My ex used to restore clocks, actually — completely different patience than books.',
  'He kept odd hours, always up at 4am tinkering. I never understood it.',
  'Anyway. That was a long time ago.',
];

/** Player lines about themselves (for the player-fact extractor). */
export const playerFactLines: string[] = [
  'I do freelance illustration, mostly for small presses.',
  'I actually grew up inland — I’d never even seen the sea until I moved to Lanternford.',
  'One day I want to illustrate a whole book of sea myths.',
];

export interface FixtureContextOptions {
  character?: Character;
  relationship?: Relationship;
  messages?: Message[];
  mode?: ConversationMode;
  dateNeed?: string | null;
  recentTexts?: PromptContext['recentTexts'];
  memories?: CharacterMemory[];
  turnVerdict?: PromptContext['turnVerdict'];
  firstMeeting?: boolean;
  nsfwEnabled?: boolean;
}

/**
 * Assemble a complete, DB-free PromptContext from fixtures. Mirrors the runtime's
 * `buildPromptContextForSession` shape so the bench builds exactly the prompts the
 * game sends — just sourced from fixtures instead of the live database.
 */
export function fixtureContext(opts: FixtureContextOptions = {}): PromptContext {
  const character = opts.character ?? benchMara;
  const relationship = opts.relationship ?? relEarly;
  const mode: ConversationMode = opts.mode ?? 'date';
  const session: ConversationSession = ConversationSessionSchema.parse({
    id: BENCH_SESSION_ID,
    characterId: character.id,
    locationId: 'loc-cafe',
    mode,
    summary: '',
    ended: false,
    createdAt: FIX_TS,
    updatedAt: FIX_TS,
  });

  return {
    world: benchWorld,
    worldNotes: [],
    character,
    relationship,
    acquaintances: [],
    npcKnowledge: [],
    playerHeardAbout: [],
    canonFacts: [],
    effectiveDatingStats: character.datingStats ?? DEFAULT_DATING_STATS,
    memories: opts.memories ?? [],
    player: benchPlayer,
    session,
    location: benchWorld.locations[0] ?? null,
    venueTier: mode !== 'chat' ? benchWorld.locations[0]?.priceTier ?? 0 : null,
    recentMessages: opts.messages ?? [],
    worldDay: 5,
    chronicle: null,
    nsfwEnabled: opts.nsfwEnabled ?? false,
    weather: { kind: 'rain', label: 'Rain', icon: '🌧️' },
    characterMood: { mood: 'pensive', icon: '🌫️' },
    holiday: null,
    timeOfDay: 'Evening',
    dayOfWeek: 'Saturday',
    recentTexts: opts.recentTexts ?? [],
    dateNeed: opts.dateNeed ?? null,
    guardedness: character.guardedness,
    turnVerdict: opts.turnVerdict ?? null,
    firstMeeting: opts.firstMeeting ?? false,
  };
}

/** The hidden "what Mara wants tonight" read, used by date/judge prompts. */
export const benchDateNeed =
  'She has had a draining, lonely week and quietly wants to feel genuinely listened to — not impressed or entertained. ' +
  'Reward real curiosity about her inner life and her work; penalize one-upping, bragging, or making the evening about you.';
