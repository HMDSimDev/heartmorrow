import {
  PHASE_KEYS,
  deriveCalendar,
  type Character,
  type Location,
  type LocationKind,
  type Phase,
  type World,
} from '@dsim/shared';
import { charactersRepo, worldsRepo } from '../db/repositories';
import { hashFloat } from '../lib/seeded-random';
import { getSocialWeb } from './character-service';

/**
 * Where everyone is, per time-block — the spine of location-based discovery.
 *
 * DERIVED on read (never stored), exactly like weather / DND availability: a pure
 * function of (worldId, day, phase, characterId) seeded through `hashFloat`, so it is
 * stable for the block, replay-safe, and queryable mid-day with no persistence.
 *
 * The three ACTIVE phases are when people are out and about; NIGHT is "everyone home"
 * unless a venue opts into nightlife (`openPhases` includes 'night') with a worker on a
 * night shift or a regular who haunts it. We do NOT force-fill empty rooms — the UI
 * surfaces occupancy counts so the player heads toward life (decision 5).
 */

const ACTIVE_PHASES: readonly Phase[] = ['morning', 'afternoon', 'evening'];
/** How strongly a character leans toward one of their `haunts` in free placement. */
const HAUNT_WEIGHT = 4;
/** Chance two co-present, socially-tied people are actually TOGETHER this block. */
const TOGETHER_CHANCE = 0.5;
/** Largest "together" cluster (keeps group scenes legible + bounded). */
const MAX_CLUSTER = 4;

export interface Placement {
  /** null = "nowhere" — home / off-map / unavailable this phase. */
  locationId: string | null;
  atWork: boolean;
}

const phaseIdx = (phase: Phase): number => PHASE_KEYS.indexOf(phase);

/** Is a venue open + enterable this phase? Empty `openPhases` = the 3 active phases. */
function isOpen(loc: Location, phase: Phase): boolean {
  if (!loc.discoverable) return false;
  return loc.openPhases.length ? loc.openPhases.includes(phase) : ACTIVE_PHASES.includes(phase);
}

/** A character's shift phases, coercing the legacy single `shiftPhase` when unset. */
function shiftPhasesOf(emp: NonNullable<Character['employment']>): readonly Phase[] {
  return emp.shiftPhases.length ? emp.shiftPhases : [emp.shiftPhase];
}

/** Public: is a venue open + enterable this phase? (For the Around Town list — closed
 *  discoverable venues are still shown, dimmed.) */
export function isLocationOpen(loc: Location, phase: Phase): boolean {
  return isOpen(loc, phase);
}

// --- pure keyword→kind affinity (never an LLM call; deterministic + unit-testable) ---
const KIND_KEYWORDS: Array<[string, LocationKind]> = [
  ['book', 'library'], ['read', 'library'], ['study', 'library'], ['librar', 'library'],
  ['coffee', 'cafe'], ['tea', 'cafe'], ['cafe', 'cafe'], ['pastr', 'cafe'], ['café', 'cafe'],
  ['drink', 'bar'], ['cocktail', 'bar'], ['music', 'bar'], ['vinyl', 'bar'], ['danc', 'bar'],
  ['gym', 'gym'], ['workout', 'gym'], ['fitness', 'gym'], ['run', 'gym'], ['lift', 'gym'],
  ['park', 'park'], ['nature', 'park'], ['outdoor', 'park'], ['walk', 'park'], ['garden', 'park'],
  ['food', 'restaurant'], ['din', 'restaurant'], ['eat', 'restaurant'], ['cook', 'restaurant'],
  ['shop', 'shop'], ['fashion', 'shop'], ['cloth', 'shop'],
];

/** 0..2 affinity between a character's tastes and a venue's kind/tags. */
function affinity(c: Character, loc: Location): number {
  const likes = c.likes.map((x) => x.toLowerCase());
  let score = 0;
  if (KIND_KEYWORDS.some(([kw, kind]) => kind === loc.kind && likes.some((x) => x.includes(kw)))) score += 1;
  const tags = loc.tags.map((tg) => tg.toLowerCase());
  if (tags.some((tg) => likes.some((x) => x.includes(tg) || tg.includes(x)))) score += 1;
  return score;
}

/** Deterministic weighted pick of an open venue for free (non-work) placement. */
function freePick(c: Character, open: Location[], roll: number): string | null {
  if (open.length === 0) return null;
  const weights = open.map((l) => 1 + (c.haunts.includes(l.id) ? HAUNT_WEIGHT : 0) + affinity(c, l));
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return null;
  let r = roll * total;
  for (let i = 0; i < open.length; i += 1) {
    r -= weights[i]!;
    if (r < 0) return open[i]!.id;
  }
  return open[open.length - 1]!.id;
}

function placeOne(world: World, c: Character, day: number, phase: Phase, dayIndex: number, open: Location[]): Placement {
  const home: Placement = { locationId: null, atWork: false };
  const openIds = new Set(open.map((l) => l.id));
  const roll = (salt: string) => hashFloat(`place|${world.id}|${day}|${phaseIdx(phase)}|${c.id}|${salt}`);

  // 1. AT WORK — structured workplace, on shift this phase, on a workday, venue open. Zero randomness.
  const emp = c.employment;
  if (emp?.locationId && openIds.has(emp.locationId) && emp.workdays.includes(dayIndex) && shiftPhasesOf(emp).includes(phase)) {
    return { locationId: emp.locationId, atWork: true };
  }

  // 2. FIXTURE at a haunt that's open this phase (regulars are where you expect them).
  if (!c.dateable && c.haunts.length) {
    const openHaunts = c.haunts.filter((h) => openIds.has(h));
    if (openHaunts.length) return { locationId: openHaunts[Math.floor(roll('haunt') * openHaunts.length)]!, atWork: false };
  }

  // NIGHT — everyone else is home (nightlife is handled above via work-shift / haunt).
  if (phase === 'night') return home;

  // 3. "Nowhere" roll — home / busy / off-map this phase.
  if (roll('avail') < world.discoveryConfig.unavailableChance) return home;

  // 4. FREE placement among open venues, softly weighted by haunts + taste. No force-fill.
  return { locationId: freePick(c, open, roll('free')), atWork: false };
}

/** Everyone's placement for one (world, day, phase). Computed in ONE pass so occupancy
 *  is globally consistent (a character can never appear in two rooms). */
export function getPlacements(worldId: string, day: number, phase: Phase): Map<string, Placement> {
  const out = new Map<string, Placement>();
  const world = worldsRepo.get(worldId);
  if (!world) return out;
  const open = world.locations.filter((l) => isOpen(l, phase));
  const dayIndex = deriveCalendar(day).dayIndex;
  for (const c of charactersRepo.listByWorld(worldId)) out.set(c.id, placeOne(world, c, day, phase, dayIndex, open));
  return out;
}

/** Character ids present at a location this block — a pure projection of getPlacements. */
export function getLocationOccupancy(worldId: string, day: number, phase: Phase, locationId: string): string[] {
  return [...getPlacements(worldId, day, phase)]
    .filter(([, p]) => p.locationId === locationId)
    .map(([id]) => id)
    .sort();
}

/** Whether a character is placed somewhere in ≥1 active phase today (the discovery-world
 *  projection of "available today" — Phase 3 routes date availability through this). */
export function isPlacedToday(worldId: string, day: number, characterId: string): boolean {
  return ACTIVE_PHASES.some((phase) => getPlacements(worldId, day, phase).get(characterId)?.locationId != null);
}

// --- co-presence clustering (who is TOGETHER, not merely co-present) ---------------

/** Union-find clustering of co-present, socially-tied occupants. Deterministic (stable id
 *  order, seeded roll), capped at MAX_CLUSTER. Returns clusters of 2+ only. */
export function clusterOccupants(worldId: string, day: number, locationId: string, occupantIds: string[]): Array<{ id: number; memberIds: string[] }> {
  if (occupantIds.length < 2) return [];
  const sorted = [...occupantIds].sort();
  const tieSet = new Set<string>();
  for (const n of getSocialWeb(worldId).nodes) for (const tie of n.ties) tieSet.add(`${n.id}|${tie.targetId}`);
  const tied = (a: string, b: string) => tieSet.has(`${a}|${b}`) || tieSet.has(`${b}|${a}`);

  const parent = new Map(sorted.map((id) => [id, id]));
  const size = new Map(sorted.map((id) => [id, 1]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const nx = parent.get(x)!; parent.set(x, r); x = nx; }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra === rb || size.get(ra)! + size.get(rb)! > MAX_CLUSTER) return;
    const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra]; // attach to the lower id (stable)
    parent.set(drop, keep);
    size.set(keep, size.get(keep)! + size.get(drop)!);
  };

  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i]!, b = sorted[j]!;
      if (!tied(a, b)) continue;
      if (hashFloat(`group|${worldId}|${day}|${locationId}|${a}|${b}`) >= TOGETHER_CHANCE) continue;
      union(a, b);
    }
  }

  const groups = new Map<string, string[]>();
  for (const id of sorted) {
    const r = find(id);
    const g = groups.get(r);
    if (g) g.push(id);
    else groups.set(r, [id]);
  }
  return [...groups.values()]
    .filter((g) => g.length >= 2)
    .sort((a, b) => a[0]!.localeCompare(b[0]!))
    .map((memberIds, i) => ({ id: i, memberIds }));
}

// --- templated scene (Phase 2: no LLM; Phase 3 layers LLM flavor on top) -----------

const ACTIVITY_POOLS: Record<LocationKind, string[]> = {
  cafe: ['nursing a coffee', 'sketching in a notebook', 'tapping at a laptop', 'people-watching'],
  bar: ['nursing a drink', 'arguing about music', 'laughing with friends', 'waiting on someone'],
  library: ['reading', 'studying', 'taking notes', 'browsing the stacks'],
  gym: ['mid-workout', 'cooling down', 'on the treadmill', 'stretching it out'],
  park: ['out for a walk', 'reading on a bench', 'lying in the grass', 'watching the day go by'],
  restaurant: ['lingering over a meal', 'reading the menu', 'waiting for a table'],
  shop: ['browsing the shelves', 'trying something on', 'chatting with the clerk'],
  workplace: ['on the clock', 'taking a break', 'buried in work'],
  campus: ['between classes', 'studying on the lawn', 'heading to a lecture'],
  other: ['passing the time', 'lost in thought', 'taking it all in'],
};

function templatedActivity(kind: LocationKind, worldId: string, day: number, phase: Phase, characterId: string): string {
  const pool = ACTIVITY_POOLS[kind] ?? ACTIVITY_POOLS.other;
  const idx = Math.floor(hashFloat(`act|${worldId}|${day}|${phaseIdx(phase)}|${characterId}`) * pool.length);
  return pool[Math.min(idx, pool.length - 1)]!;
}

export interface SceneOccupant {
  characterId: string;
  activity: string;
  /** Index of the "together" cluster this occupant belongs to, or null if solo. */
  clusterId: number | null;
  atWork: boolean;
}

export interface LocationScene {
  locationId: string;
  occupants: SceneOccupant[];
  clusters: Array<{ id: number; memberIds: string[] }>;
}

/** The deterministic, templated scene at a location this block: who's present, what
 *  each is (templated) doing, and which of them are together. Phase 3 layers LLM prose. */
export function composeLocationScene(worldId: string, day: number, phase: Phase, locationId: string): LocationScene {
  const placements = getPlacements(worldId, day, phase);
  const occupantIds = [...placements].filter(([, p]) => p.locationId === locationId).map(([id]) => id).sort();
  const kind = worldsRepo.get(worldId)?.locations.find((l) => l.id === locationId)?.kind ?? 'other';
  const clusters = clusterOccupants(worldId, day, locationId, occupantIds);
  const clusterOf = new Map<string, number>();
  for (const cl of clusters) for (const m of cl.memberIds) clusterOf.set(m, cl.id);
  const occupants: SceneOccupant[] = occupantIds.map((id) => ({
    characterId: id,
    activity: templatedActivity(kind, worldId, day, phase, id),
    clusterId: clusterOf.get(id) ?? null,
    atWork: placements.get(id)?.atWork ?? false,
  }));
  return { locationId, occupants, clusters };
}
