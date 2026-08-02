import { DEFAULT_PLAYER_ID, type GameEvent, type Moment } from '@dsim/shared';
import { endingsRepo, eventsRepo, memoriesRepo } from '../db/repositories';
import { getCharacter } from './character-service';

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Map a recorded game event to a scrapbook card, or null if it isn't a "moment". */
function eventToMoment(e: GameEvent): Moment | null {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case 'milestone_reached':
      return { id: e.id, day: num(p.day), kind: 'milestone', title: `You became ${str(p.label) || 'closer'}`, body: '', mood: null, importance: 5, createdAt: e.createdAt };
    case 'session_eval':
      return { id: e.id, day: num(p.day), kind: 'date', title: str(p.mood) ? `A date — ${str(p.mood)}` : 'A date', body: str(p.summaryLine), mood: str(p.mood) || null, importance: null, createdAt: e.createdAt };
    case 'jealousy_triggered':
      return { id: e.id, day: num(p.day), kind: 'jealousy', title: 'A jealous moment', body: 'They found out you had been seeing someone else.', mood: null, importance: null, createdAt: e.createdAt };
    case 'walkout':
      return { id: e.id, day: num(p.day), kind: 'walkout', title: 'They walked out', body: str(p.reason), mood: null, importance: null, createdAt: e.createdAt };
    case 'dtr_accepted':
      return { id: e.id, day: num(p.day), kind: 'status', title: `You're now ${str(p.status) || 'together'}`, body: '', mood: null, importance: 5, createdAt: e.createdAt };
    case 'dtr_backfired':
      return { id: e.id, day: num(p.day), kind: 'status', title: 'A difficult conversation', body: 'The talk about where things stand went badly.', mood: null, importance: null, createdAt: e.createdAt };
    case 'reconciled':
      return { id: e.id, day: num(p.day), kind: 'status', title: 'You found your way back to each other', body: '', mood: null, importance: 5, createdAt: e.createdAt };
    case 'breakup':
      return { id: e.id, day: num(p.day), kind: 'breakup', title: str(p.initiator) === 'player' ? 'You ended things' : 'They ended things', body: '', mood: null, importance: null, createdAt: e.createdAt };
    case 'anniversary_date': {
      const seasons = num(p.seasons) ?? 1;
      return { id: e.id, day: num(p.day), kind: 'anniversary', title: seasons === 1 ? 'Your first anniversary' : `${seasons} seasons together`, body: 'You spent the day together.', mood: null, importance: 5, createdAt: e.createdAt };
    }
    default:
      return null;
  }
}

/**
 * Assemble a character's "Moments" timeline from the existing event log + the
 * character's keepsake memories. Read-only; no new storage. Milestone/jealousy
 * memories are skipped because the matching event already provides that card.
 */
export function getMoments(characterId: string): Moment[] {
  getCharacter(characterId); // validate existence (throws notFound)

  const fromEvents = eventsRepo
    .listByCharacter(characterId, 300)
    .map(eventToMoment)
    .filter((m): m is Moment => m !== null);

  const fromMemories: Moment[] = memoriesRepo
    .listByCharacter(characterId)
    .filter((m) => m.importance >= 4 && !m.tags.includes('milestone') && !m.tags.includes('jealousy'))
    .map((m) => ({ id: m.id, day: null, kind: 'memory' as const, title: 'A memory', body: m.text, mood: null, importance: m.importance, createdAt: m.createdAt }));

  // The happy ending marks its day in the scrapbook too — sourced from the
  // durable endings table (the event log's window can age the event out). Just
  // the moment: the full epilogue stays in the Endings gallery, uncopied.
  const ending = endingsRepo.getByCharacter(characterId, DEFAULT_PLAYER_ID);
  const endingMoments: Moment[] = ending
    ? [{ id: `ending-${characterId}`, day: ending.day, kind: 'ending' as const, title: `“${ending.title}”`, body: 'Your story reached its happy ending — the epilogue is kept in the Endings gallery.', mood: null, importance: 5, createdAt: ending.createdAt }]
    : [];

  return [...fromEvents, ...fromMemories, ...endingMoments].sort((a, b) => b.createdAt - a.createdAt);
}
