import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  VIDEO_POKER_PAYTABLE,
  type VideoPokerRank,
  type VideoPokerView,
} from '@dsim/shared';
import { api } from '../../../lib/api';
import { errorMessage } from '../../../lib/hooks';
import { videoPokerRankLabel } from '../../../i18n/labels';
import { Banner } from '../../ui';
import { PlayingCard, BetStepper, CantBetNote, ResultBanner, clampBet, maxAffordable, type CasinoGameProps } from './shared';
import './videopoker.css';

type Props = CasinoGameProps & { resume?: VideoPokerView | null };

/** Paytable rows, best first; 'none' is omitted (it pays nothing). */
const PAY_ROWS = (Object.keys(VIDEO_POKER_PAYTABLE) as VideoPokerRank[])
  .filter((r) => r !== 'none')
  .sort((a, b) => VIDEO_POKER_PAYTABLE[b] - VIDEO_POKER_PAYTABLE[a]);

export function VideoPokerGame({ worldId, wallet, onSettled, resume }: Props) {
  const { t } = useTranslation(['phone', 'common']);
  const [hand, setHand] = useState<VideoPokerView | null>(resume ?? null);
  const [held, setHeld] = useState<boolean[]>(resume?.held ?? [false, false, false, false, false]);
  const [bet, setBet] = useState(() => clampBet(25, wallet));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // Keep the displayed stake within the (possibly shrinking) limits.
  useEffect(() => setBet((b) => clampBet(b || 25, wallet)), [wallet]);

  const draw = hand?.phase === 'draw';
  const done = hand?.phase === 'done';
  const canBet = maxAffordable(wallet) >= wallet.minBet;

  const deal = async () => {
    if (busy) return;
    const stake = clampBet(bet, wallet);
    if (stake < wallet.minBet) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await api.startVideoPoker(worldId, stake);
      setHand(res.view);
      setHeld([false, false, false, false, false]);
      onSettled(res.wallet);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const drawCards = async () => {
    if (busy || !hand) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await api.videoPokerDraw(worldId, hand.roundId, held);
      setHand(res.view);
      onSettled(res.wallet);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (i: number) => {
    if (!draw || busy) return;
    setHeld((h) => h.map((v, j) => (j === i ? !v : v)));
  };

  // Classify by NET, not gross payout: a Jacks-or-Better hand pays 1× = your stake
  // back (net 0), which is a PUSH, not a win. Keying off payout>0 mislabeled it a
  // "win" and rendered "+◈0". Mirrors the roulette settlement convention.
  const outcome: 'win' | 'lose' | 'push' =
    done && hand ? (hand.net > 0 ? 'win' : hand.net < 0 ? 'lose' : 'push') : 'lose';

  return (
    <div className="vp">
      <div className="gmb-table">
        <div className="gmb-felt-label">{t('gambling.vpFelt')}</div>
        <div className="gmb-hand vp-hand">
          {hand ? (
            hand.cards.map((c, i) => (
              <button key={`${hand.roundId}-${i}`} className="vp-slot" onClick={() => toggle(i)} disabled={!draw || busy}>
                {/* Key the card by identity so only changed (drawn) cards re-deal;
                    held keepers + hold-toggles keep their DOM node (no flicker). */}
                <PlayingCard key={`${c.rank}${c.suit}`} card={c} held={held[i]} deal index={i} />
                <span className={`vp-hold${held[i] ? ' on' : ''}`}>{held[i] ? t('gambling.held') : draw ? t('gambling.tap') : ''}</span>
              </button>
            ))
          ) : (
            Array.from({ length: 5 }, (_, i) => (
              <span className="vp-slot" key={i}>
                <PlayingCard facedown />
              </span>
            ))
          )}
        </div>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {done && hand && (
        <ResultBanner
          outcome={outcome}
          // On a push (Jacks-or-Better pays the stake back) just say "Bet returned" —
          // showing the winning-hand name read like a win for a net-0 result.
          title={outcome === 'push' ? '' : hand.rank && hand.rank !== 'none' ? videoPokerRankLabel(hand.rank) : t('gambling.noPay')}
          net={hand.net}
        />
      )}

      {/* Paytable */}
      <div className="vp-paytable">
        {PAY_ROWS.map((r) => (
          <div key={r} className={`vp-payrow${done && hand?.rank === r ? ' hit' : ''}`}>
            <span>{videoPokerRankLabel(r)}</span>
            <span className="vp-paymult">{VIDEO_POKER_PAYTABLE[r]}×</span>
          </div>
        ))}
      </div>

      {/* Controls */}
      {draw ? (
        <div className="gmb-actions">
          <button className="gmb-go" onClick={drawCards} disabled={busy}>
            {busy ? t('gambling.drawing') : t('gambling.draw', { count: held.filter(Boolean).length })}
          </button>
        </div>
      ) : !canBet ? (
        <CantBetNote wallet={wallet} />
      ) : (
        <>
          <BetStepper wallet={wallet} value={bet} onChange={setBet} disabled={busy} />
          <div className="gmb-actions">
            <button className="gmb-go" onClick={deal} disabled={busy}>
              {busy ? t('gambling.dealing') : done ? t('gambling.dealAgain', { bet }) : t('gambling.deal', { bet })}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
