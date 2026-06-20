import { useEffect, useRef, useState } from 'react';
import { SUIT_PIP, isRedSuit, type Card, type GamblingWallet } from '@dsim/shared';

/** The contract every casino game component fulfils inside GamblingApp. */
export interface CasinoGameProps {
  worldId: string;
  /** Live wallet + limits (drives bet clamping). */
  wallet: GamblingWallet;
  /** Call with the fresh wallet after every settled play so the app + HUD update. */
  onSettled: (wallet: GamblingWallet) => void;
}

export const formatCoin = (n: number): string => `◈ ${Math.round(n).toLocaleString()}`;

/** The largest stake the player can place right now (cap ∧ daily-remaining ∧ cash). */
export function maxAffordable(wallet: GamblingWallet): number {
  return Math.max(0, Math.min(wallet.maxBet, wallet.remainingToday, wallet.money));
}

/** Clamp a desired stake into the allowed range for the current wallet. */
export function clampBet(value: number, wallet: GamblingWallet): number {
  const top = maxAffordable(wallet);
  if (top < wallet.minBet) return 0;
  return Math.max(wallet.minBet, Math.min(top, Math.round(value)));
}

// --- A single playing card (warm vellum) ------------------------------------

export function PlayingCard({
  card,
  facedown = false,
  held = false,
  deal = false,
  index = 0,
}: {
  card?: Card;
  facedown?: boolean;
  held?: boolean;
  deal?: boolean;
  index?: number;
}) {
  if (facedown || !card) {
    return <div className={`gmb-card back${deal ? ' deal' : ''}`} style={deal ? { animationDelay: `${index * 90}ms` } : undefined} />;
  }
  const red = isRedSuit(card.suit);
  const pip = SUIT_PIP[card.suit];
  return (
    <div
      className={`gmb-card${red ? ' red' : ''}${held ? ' held' : ''}${deal ? ' deal' : ''}`}
      style={deal ? { animationDelay: `${index * 90}ms` } : undefined}
    >
      <span className="gmb-card-rank">{card.rank}{pip}</span>
      <span className="gmb-card-pip">{pip}</span>
      <span className="gmb-card-rank br">{card.rank}{pip}</span>
    </div>
  );
}

// --- Single-bet stepper with chip presets -----------------------------------

const CHIPS: Array<{ v: number; cls: string; label: string }> = [
  { v: 5, cls: 'v5', label: '5' },
  { v: 25, cls: 'v25', label: '25' },
  { v: 50, cls: 'v50', label: '50' },
  { v: 100, cls: 'v100', label: '100' },
];

export function BetStepper({
  wallet,
  value,
  onChange,
  disabled = false,
}: {
  wallet: GamblingWallet;
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean;
}) {
  const top = maxAffordable(wallet);
  const canBet = top >= wallet.minBet;
  const set = (n: number) => onChange(clampBet(n, wallet));
  return (
    <div className="gmb-bet">
      <div className="gmb-bet-row">
        <button className="gmb-bet-step" onClick={() => set(value - wallet.minBet)} disabled={disabled || !canBet || value <= wallet.minBet} aria-label="Lower bet">−</button>
        <div className="gmb-bet-amount">
          {value}
          <small>your bet</small>
        </div>
        <button className="gmb-bet-step" onClick={() => set(value + wallet.minBet)} disabled={disabled || !canBet || value >= top} aria-label="Raise bet">+</button>
      </div>
      <div className="gmb-chips">
        {CHIPS.filter((c) => c.v <= top).map((c) => (
          <button key={c.v} className={`gmb-chip ${c.cls}`} onClick={() => set(value + c.v)} disabled={disabled || !canBet} aria-label={`Add ${c.v}`}>
            {c.label}
          </button>
        ))}
        <button className="gmb-chip vmax" onClick={() => set(top)} disabled={disabled || !canBet} aria-label="Bet the maximum">Max</button>
      </div>
    </div>
  );
}

// --- Animated win/lose/push banner ------------------------------------------

export function ResultBanner({ outcome, title, net }: { outcome: 'win' | 'lose' | 'push'; title: string; net: number }) {
  const shown = useCountUp(Math.abs(net));
  return (
    <div className={`gmb-result ${outcome}`}>
      <span className="gmb-result-head">{title}</span>
      <span className="gmb-result-sub">
        {outcome === 'win' ? <>+ <b>{formatCoin(shown)}</b></> : outcome === 'push' ? 'Bet returned' : <>− {formatCoin(shown)}</>}
      </span>
    </div>
  );
}

// --- Count-up hook (rAF, reduced-motion aware) ------------------------------

export function useCountUp(target: number, durationMs = 520): number {
  // Start at 0: ResultBanner remounts each play, so the count-up runs 0 → target.
  const [value, setValue] = useState(0);
  const fromRef = useRef(0);
  useEffect(() => {
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const from = fromRef.current;
    if (reduce || from === target) {
      setValue(target);
      fromRef.current = target;
      return;
    }
    let raf = 0;
    let start = 0;
    const tick = (t: number) => {
      if (!start) start = t;
      const p = Math.min(1, (t - start) / durationMs);
      const eased = 1 - (1 - p) ** 3;
      setValue(Math.round(from + (target - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return value;
}
