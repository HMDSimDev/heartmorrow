import { useEffect, useState } from 'react';
import type { BlackjackView } from '@dsim/shared';
import { api } from '../../../lib/api';
import { errorMessage } from '../../../lib/hooks';
import { Banner } from '../../ui';
import { PlayingCard, BetStepper, CantBetNote, ResultBanner, clampBet, maxAffordable, type CasinoGameProps } from './shared';
import './blackjack.css';

type Props = CasinoGameProps & { resume?: BlackjackView | null };

const RESULT_TITLE: Record<NonNullable<BlackjackView['outcome']>, string> = {
  blackjack: 'Blackjack!',
  win: 'You win',
  push: 'Push',
  lose: 'Dealer wins',
};

export function BlackjackGame({ worldId, wallet, onSettled, resume }: Props) {
  const [hand, setHand] = useState<BlackjackView | null>(resume ?? null);
  const [bet, setBet] = useState(() => clampBet(25, wallet));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // Re-clamp the displayed stake when limits/cash shrink (so the Deal button
  // never advertises a higher bet than what would actually be wagered).
  useEffect(() => setBet((b) => clampBet(b || 25, wallet)), [wallet]);

  const run = async (fn: () => Promise<{ view: BlackjackView; wallet: typeof wallet }>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await fn();
      setHand(res.view);
      onSettled(res.wallet);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const deal = () => {
    const stake = clampBet(bet, wallet);
    if (stake < wallet.minBet) return;
    void run(() => api.startBlackjack(worldId, stake));
  };
  const act = (action: 'hit' | 'stand' | 'double') => {
    if (!hand) return;
    void run(() => api.blackjackAction(worldId, hand.roundId, action));
  };

  const canBet = maxAffordable(wallet) >= wallet.minBet;
  const done = hand?.phase === 'done';
  const playing = hand?.phase === 'player';
  const resultOutcome = hand?.outcome === 'blackjack' ? 'win' : (hand?.outcome ?? 'lose');
  const resultTitle =
    hand?.outcome === 'lose' && hand.playerTotal > 21 ? 'Bust' : hand?.outcome ? RESULT_TITLE[hand.outcome] : '';

  return (
    <div className="bj">
      <div className="gmb-table">
        {/* Dealer */}
        <div className="bj-side">
          <div className="bj-tag">
            Dealer <span className="bj-total">{hand && hand.dealerTotal != null ? hand.dealerTotal : hand ? '?' : '—'}</span>
          </div>
          <div className="gmb-hand">
            {hand ? (
              playing ? (
                <>
                  <PlayingCard card={hand.dealer[0]} deal index={0} key={`${hand.roundId}-du`} />
                  <PlayingCard facedown deal index={1} key={`${hand.roundId}-dh`} />
                </>
              ) : (
                hand.dealer.map((c, i) => <PlayingCard key={`${hand.roundId}-d-${i}-done`} card={c} deal index={i} />)
              )
            ) : (
              <PlayingCard facedown />
            )}
          </div>
        </div>

        <div className="bj-rule" />

        {/* Player */}
        <div className="bj-side">
          <div className="gmb-hand">
            {hand ? (
              hand.player.map((c, i) => <PlayingCard key={`${hand.roundId}-p-${i}`} card={c} deal index={i} />)
            ) : (
              <PlayingCard facedown />
            )}
          </div>
          <div className="bj-tag">
            You{' '}
            <span className={`bj-total${hand && hand.playerTotal > 21 ? ' bust' : ''}`}>
              {hand ? `${hand.playerTotal}${hand.playerSoft && hand.playerTotal <= 21 ? ' soft' : ''}` : '—'}
            </span>
          </div>
        </div>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {done && hand && <ResultBanner outcome={resultOutcome} title={resultTitle} net={hand.net} />}

      {/* Controls */}
      {!hand || done ? (
        !canBet ? (
          <CantBetNote wallet={wallet} />
        ) : (
          <>
            <BetStepper wallet={wallet} value={bet} onChange={setBet} disabled={busy} />
            <div className="gmb-actions">
              <button className="gmb-go" onClick={deal} disabled={busy}>
                {busy ? 'Dealing…' : done ? `Deal again · ◈ ${bet}` : `Deal · ◈ ${bet}`}
              </button>
            </div>
          </>
        )
      ) : (
        <div className="gmb-actions">
          <button className="gmb-go" onClick={() => act('hit')} disabled={busy || !hand?.canHit}>
            Hit
          </button>
          <button className="gmb-go" onClick={() => act('stand')} disabled={busy || !hand?.canStand}>
            Stand
          </button>
          <button className="gmb-go alt" onClick={() => act('double')} disabled={busy || !hand?.canDouble}>
            Double
          </button>
        </div>
      )}
    </div>
  );
}
