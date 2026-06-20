/**
 * Seed script: populates a fresh database with one sample world, several world
 * notes, three original adult characters, default relationships, and a set of
 * shop items. No copyrighted characters, no AI art, no network calls.
 *
 * Run with: `pnpm --filter @dsim/server run seed`
 */
import { initDatabase } from './db/index';
import { ensureDirectories } from './config';
import { worldsRepo } from './db/repositories';
import { createWorld, createWorldNote } from './services/world-service';
import { createCharacter, updateCharacter } from './services/character-service';
import { createShopItem } from './services/shop-service';
import { createProperty } from './services/property-service';
import { createCompany } from './services/market-service';
import { getOrCreatePlayer } from './services/player-service';
import { newId, playerIdForWorld } from './lib/ids';

function seed(): void {
  ensureDirectories();
  initDatabase();

  if (worldsRepo.list().length > 0 && process.env.FORCE_SEED !== '1') {
    // eslint-disable-next-line no-console
    console.log('Database already has data. Set FORCE_SEED=1 to add the seed data anyway.');
    return;
  }

  const cafe = { id: newId('loc'), name: 'Café Lumen', description: 'A sunlit corner café famous for cardamom lattes.', tags: ['cozy', 'public'], indoor: true, priceTier: 1 };
  const glasshouse = { id: newId('loc'), name: 'The Glasshouse', description: 'A community rooftop greenhouse full of rare plants.', tags: ['quiet', 'romantic'], indoor: true, priceTier: 2 };
  const boardwalk = { id: newId('loc'), name: 'Riverside Boardwalk', description: 'A string-lit walk along the slow river, busiest at dusk.', tags: ['outdoors'], indoor: false, priceTier: 0 };
  const vinyl = { id: newId('loc'), name: 'Vinyl & Vine', description: 'A record bar where a piano gets played most nights.', tags: ['music', 'nightlife'], indoor: true, priceTier: 1 };
  const aurora = { id: newId('loc'), name: 'The Aurora Room', description: 'A candlelit rooftop restaurant with a tasting menu and a view over the whole Quarter.', tags: ['fine dining', 'romantic', 'upscale'], indoor: true, priceTier: 3 };

  const world = createWorld({
    name: 'The Lumen Quarter',
    summary:
      'A warm, slice-of-life arts district in a modern city — cafés, greenhouses, river walks, and small music venues where neighbors become something more.',
    tone: 'Cozy, hopeful, character-driven romance with gentle humor.',
    globalNotes: 'People here value sincerity over flash. Rumors travel fast along the boardwalk.',
    rules: 'No magic or sci-fi; this is grounded contemporary fiction.',
    lore: 'The Quarter was an old textile district reclaimed by artists a generation ago.',
    locations: [cafe, glasshouse, boardwalk, vinyl, aurora],
    contentFlags: { allowRomance: true, allowMatureThemes: false, intensity: 'mild' },
    // The mock world ships with the wealth + casino systems ON to showcase them.
    featureFlags: { property: true, stockMarket: true, gambling: true },
  });

  // This world's self-contained player save (money + persona live per-world).
  getOrCreatePlayer(playerIdForWorld(world.id));

  createWorldNote(world.id, {
    title: 'The Lantern Festival',
    body: 'Every autumn the Quarter floats paper lanterns down the river. A popular (and very romantic) date night.',
    tags: ['event', 'romance'],
    scope: 'lore',
    importance: 4,
  });
  createWorldNote(world.id, {
    title: 'Café Lumen regulars',
    body: 'The café is a social hub; most characters pass through it weekly. The barista, Pip, knows everyone.',
    tags: ['location', 'social'],
    scope: 'location',
    importance: 3,
  });
  createWorldNote(world.id, {
    title: 'Tone guidance',
    body: 'Keep conflict low-stakes and interpersonal. Warmth and wit over melodrama.',
    tags: ['tone'],
    scope: 'rule',
    importance: 5,
  });

  const mira = createCharacter({
    worldId: world.id,
    name: 'Mira Vale',
    age: 27,
    pronouns: 'she/her',
    gender: 'female',
    sexuality: 'straight',
    shortDescription: 'A botanist who runs the rooftop Glasshouse and never met a plant pun she didn’t like.',
    personality: 'Warm, curious, quietly confident. Notices small details about people. Tends to deflect compliments with humor.',
    creatorNotes: 'Softens quickly when someone shows genuine curiosity about her work. Dislikes being rushed.',
    speechStyle: 'Warm and playful, peppered with plant metaphors; thoughtful pauses.',
    likes: ['rare orchids', 'rainy afternoons', 'strong coffee', 'honest questions'],
    dislikes: ['small talk that goes nowhere', 'wasted food'],
    boundaries: ['No pressure to drink alcohol', 'Takes things slowly'],
    goals: ['Open the Glasshouse to the public', 'Find someone who listens'],
    relationshipPreferences: 'Slow burn; values emotional safety and shared curiosity.',
    favoriteWeather: ['rainy', 'cloudy'],
    dislikedWeather: ['stormy'],
    employment: { title: 'Botanist', place: 'The Glasshouse', workdays: [0, 1, 2, 3, 4, 5], shiftPhase: 'morning' },
    allowsExCanonization: true, // Dorian (her ex) can reveal facts about her on a date
    datingStats: { charm: 62, empathy: 78, humor: 66, confidence: 58, intellect: 72, style: 55 },
    appearance:
      'Tall and unhurried, with soil-dusted hands and dark curls she keeps pinning back. Wears earth-toned linen and a faded canvas apron with seed packets in the pockets; a smudge of greenhouse dirt is practically part of her look.',
    textingStyle:
      'Lowercase, gentle, a little rambly. Sends one thoughtful paragraph instead of three quick lines. Leaf and plant emoji, lots of "haha" and trailing ellipses…',
    onlinePersona:
      'An earnest, low-volume poster — close-up photos of leaves, quiet observations, and sincere replies. Rarely vague; if she posts, she means it.',
    loveLanguage: 'Quality time — slow, undivided attention',
    physicalNeeds: ['natural light', 'her hands in soil', 'unhurried mornings'],
    physicalDesires: ['the smell of rain on warm stone', 'someone who leans in close to listen', 'warm hands'],
    physicalDislikes: ['fluorescent light', 'overpowering cologne', 'being rushed out the door'],
    insecurities: ['fears she comes across as boring', 'worries she gives too much, too soon'],
    quirks: ['names her plants', 'answers questions with plant metaphors', 'deflects compliments with a joke'],
    expressionAssets: {},
  });

  const dorian = createCharacter({
    worldId: world.id,
    name: 'Dorian Ash',
    age: 31,
    pronouns: 'he/him',
    gender: 'male',
    sexuality: 'bisexual',
    shortDescription: 'The jazz pianist who closes out most nights at Vinyl & Vine. Brooding exterior, soft center.',
    personality: 'Reserved and observant, dry sense of humor, fiercely loyal once you’re in. Hates phoniness.',
    creatorNotes: 'Opens up through music rather than words. Test his sincerity and he respects you more.',
    speechStyle: 'Low-key and measured, dry wit, occasional musical metaphors.',
    likes: ['late-night sets', 'vinyl records', 'rain on windows', 'sincerity'],
    dislikes: ['phoniness', 'people who talk during the music'],
    boundaries: ['Needs alone time to recharge', 'No mind games'],
    goals: ['Record an album of his own', 'Trust someone again'],
    relationshipPreferences: 'Guarded at first; deep and devoted once trust is earned.',
    favoriteWeather: ['rainy', 'foggy'],
    dislikedWeather: ['sunny'],
    employment: { title: 'Jazz pianist', place: 'Vinyl & Vine', workdays: [3, 4, 5, 6], shiftPhase: 'evening' },
    allowsExCanonization: true, // Mira (his ex) can reveal facts about him on a date
    datingStats: { charm: 70, empathy: 60, humor: 64, confidence: 74, intellect: 68, style: 71 },
    appearance:
      'Lean and a little tired around the eyes, with stubble he never quite commits to and dark hair pushed back. Dresses in well-worn charcoal and black — a good coat, a rolled sleeve, one ring he turns when he is thinking.',
    textingStyle:
      'Sparse and dry. Full sentences, proper punctuation, no emoji. Long silences then a single, precise line that lands harder than it should.',
    onlinePersona:
      'A lurker. Posts maybe twice a month — a cryptic lyric, a photo of a setlist, a one-liner that reads like the end of a song. Likes things quietly rather than commenting.',
    loveLanguage: 'Acts of service — showing up, fixing things, staying',
    physicalNeeds: ['quiet to recharge', 'a piano within reach', 'late nights, slow mornings'],
    physicalDesires: ['rain against a window', 'a low steady voice', 'someone who sits close and says nothing'],
    physicalDislikes: ['loud rooms', 'people talking over the music', 'bright midday sun'],
    insecurities: ['braces for people to leave', 'fears he is colder than he means to be'],
    quirks: ['talks in musical metaphors', 'taps rhythms on tabletops', 'goes silent instead of arguing'],
    expressionAssets: {},
  });

  const sage = createCharacter({
    worldId: world.id,
    name: 'Sage Okonkwo',
    age: 24,
    pronouns: 'they/them',
    gender: 'nonbinary',
    sexuality: 'bisexual',
    shortDescription: 'An indie game developer fueled by spicy noodles, co-op games, and relentless optimism.',
    personality: 'Bubbly, nerdy, generous, talks fast when excited. Wears their heart on their sleeve.',
    creatorNotes: 'Lights up at shared enthusiasm. Gets shy when complimented directly.',
    speechStyle: 'Fast and enthusiastic, lots of pop-culture and gaming references, kind teasing.',
    likes: ['co-op games', 'spicy noodles', 'terrible puns', 'late-night brainstorms'],
    dislikes: ['spoilers', 'gatekeeping'],
    boundaries: ['No put-downs about their hobbies'],
    goals: ['Ship their dream game', 'Find a player two for life'],
    relationshipPreferences: 'Fast friends to lovers; thrives on playfulness and shared projects.',
    relationshipStyle: 'polyamorous',
    favoriteWeather: ['sunny', 'clear'],
    dislikedWeather: ['rainy', 'foggy'],
    employment: { title: 'Indie game developer', place: 'Home studio', workdays: [0, 1, 2, 3, 4], shiftPhase: 'evening' },
    datingStats: { charm: 66, empathy: 70, humor: 80, confidence: 60, intellect: 74, style: 52 },
    appearance:
      'Compact and kinetic, always mid-gesture, with an undercut dyed a different color most months and a rotating wardrobe of game-reference tees and bright sneakers. Has the under-eye glow of someone who codes past 3am and means it.',
    textingStyle:
      'Fast and bubbly — multiple bubbles in a row, ALL-CAPS hype, emoji clusters, keysmashes when excited (asdfgh), and a "!!!" where a period should be.',
    onlinePersona:
      'A chronic oversharer and hype-friend. Posts devlog screenshots, dramatic noodle reviews, and the first, loudest supportive comment on everyone else’s posts.',
    loveLanguage: 'Words of affirmation — loud, frequent, sincere',
    physicalNeeds: ['snacks within reach', 'good headphones', 'a comfy chair for long sessions'],
    physicalDesires: ['couch-cuddle co-op nights', 'a partner who laughs at the bit', 'shared spicy food'],
    physicalDislikes: ['silent tension', 'someone reading over their shoulder', 'cold disinterest'],
    insecurities: ['worries they are "too much"', 'fears their dream game will never ship'],
    quirks: ['narrates life like a tutorial', 'terrible puns on purpose', 'gets shy and quiet when complimented directly'],
    expressionAssets: {},
  });

  // The social web: Mira & Dorian are exes (jealousy fuel); both are friends with
  // Sage, who becomes the gossip hub of the Quarter.
  updateCharacter(mira.id, {
    links: [
      { targetId: dorian.id, kind: 'ex' },
      { targetId: sage.id, kind: 'friend' },
    ],
  });
  updateCharacter(dorian.id, {
    links: [
      { targetId: mira.id, kind: 'ex' },
      { targetId: sage.id, kind: 'friend' },
    ],
  });
  updateCharacter(sage.id, {
    links: [
      { targetId: mira.id, kind: 'friend' },
      { targetId: dorian.id, kind: 'friend' },
    ],
  });

  const items = [
    {
      name: 'Coffee Coupon',
      description: 'A free cardamom latte at Café Lumen. A small, easy gesture.',
      price: 20,
      category: 'consumable' as const,
      rarity: 'common' as const,
      effects: [
        { kind: 'relationship' as const, stat: 'comfort' as const, delta: 3 },
        { kind: 'relationship' as const, stat: 'affection' as const, delta: 2 },
      ],
      infiniteStock: true,
      stock: 0,
    },
    {
      name: 'Conversation Cards',
      description: 'A deck of thoughtful questions to spark real conversation.',
      price: 35,
      category: 'consumable' as const,
      rarity: 'uncommon' as const,
      effects: [
        { kind: 'relationship' as const, stat: 'curiosity' as const, delta: 4 },
        { kind: 'relationship' as const, stat: 'trust' as const, delta: 3 },
      ],
      infiniteStock: true,
      stock: 0,
    },
    {
      name: 'Nice Outfit',
      description: 'A sharp outfit that boosts your style for a few outings.',
      price: 80,
      category: 'apparel' as const,
      rarity: 'rare' as const,
      effects: [{ kind: 'temp_buff' as const, stat: 'style' as const, delta: 8, durationSessions: 3 }],
      infiniteStock: true,
      stock: 0,
    },
    {
      name: 'Bouquet of Lanterns',
      description: 'Hand-tied seasonal flowers from the Glasshouse. Limited stock.',
      price: 50,
      category: 'gift' as const,
      rarity: 'rare' as const,
      effects: [{ kind: 'relationship' as const, stat: 'affection' as const, delta: 6 }],
      infiniteStock: false,
      stock: 5,
    },
    {
      name: 'Book of Local Lore',
      description: 'A slim history of the Lumen Quarter. Impresses the well-read.',
      price: 60,
      category: 'book' as const,
      rarity: 'uncommon' as const,
      effects: [
        { kind: 'dating' as const, stat: 'intellect' as const, delta: 3 },
        { kind: 'relationship' as const, stat: 'respect' as const, delta: 4 },
      ],
      infiniteStock: true,
      stock: 0,
    },
  ];
  for (const item of items) {
    createShopItem({ ...item, assetId: null });
  }

  // --- Property: places to lease (recurring rent) or buy to own --------------
  const properties = [
    {
      name: 'Boardwalk Studio',
      description: 'A snug one-room studio over the river walk — string lights, a hot plate, and the best people-watching in the Quarter.',
      category: 'social' as const,
      buyPrice: 3200,
      rentAmount: 10,
      rentCadence: 'daily' as const,
      indoor: true,
      tags: ['cozy', 'low-key'],
      buffStat: 'comfort' as const,
      buffAmount: 2,
    },
    {
      name: 'The Riverside Loft',
      description: 'A sunlit loft with worn floorboards and a window seat made for slow mornings. Quietly romantic.',
      category: 'residence' as const,
      buyPrice: 6800,
      rentAmount: 140,
      rentCadence: 'weekly' as const,
      indoor: true,
      tags: ['cozy', 'home', 'romantic'],
      buffStat: 'comfort' as const,
      buffAmount: 3,
    },
    {
      name: 'The Glasshouse Annex',
      description: 'A private greenhouse flat tucked beside Mira’s rooftop garden — warm, green, and humming with rare blooms.',
      category: 'retreat' as const,
      buyPrice: 13500,
      rentAmount: 280,
      rentCadence: 'weekly' as const,
      indoor: true,
      tags: ['romantic', 'plants', 'quiet'],
      buffStat: 'chemistry' as const,
      buffAmount: 4,
    },
    {
      name: 'The Aurora Penthouse',
      description: 'The Quarter’s most coveted address — a candlelit penthouse with a glass terrace and the whole skyline at your feet.',
      category: 'estate' as const,
      buyPrice: 42000,
      rentAmount: 3200,
      rentCadence: 'monthly' as const,
      indoor: true,
      tags: ['lavish', 'view', 'romantic'],
      buffStat: 'affection' as const,
      buffAmount: 5,
    },
  ];
  for (const p of properties) {
    createProperty({ worldId: world.id, ...p, assetId: null });
  }

  // --- Stock market: fictional companies of the Quarter, some tied to the cast ---
  const companies = [
    { name: 'Lumen Roasters', ticker: 'LMN', description: 'The café group behind every cardamom latte in the Quarter.', sector: 'consumer' as const, basePrice: 120, volatility: 0.03, dividendPerShare: 2, linkedCharacterId: null },
    { name: 'Glasshouse Botanicals', ticker: 'GLAS', description: 'Rare plants, cuttings, and greenhouse design — Mira’s rooftop venture gone citywide.', sector: 'health' as const, basePrice: 240, volatility: 0.05, dividendPerShare: 4, linkedCharacterId: mira.id },
    { name: 'Vinyl & Vine Media', ticker: 'VINE', description: 'A small record label and the music room where Dorian closes out the night.', sector: 'media' as const, basePrice: 85, volatility: 0.08, dividendPerShare: 0, linkedCharacterId: dorian.id },
    { name: 'Pixelforge Studios', ticker: 'PXL', description: 'A scrappy indie game studio chasing its breakout hit — Sage’s baby.', sector: 'tech' as const, basePrice: 60, volatility: 0.12, dividendPerShare: 0, linkedCharacterId: sage.id },
    { name: 'Quarter Realty Trust', ticker: 'QRT', description: 'The steady hand behind the district’s lofts, greenhouses, and river-walk rents.', sector: 'realty' as const, basePrice: 300, volatility: 0.02, dividendPerShare: 5, linkedCharacterId: null },
  ];
  for (const c of companies) {
    createCompany({ worldId: world.id, ...c, assetId: null });
  }

  // eslint-disable-next-line no-console
  console.log('Seed complete: 1 world, 3 notes, 3 characters, 5 shop items, 4 properties, 5 companies.');
}

seed();
