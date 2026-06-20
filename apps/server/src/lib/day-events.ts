import type { DayRecordBeat, GameEvent } from '@dsim/shared';
import { charactersRepo } from '../db/repositories';

/**
 * The single place that turns a raw GameEvent into player-facing prose. Used by
 * BOTH the end-of-day recap (which feeds these lines to the narrator) and the
 * Calendar app's day records (which keep them as structured "what happened"
 * beats). Keeping it here means the live recap and a reconstructed day describe
 * the same event identically.
 */

/** Event types that are "meaningful" enough to surface on a day. NPC `npc_*`
 *  events are deliberately excluded — the world-sim "around town" beats are their
 *  only path in. `tragic_outcome` is excluded too: it must never be narrated. */
export const RECAP_EVENT_TYPES = new Set([
  'session_eval',
  'minigame_finish',
  'relationship_change',
  'dating_stat_change',
  'purchase',
  'item_use',
  'player_money_change',
  'temp_buff',
  'walkout',
  'date_left',
  'jealousy_triggered',
  'milestone_reached',
  'dtr_accepted',
  'dtr_backfired',
  'gossip_text',
  'knowledge_gossip',
  'relationship_on_the_rocks',
  'breakup',
  'reconciled',
  'ending_reached',
  // Wealth: lease/rent beats + market moves + property milestones. (Routine
  // successful rent_paid is intentionally NOT here — it would bury a daily lease.)
  'rent_overdue',
  'property_evicted',
  'property_leased',
  'dividend_paid',
  'stock_market_moved',
  'property_purchase',
  'property_sale',
]);

export function nameFor(characterId: unknown): string {
  if (typeof characterId !== 'string') return '';
  return charactersRepo.get(characterId)?.name ?? '';
}

/** A human one-liner for an event, or null if the event renders nothing. */
export function describeEvent(e: GameEvent): string | null {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case 'session_eval':
      return `Date with ${nameFor(p.characterId)} (mood: ${String(p.mood ?? '')}): ${String(p.summaryLine ?? '')}`;
    case 'minigame_finish':
      return `Played ${String(p.minigameId ?? 'a minigame')} with ${nameFor(p.characterId)} — grade ${String(p.grade ?? '')}.`;
    case 'purchase':
      return `Bought an item for ${String(p.totalCost ?? '?')} money.`;
    case 'item_use':
      return `Used/gifted an item${p.characterId ? ` to ${nameFor(p.characterId)}` : ''}.`;
    case 'walkout':
      return `${nameFor(p.characterId)} ended the date early.`;
    case 'date_left':
      return `${nameFor(p.characterId)} lost interest and called the date off early.`;
    case 'jealousy_triggered':
      return `${nameFor(p.characterId)} found out about another date and was hurt.`;
    case 'milestone_reached':
      return `You and ${nameFor(p.characterId)} reached a new milestone: ${String(p.label ?? p.band ?? '')}.`;
    case 'dtr_accepted':
      return `You and ${nameFor(p.characterId)} are now ${String(p.status ?? 'closer')}.`;
    case 'dtr_backfired':
      return `Things got awkward with ${nameFor(p.characterId)} after the talk about where things stand.`;
    case 'gossip_text':
      return `${nameFor(p.characterId)} had something to say about you and ${nameFor(p.subjectId)}.`;
    case 'knowledge_gossip':
      return `${nameFor(p.characterId)} texted you some neighborhood gossip about ${nameFor(p.subjectId)}.`;
    case 'relationship_on_the_rocks':
      return `Things are on the rocks with ${nameFor(p.characterId)}.`;
    case 'breakup':
      return `You and ${nameFor(p.characterId)} broke up.`;
    case 'reconciled':
      return `You and ${nameFor(p.characterId)} got back together.`;
    case 'ending_reached':
      return `💞 You and ${nameFor(p.characterId)} reached a happy ending: "${String(p.title ?? '')}".`;
    case 'rent_overdue':
      return `⚠ Rent is overdue for ${String(p.name ?? 'your place')} — pay by Day ${String(p.graceDay ?? '?')} or you'll be evicted.`;
    case 'property_evicted':
      return `You were evicted from ${String(p.name ?? 'a property')} for unpaid rent.`;
    case 'property_leased':
      return `Signed a lease on ${String(p.name ?? 'a place')}.`;
    case 'dividend_paid':
      return `Earned a ${String(p.amount ?? 0)} dividend from ${String(p.ticker ?? 'a holding')}.`;
    case 'stock_market_moved': {
      const movers = Array.isArray(p.movers) ? (p.movers as Array<{ ticker?: string; pct?: number }>) : [];
      if (movers.length === 0) return null;
      const parts = movers
        .slice(0, 3)
        .map((m) => `${String(m.ticker ?? '')} ${Number(m.pct) >= 0 ? '+' : ''}${Math.round(Number(m.pct) * 100)}%`);
      return `The market moved — ${parts.join(', ')}.`;
    }
    case 'property_purchase':
      return `Bought a new property: ${String(p.name ?? 'a place')}.`;
    case 'property_sale':
      return `Sold ${String(p.name ?? 'a property')}.`;
    default:
      return null;
  }
}

/** Join names as "Alice", "Alice and Bob", or "Alice, Bob, and Carol"; a long list
 *  collapses to "…, and N others" so a chatty day can't run on. */
function joinNames(names: string[], max = 4): string {
  if (names.length === 0) return '';
  if (names.length > max) {
    const extra = names.length - max;
    return `${names.slice(0, max).join(', ')}, and ${extra} other${extra === 1 ? '' : 's'}`;
  }
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/**
 * Beats for the day's REPEATABLE actions — work shifts, time spent bonding, and
 * texting. Unlike dates/milestones these can each happen many times a day (texting
 * is free; work/training only cost a little stamina), so rendering one beat per
 * event would bury the day. They're collapsed here into at most one beat apiece,
 * and are deliberately kept OUT of RECAP_EVENT_TYPES so the per-event path never
 * also renders them. Feed this the day's FULL event list — it matches the event
 * types it cares about itself. Shared by the live recap and the Calendar record.
 */
export function summarizeRepeatables(events: GameEvent[]): DayRecordBeat[] {
  let shifts = 0;
  let earned = 0;
  let gambleNet = 0;
  let gamblePlays = 0;
  const bondedWith = new Map<string, true>(); // characterId, insertion-ordered + de-duped
  const textedWith = new Map<string, true>();
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    if (e.type === 'activity') {
      if (p.kind === 'work') {
        shifts += 1;
        earned += Number(p.money) || 0;
      } else if (p.kind === 'training' && typeof p.characterId === 'string') {
        bondedWith.set(p.characterId, true);
      }
    } else if (e.type === 'text_reply' && typeof p.characterId === 'string') {
      textedWith.set(p.characterId, true);
    } else if (e.type === 'gambling_round') {
      gambleNet += Number(p.net) || 0;
      gamblePlays += 1;
    }
  }

  const beats: DayRecordBeat[] = [];
  if (shifts > 0) {
    const what = shifts === 1 ? 'a shift' : `${shifts} shifts`;
    const pay = earned > 0 ? ` and earned ${earned} money` : '';
    beats.push({ icon: '💼', text: `Put in ${what} at work${pay}.`, tone: 'neutral' });
  }
  const bondNames = [...bondedWith.keys()].map(nameFor).filter(Boolean);
  if (bondNames.length > 0) {
    beats.push({ icon: '☕', text: `Spent time with ${joinNames(bondNames)}.`, tone: 'neutral' });
  }
  const textNames = [...textedWith.keys()].map(nameFor).filter(Boolean);
  if (textNames.length > 0) {
    beats.push({ icon: '📱', text: `Traded texts with ${joinNames(textNames)}.`, tone: 'neutral' });
  }
  if (gamblePlays > 0) {
    const tone = gambleNet > 0 ? 'good' : gambleNet < 0 ? 'bad' : 'neutral';
    const text =
      gambleNet > 0
        ? `Came out ${gambleNet} ahead at the casino.`
        : gambleNet < 0
          ? `Lost ${-gambleNet} at the casino.`
          : 'Broke even at the casino.';
    beats.push({ icon: '🎲', text, tone });
  }
  return beats.map((b) => ({ ...b, text: b.text.slice(0, 720) }));
}

/** The bullet list of the day's describable events, for the recap prompt. */
export function formatEventsForRecap(events: GameEvent[]): string {
  const lines: string[] = [];
  for (const e of events) {
    const line = describeEvent(e);
    if (line && line.trim()) lines.push(`- ${line}`);
  }
  // Collapsed work/bonding/texting beats — these never go through describeEvent.
  for (const b of summarizeRepeatables(events)) lines.push(`- ${b.text}`);
  return lines.join('\n');
}

/** Per-event presentation for the Calendar's "what happened" chips. */
const BEAT_STYLE: Record<string, { icon: string; tone: DayRecordBeat['tone'] }> = {
  session_eval: { icon: '💬', tone: 'neutral' },
  minigame_finish: { icon: '🎮', tone: 'neutral' },
  purchase: { icon: '🛍️', tone: 'neutral' },
  item_use: { icon: '🎁', tone: 'neutral' },
  milestone_reached: { icon: '💞', tone: 'good' },
  dtr_accepted: { icon: '💍', tone: 'good' },
  reconciled: { icon: '🕊️', tone: 'good' },
  ending_reached: { icon: '🎉', tone: 'good' },
  dtr_backfired: { icon: '😬', tone: 'bad' },
  walkout: { icon: '🚪', tone: 'bad' },
  date_left: { icon: '🚶', tone: 'bad' },
  jealousy_triggered: { icon: '💔', tone: 'bad' },
  relationship_on_the_rocks: { icon: '⛈️', tone: 'bad' },
  breakup: { icon: '💔', tone: 'bad' },
  gossip_text: { icon: '🗣️', tone: 'neutral' },
  knowledge_gossip: { icon: '🗣️', tone: 'neutral' },
  rent_overdue: { icon: '⚠️', tone: 'bad' },
  property_evicted: { icon: '🚫', tone: 'bad' },
  property_leased: { icon: '🔑', tone: 'neutral' },
  dividend_paid: { icon: '💵', tone: 'good' },
  stock_market_moved: { icon: '📈', tone: 'neutral' },
  property_purchase: { icon: '🏡', tone: 'good' },
  property_sale: { icon: '🏠', tone: 'neutral' },
};

/** Turn an event into a Calendar beat ({icon,text,tone}), or null if it renders nothing. */
export function beatFromEvent(e: GameEvent): DayRecordBeat | null {
  const text = describeEvent(e);
  if (!text || !text.trim()) return null;
  const style = BEAT_STYLE[e.type] ?? { icon: '•', tone: 'neutral' as const };
  // 720 is a generous backstop that keeps a full session_eval beat ("Date with X
  // (mood: Y): <summaryLine>", summaryLine up to 600) intact; the Calendar clamps it
  // visually with a "show more" rather than the server hard-truncating the recap.
  return { icon: style.icon, text: text.trim().slice(0, 720), tone: style.tone };
}
