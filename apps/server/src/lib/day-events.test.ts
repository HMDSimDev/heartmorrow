import { describe, it, expect, beforeEach } from 'vitest';
import { GameEventSchema, type GameEvent } from '@dsim/shared';
import { resetDb } from '../test/helpers';
import { buildDayLedger, formatEventsForRecap, summarizeRepeatables } from './day-events';

let seq = 0;
function evt(type: string, payload: Record<string, unknown>): GameEvent {
  seq += 1;
  return GameEventSchema.parse({ id: `evt-${seq}`, type, worldId: 'w1', payload, createdAt: seq });
}

const wealth = (over: Partial<Parameters<typeof buildDayLedger>[1]> = {}) => ({
  rentPaid: 0,
  dividends: 0,
  dividendHoldings: 0,
  movers: [],
  rentOverdue: [],
  evictedFrom: [],
  ...over,
});

beforeEach(() => resetDb()); // describeEvent resolves character names via the DB

describe('dividend collapse (regression: one line per held company buried the day)', () => {
  const manyDividends = () =>
    Array.from({ length: 25 }, (_, i) => evt('dividend_paid', { day: 2, ticker: `T${i}`, amount: 3, shares: 1 }));

  it('summarizeRepeatables folds a whole portfolio into ONE beat with the total', () => {
    const beats = summarizeRepeatables(manyDividends());
    const dividendBeats = beats.filter((b) => b.icon === '💵');
    expect(dividendBeats).toHaveLength(1);
    expect(dividendBeats[0]!.text).toContain('25 holdings');
    expect(dividendBeats[0]!.text).toContain('75 money');
    expect(dividendBeats[0]!.tone).toBe('good');
  });

  it('the recap PROMPT never sees dividends at all (the Ledger reports them)', () => {
    const block = formatEventsForRecap(manyDividends());
    expect(block).not.toMatch(/dividend/i);
  });
});

describe('formatEventsForRecap — the narrator sees story, not the ledger', () => {
  it('keeps story events and drops ledger-only money/market mechanics', () => {
    const events = [
      evt('session_eval', { characterId: 'c-missing', mood: 'warm', summaryLine: 'A lovely evening.' }),
      evt('stock_market_moved', { day: 2, movers: [{ ticker: 'LUM', pct: 0.08 }] }),
      evt('purchase', { totalCost: 120 }),
      evt('rent_overdue', { name: 'Loft', amount: 70, graceDay: 5 }),
      evt('property_evicted', { name: 'Loft' }),
    ];
    const block = formatEventsForRecap(events);
    expect(block).toContain('A lovely evening');
    expect(block).toContain('evicted'); // losing your home stays a STORY beat
    expect(block).not.toMatch(/market moved/i);
    expect(block).not.toMatch(/Bought an item/i);
    expect(block).not.toMatch(/Rent is overdue/i);
  });
});

describe('buildDayLedger — deterministic money story', () => {
  it('sums the day events and carries the overnight wealth pass through', () => {
    const events = [
      evt('activity', { kind: 'work', activityId: 'work_shift', money: 40 }),
      evt('activity', { kind: 'work', activityId: 'odd_jobs', money: 60 }),
      evt('activity', { kind: 'together', characterId: 'c1', money: 0 }),
      evt('gambling_round', { net: 10 }),
      evt('gambling_round', { net: -30 }),
      evt('purchase', { totalCost: 120 }),
    ];
    const ledger = buildDayLedger(
      events,
      wealth({
        rentPaid: 70,
        dividends: 34,
        dividendHoldings: 3,
        movers: [{ ticker: 'LUM', pct: 0.08 }],
        rentOverdue: ['Loft'],
      }),
    );
    expect(ledger).toMatchObject({
      workShifts: 2,
      workEarned: 100,
      gamblingPlays: 2,
      gamblingNet: -20,
      spent: 120,
      dividendHoldings: 3,
      dividendsTotal: 34,
      rentPaid: 70,
      rentOverdue: ['Loft'],
      evictedFrom: [],
      movers: [{ ticker: 'LUM', pct: 0.08 }],
    });
  });
});
