import type { GameEvent, Moment } from '@dsim/shared';
import { eventsRepo, memoriesRepo } from '../db/repositories';
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

  return [...fromEvents, ...fromMemories].sort((a, b) => b.createdAt - a.createdAt);
}
