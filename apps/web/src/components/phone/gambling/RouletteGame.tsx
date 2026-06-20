import { useMemo, useState } from 'react';
import {
  rouletteColor,
  rouletteBetWins,
  type RouletteBet,
  type RouletteResult,
} from '@dsim/shared';
import { api } from '../../../lib/api';
import { errorMessage } from '../../../lib/hooks';
import { Banner } from '../../ui';
import { ResultBanner, maxAffordable, type CasinoGameProps } from './shared';
import './roulette.css';

const DENOMS = [5, 25, 50, 100];
const NUMBERS = Array.from({ length: 37 }, (_, i) => i); // 0..36

/** Parse a placed-bet key like 'red' / 'dozen:2' / 'straight:17' into a RouletteBet. */
function parseKey(key: string, stake: number): RouletteBet {
  const [kind, val] = key.split(':');
  return { kind: kind as RouletteBet['kind'], value: val ? Number(val) : 0, stake };
}
const labelFor = (key: string): string => {
  const [kind, val] = key.split(':');
  if (kind === 'straight') return val!;
  if (kind === 'dozen') return ['1st 12', '2nd 12', '3rd 12'][Number(val) - 1]!;
  if (kind === 'column') return `Col ${val}`;
  return kind!.charAt(0).toUpperCase() + kind!.slice(1);
};

export function RouletteGame({ worldId, wallet, onSettled }: CasinoGameProps) {
  const [chips, setChips] = useState<Record<string, number>>({});
  const [denom, setDenom] = useState(25);
  const [phase, setPhase] = useState<'bet' | 'spinning' | 'done'>('bet');
  const [angle, setAngle] = useState(0);
  const [result, setResult] = useState<RouletteResult | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false); // synchronous in-flight guard (anti double-spend)

  const total = useMemo(() => Object.values(chips).reduce((a, b) => a + b, 0), [chips]);
  const top = maxAffordable(wallet);
  // `busy` covers the request round-trip; `spinning` covers the wheel animation.
  const locked = phase === 'spinning' || busy;

  const place = (key: string) => {
    if (locked) return;
    if (total + denom > top) return; // would breach the per-bet / daily / cash ceiling
    setResult(null);
    setPhase('bet');
    setChips((c) => ({ ...c, [key]: (c[key] ?? 0) + denom }));
  };
  const clear = () => {
    if (locked) return;
    setChips({});
    setResult(null);
    setPhase('bet');
  };

  const spin = async () => {
    if (locked || total < wallet.minBet) return;
    setBusy(true);
    setError(undefined);
    const bets = Object.entries(chips).map(([k, stake]) => parseKey(k, stake));
    try {
      const res = await api.playRoulette(worldId, bets);
      setPhase('spinning');
      setResult(res);
      // Land the ball on the number (stylized: position = number/37 of the ring).
      setAngle((a) => a + 360 * 5 + (res.number / 37) * 360);
      onSettled(res.wallet);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false); // phase is now 'spinning' on success, so the button stays locked
    }
  };

  const onBallStop = (e: React.TransitionEvent) => {
    if (e.propertyName === 'transform' && phase === 'spinning') setPhase('done');
  };

  const landed = result && phase === 'done' ? result.number : null;
  const winner = (key: string): boolean =>
    landed != null && rouletteBetWins(parseKey(key, 1), landed);
  const chipKeys = Object.keys(chips);

  return (
    <div className="rl">
      {/* Wheel */}
      <div className="gmb-table rl-stage">
        <div className="rl-wheel" style={{ ['--spin' as string]: `${angle}deg` }}>
          <div className="rl-ring" />
          <div className="rl-ball" onTransitionEnd={onBallStop} />
          <div className="rl-hub">
            {landed != null ? (
              <span className={`rl-landed is-${rouletteColor(landed)}`}>{landed}</span>
            ) : (
              <span className="rl-landed idle">{phase === 'spinning' ? '…' : '✦'}</span>
            )}
          </div>
        </div>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {phase === 'done' && result && (
        <ResultBanner
          outcome={result.net > 0 ? 'win' : result.net === 0 ? 'push' : 'lose'}
          title={`${result.number} ${result.color}`}
          net={result.net}
        />
      )}

      {/* Stake + chip selector */}
      <div className="rl-bankline">
        <span>
          Staked <b className="gmb-value">◈ {total}</b>
        </span>
        <div className="rl-denoms">
          {DENOMS.filter((d) => d <= Math.max(top, DENOMS[0]!)).map((d) => (
            <button key={d} className={`rl-denom${denom === d ? ' active' : ''}`} onClick={() => setDenom(d)} disabled={locked}>
              {d}
            </button>
          ))}
        </div>
        <button className="rl-clear" onClick={clear} disabled={locked || total === 0}>
          Clear
        </button>
      </div>

      {/* Number grid (straight-up bets) */}
      <div className="rl-grid">
        <button className={`rl-num is-green${winner('straight:0') ? ' win' : ''}`} onClick={() => place('straight:0')} disabled={locked}>
          0{chips['straight:0'] ? <i className="rl-chip">{chips['straight:0']}</i> : null}
        </button>
        <div className="rl-nums">
          {NUMBERS.slice(1).map((n) => (
            <button
              key={n}
              className={`rl-num is-${rouletteColor(n)}${winner(`straight:${n}`) ? ' win' : ''}`}
              onClick={() => place(`straight:${n}`)}
              disabled={locked}
            >
              {n}
              {chips[`straight:${n}`] ? <i className="rl-chip">{chips[`straight:${n}`]}</i> : null}
            </button>
          ))}
        </div>
      </div>

      {/* Outside bets */}
      <div className="rl-outside">
        {['dozen:1', 'dozen:2', 'dozen:3'].map((k) => (
          <Cell key={k} k={k} chips={chips} winner={winner} place={place} disabled={locked} />
        ))}
      </div>
      <div className="rl-outside">
        {['column:1', 'column:2', 'column:3'].map((k) => (
          <Cell key={k} k={k} chips={chips} winner={winner} place={place} disabled={locked} />
        ))}
      </div>
      <div className="rl-outside">
        {['low', 'even', 'red'].map((k) => (
          <Cell key={k} k={k} chips={chips} winner={winner} place={place} disabled={locked} tone={k} />
        ))}
      </div>
      <div className="rl-outside">
        {['high', 'odd', 'black'].map((k) => (
          <Cell key={k} k={k} chips={chips} winner={winner} place={place} disabled={locked} tone={k} />
        ))}
      </div>

      <div className="gmb-actions">
        <button className="gmb-go" onClick={spin} disabled={locked || total < wallet.minBet}>
          {locked ? 'Spinning…' : total > 0 ? `Spin · ◈ ${total}` : `Place at least ◈ ${wallet.minBet}`}
        </button>
      </div>
      {chipKeys.length > 0 && phase !== 'spinning' && (
        <div className="gmb-muted">
          On the table: {chipKeys.map((k) => `${labelFor(k)} ◈${chips[k]}`).join(' · ')}
        </div>
      )}
    </div>
  );
}

function Cell({
  k,
  chips,
  winner,
  place,
  disabled,
  tone,
}: {
  k: string;
  chips: Record<string, number>;
  winner: (k: string) => boolean;
  place: (k: string) => void;
  disabled: boolean;
  tone?: string;
}) {
  return (
    <button
      className={`rl-cell${tone ? ` tone-${tone}` : ''}${winner(k) ? ' win' : ''}`}
      onClick={() => place(k)}
      disabled={disabled}
    >
      {labelFor(k)}
      {chips[k] ? <i className="rl-chip">{chips[k]}</i> : null}
    </button>
  );
}
