import { useEffect, useRef, useState } from 'react';
import {
  SLOT_REEL,
  SLOT_SYMBOL_GLYPH,
  SLOT_SYMBOL_LABELS,
  SLOT_TRIPLE_PAYOUT,
  SLOT_CHERRY_TWO_PAYOUT,
  type SlotSymbol,
  type SlotsResult,
} from '@dsim/shared';
import { api } from '../../../lib/api';
import { errorMessage } from '../../../lib/hooks';
import { Banner } from '../../ui';
import { BetStepper, CantBetNote, ResultBanner, clampBet, maxAffordable, type CasinoGameProps } from './shared';
import './slots.css';

const CELL = 60; // px per reel cell — must match .slot-cell height
const N = SLOT_REEL.length;
const randomSymbol = (): SlotSymbol => SLOT_REEL[Math.floor(Math.random() * N)]!;
/** The [above, center, below] symbols around a reel stop — only the center pays. */
const around = (stop: number): [SlotSymbol, SlotSymbol, SlotSymbol] => [
  SLOT_REEL[(stop - 1 + N) % N]!,
  SLOT_REEL[stop]!,
  SLOT_REEL[(stop + 1) % N]!,
];
/** A blur strip of random symbols resting on the three real symbols around the stop. */
const buildStrip = (stop: number, len: number): SlotSymbol[] => [
  ...Array.from({ length: len }, randomSymbol),
  ...around(stop),
];
/** Triple-payout rows for the paytable, best first. */
const PAY_ROWS = (Object.keys(SLOT_TRIPLE_PAYOUT) as SlotSymbol[]).sort(
  (a, b) => SLOT_TRIPLE_PAYOUT[b] - SLOT_TRIPLE_PAYOUT[a],
);

export function SlotsGame({ worldId, wallet, onSettled }: CasinoGameProps) {
  const [bet, setBet] = useState(() => clampBet(25, wallet));
  const [strips, setStrips] = useState<SlotSymbol[][]>([
    ['bar', 'seven', 'bell'],
    ['plum', 'bar', 'lemon'],
    ['lemon', 'cherry', 'plum'],
  ]);
  const [spinId, setSpinId] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SlotsResult | null>(null);
  const [error, setError] = useState<string>();
  const pending = useRef<SlotsResult | null>(null);
  const reelRefs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];

  // Re-clamp the bet whenever the wallet (limits/cash) changes.
  useEffect(() => setBet((b) => clampBet(b || 25, wallet)), [wallet]);

  // Drive the reel spin after the strips for a new spin are in the DOM.
  useEffect(() => {
    if (spinId === 0) return;
    reelRefs.forEach((ref, i) => {
      const el = ref.current;
      if (!el) return;
      const dist = (strips[i]!.length - 3) * CELL; // rest the last 3 symbols in the window
      el.style.transition = 'none';
      el.style.transform = 'translateY(0px)';
      void el.offsetHeight; // force reflow so the reset isn't animated
      el.style.transition = `transform ${1.0 + i * 0.34}s cubic-bezier(0.16, 0.84, 0.3, 1)`;
      el.style.transform = `translateY(-${dist}px)`;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinId]);

  const reveal = (e: React.TransitionEvent) => {
    if (e.propertyName !== 'transform' || !pending.current) return;
    const res = pending.current;
    pending.current = null;
    setResult(res);
    setBusy(false);
    onSettled(res.wallet);
  };

  const spin = async () => {
    if (busy) return;
    const stake = clampBet(bet, wallet);
    if (stake < wallet.minBet) return;
    setBusy(true);
    setError(undefined);
    setResult(null);
    try {
      const res = await api.playSlots(worldId, stake);
      pending.current = res;
      setStrips(res.stops.map((stop, i) => buildStrip(stop, 22 + i * 5)));
      setSpinId((n) => n + 1);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const won = result && result.payout > 0;
  const canBet = maxAffordable(wallet) >= wallet.minBet;

  return (
    <div className="slot-machine">
      <div className="gmb-table">
        <div className="gmb-felt-label">Lucky Sevens · match the line</div>
        <div className={`slot-window${won ? ' win' : ''}`}>
          <div className="slot-payline" />
          <div className="slot-reels">
            {strips.map((strip, i) => (
              <div className="slot-reel" key={i}>
                <div className="slot-reel-strip" key={spinId} ref={reelRefs[i]} onTransitionEnd={i === 2 ? reveal : undefined}>
                  {strip.map((sym, j) => (
                    <div className="slot-cell" key={j}>
                      <span className={`slot-sym sym-${sym}`}>{SLOT_SYMBOL_GLYPH[sym]}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {result &&
        (won ? (
          <ResultBanner outcome="win" title={result.line ?? 'Winner!'} net={result.net} />
        ) : (
          <ResultBanner outcome="lose" title="No line this time" net={result.net} />
        ))}

      <div className="slot-paytable">
        {PAY_ROWS.map((s) => (
          <div key={s} className={`slot-payrow${result?.line === `Triple ${SLOT_SYMBOL_LABELS[s]}` ? ' hit' : ''}`}>
            <span className="slot-paysyms">
              <span className={`slot-sym sym-${s}`}>{SLOT_SYMBOL_GLYPH[s]}</span>
              <span className={`slot-sym sym-${s}`}>{SLOT_SYMBOL_GLYPH[s]}</span>
              <span className={`slot-sym sym-${s}`}>{SLOT_SYMBOL_GLYPH[s]}</span>
            </span>
            <span className="slot-paymult">{SLOT_TRIPLE_PAYOUT[s]}×</span>
          </div>
        ))}
        <div className={`slot-payrow${result?.line === 'Two Cherries' ? ' hit' : ''}`}>
          <span className="slot-paysyms">
            <span className="slot-sym sym-cherry">{SLOT_SYMBOL_GLYPH.cherry}</span>
            <span className="slot-sym sym-cherry">{SLOT_SYMBOL_GLYPH.cherry}</span>
            <span className="slot-pay-any">+ any</span>
          </span>
          <span className="slot-paymult">{SLOT_CHERRY_TWO_PAYOUT}×</span>
        </div>
      </div>

      {!canBet ? (
        <CantBetNote wallet={wallet} />
      ) : (
        <BetStepper wallet={wallet} value={bet} onChange={setBet} disabled={busy} />
      )}
      <div className="gmb-actions">
        <button className="gmb-go" onClick={spin} disabled={busy || !canBet}>
          {busy ? 'Spinning…' : `Spin · ◈ ${bet}`}
        </button>
      </div>
    </div>
  );
}
