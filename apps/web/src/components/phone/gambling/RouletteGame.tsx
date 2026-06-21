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

/** European single-zero wheel order — 0, then strictly alternating red/black.
 *  Painting the ring in THIS order (not numeric order) makes the colors alternate
 *  like a real wheel instead of doubling up. */
const WHEEL_ORDER = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24,
  16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];
const SEG = 360 / WHEEL_ORDER.length; // degrees per pocket

/** Standard table: three rows (columns 3 / 2 / 1), twelve numbers each. Far more
 *  compact vertically than a 6×6 block, so the wheel stays on screen. */
const GRID_ROWS = [
  [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36],
  [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35],
  [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34],
];
const GRID_NUMS = GRID_ROWS.flat();

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

  // The ring, painted as the real pockets in wheel order — each wedge its true color.
  const wheelBg = useMemo(() => {
    const stops = WHEEL_ORDER.map((n, i) => {
      const c = n === 0 ? '#1f7a4d' : rouletteColor(n) === 'red' ? '#8e2f2f' : '#171b2e';
      return `${c} ${(i * SEG).toFixed(3)}deg ${((i + 1) * SEG).toFixed(3)}deg`;
    }).join(', ');
    return `conic-gradient(from ${(-SEG / 2).toFixed(3)}deg, ${stops})`;
  }, []);

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
      // Settle the ball on this number's pocket (its index in the wheel order),
      // spinning several extra turns forward from wherever it last rested — so the
      // landing is correct on every spin and the colour matches the result.
      setAngle((a) => {
        const target = WHEEL_ORDER.indexOf(res.number) * SEG;
        const curr = ((a % 360) + 360) % 360;
        const forward = (target - curr + 360) % 360;
        return a + 360 * 6 + forward;
      });
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
  // A bet only lights up as a win if the player ACTUALLY placed a chip on it — not
  // every bet that happens to cover the landed number.
  const placedWin = (key: string): boolean =>
    landed != null && (chips[key] ?? 0) > 0 && rouletteBetWins(parseKey(key, 1), landed);
  const placedLost = (key: string): boolean =>
    landed != null && (chips[key] ?? 0) > 0 && !rouletteBetWins(parseKey(key, 1), landed);
  const chipKeys = Object.keys(chips);

  const numClass = (n: number): string =>
    `rl-num is-${rouletteColor(n)}${landed === n ? ' landed' : ''}${placedWin(`straight:${n}`) ? ' win' : ''}${placedLost(`straight:${n}`) ? ' lost' : ''}`;

  return (
    <div className="rl">
      {/* Wheel */}
      <div className="gmb-table rl-stage">
        <div className="rl-wheel">
          <div className="rl-ring" style={{ background: wheelBg }} />
          {/* The numbers around the wheel, so you can watch the ball settle on one. */}
          <div className="rl-pips" aria-hidden="true">
            {WHEEL_ORDER.map((n, i) => {
              const a = (i * SEG - 90) * (Math.PI / 180);
              return (
                <span
                  key={n}
                  className={`rl-pip is-${rouletteColor(n)}`}
                  style={{
                    left: `${50 + Math.cos(a) * 45}%`,
                    top: `${50 + Math.sin(a) * 45}%`,
                    // rotate each number to its spoke so it radiates like a real wheel
                    transform: `translate(-50%, -50%) rotate(${i * SEG}deg)`,
                  }}
                >
                  {n}
                </span>
              );
            })}
          </div>
          <div className="rl-ball" style={{ ['--spin' as string]: `${angle}deg` }} onTransitionEnd={onBallStop} />
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

      {/* Number grid (straight-up bets) — standard 3×12 with 0 down the side */}
      <div className="rl-grid">
        <button
          className={`rl-num is-green${landed === 0 ? ' landed' : ''}${placedWin('straight:0') ? ' win' : ''}${placedLost('straight:0') ? ' lost' : ''}`}
          onClick={() => place('straight:0')}
          disabled={locked}
        >
          0{chips['straight:0'] ? <i className="rl-chip">{chips['straight:0']}</i> : null}
        </button>
        <div className="rl-nums">
          {GRID_NUMS.map((n) => (
            <button key={n} className={numClass(n)} onClick={() => place(`straight:${n}`)} disabled={locked}>
              {n}
              {chips[`straight:${n}`] ? <i className="rl-chip">{chips[`straight:${n}`]}</i> : null}
            </button>
          ))}
        </div>
      </div>

      {/* Outside bets */}
      <div className="rl-outside">
        {['dozen:1', 'dozen:2', 'dozen:3'].map((k) => (
          <Cell key={k} k={k} chips={chips} win={placedWin(k)} lost={placedLost(k)} place={place} disabled={locked} />
        ))}
      </div>
      <div className="rl-outside">
        {['column:1', 'column:2', 'column:3'].map((k) => (
          <Cell key={k} k={k} chips={chips} win={placedWin(k)} lost={placedLost(k)} place={place} disabled={locked} />
        ))}
      </div>
      <div className="rl-outside">
        {['red', 'black', 'even', 'odd', 'low', 'high'].map((k) => (
          <Cell
            key={k}
            k={k}
            chips={chips}
            win={placedWin(k)}
            lost={placedLost(k)}
            place={place}
            disabled={locked}
            tone={k === 'red' || k === 'black' ? k : undefined}
          />
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
  win,
  lost,
  place,
  disabled,
  tone,
}: {
  k: string;
  chips: Record<string, number>;
  win: boolean;
  lost: boolean;
  place: (k: string) => void;
  disabled: boolean;
  tone?: string;
}) {
  return (
    <button
      className={`rl-cell${tone ? ` tone-${tone}` : ''}${win ? ' win' : ''}${lost ? ' lost' : ''}`}
      onClick={() => place(k)}
      disabled={disabled}
    >
      {labelFor(k)}
      {chips[k] ? <i className="rl-chip">{chips[k]}</i> : null}
    </button>
  );
}
