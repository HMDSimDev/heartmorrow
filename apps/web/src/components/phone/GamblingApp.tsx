import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CASINO_GAMES,
  type CasinoGame,
  type GamblingWallet,
} from '@dsim/shared';
import { api } from '../../lib/api';
import { useAppData } from '../../state/app-context';
import { useAsync } from '../../lib/hooks';
import { casinoGameLabel, casinoGameBlurb } from '../../i18n/labels';
import { Icon } from '../Icon';
import { Empty, Loader } from '../ui';
import { PhoneAppBar } from './PhoneAppBar';
import { SlotsGame } from './gambling/SlotsGame';
import { BlackjackGame } from './gambling/BlackjackGame';
import { RouletteGame } from './gambling/RouletteGame';
import { VideoPokerGame } from './gambling/VideoPokerGame';
import { formatCoin, type CasinoGameProps } from './gambling/shared';
import './phone-gambling.css';

/** Diegetic marquee glyph for each game tile (game art, not UI chrome). */
const GLYPH: Record<CasinoGame, string> = {
  slots: '\u{1F3B0}',
  blackjack: '♠️',
  roulette: '\u{1F3A1}',
  videoPoker: '\u{1F0CF}',
};

export function GamblingApp() {
  const { t } = useTranslation(['phone', 'common']);
  const { reloadPlayer, activeWorldId, dayTick } = useAppData();
  const [view, setView] = useState<CasinoGame | 'lobby'>('lobby');
  const [wallet, setWallet] = useState<GamblingWallet>();
  const resumed = useRef(false);
  const state = useAsync(
    () => (activeWorldId ? api.gamblingState(activeWorldId) : Promise.reject(new Error('No world'))),
    [activeWorldId, dayTick],
  );

  // Mirror the loaded wallet locally; auto-open a hand left mid-play (once).
  useEffect(() => {
    if (!state.data) return;
    setWallet(state.data.wallet);
    if (!resumed.current) {
      resumed.current = true;
      if (state.data.activeBlackjack) setView('blackjack');
      else if (state.data.activeVideoPoker) setView('videoPoker');
    }
  }, [state.data]);

  const onSettled = useCallback(
    (w: GamblingWallet) => {
      setWallet(w);
      reloadPlayer(); // refresh the HUD cash
    },
    [reloadPlayer],
  );
  const toLobby = () => {
    setView('lobby');
    state.reload(); // refresh active-hand + wallet so a re-entry isn't stale
  };

  if (!activeWorldId) {
    return (
      <div className="phone-app">
        <PhoneAppBar title={t('gambling.title')} kicker={t('gambling.houseOfFortune')} icon="gambling" />
        <div className="gmb-scroll">
          <Empty icon={<Icon name="gambling" size={34} />} title={t('gambling.noWorldTitle')} />
        </div>
      </div>
    );
  }

  const purse = wallet ?? state.data?.wallet;
  return (
    <div className="phone-app">
      <PhoneAppBar
        title={t('gambling.title')}
        kicker={view === 'lobby' ? t('gambling.houseOfFortune') : casinoGameLabel(view)}
        icon="gambling"
        left={
          view !== 'lobby' ? (
            <button className="gmb-backbtn" onClick={toLobby}>
              <Icon name="chevronRight" size={14} style={{ transform: 'rotate(180deg)' }} />
              {t('gambling.lobby')}
            </button>
          ) : undefined
        }
        right={purse ? <span className="gmb-purse"><span className="gmb-purse-coin">{formatCoin(purse.money)}</span></span> : undefined}
      />
      <div className="gmb-scroll">
        <Loader state={state}>
          {(data) => {
            const wl = wallet ?? data.wallet;
            if (view === 'lobby') {
              return (
                <>
                  <div className="gmb-marquee">
                    <h2>{t('gambling.marqueeTitle')}</h2>
                    <p>{t('gambling.marqueeSub')}</p>
                  </div>
                  <LimitRibbon wallet={wl} />
                  <div className="gmb-lobby">
                    {CASINO_GAMES.map((g) => (
                      <button key={g} className="gmb-tile" onClick={() => setView(g)}>
                        <span className="gmb-tile-glyph">{GLYPH[g]}</span>
                        <span className="gmb-tile-name">{casinoGameLabel(g)}</span>
                        <span className="gmb-tile-blurb">{casinoGameBlurb(g)}</span>
                      </button>
                    ))}
                  </div>
                  <div className="gmb-muted">{t('gambling.houseOdds')}</div>
                </>
              );
            }
            const props: CasinoGameProps = { worldId: activeWorldId, wallet: wl, onSettled };
            return (
              <>
                <LimitRibbon wallet={wl} />
                {view === 'slots' && <SlotsGame {...props} />}
                {view === 'blackjack' && <BlackjackGame {...props} resume={data.activeBlackjack} />}
                {view === 'roulette' && <RouletteGame {...props} />}
                {view === 'videoPoker' && <VideoPokerGame {...props} resume={data.activeVideoPoker} />}
              </>
            );
          }}
        </Loader>
      </div>
    </div>
  );
}

function LimitRibbon({ wallet }: { wallet: GamblingWallet }) {
  const { t } = useTranslation(['phone', 'common']);
  const pct = wallet.dailyLimit > 0 ? Math.min(100, (wallet.wageredToday / wallet.dailyLimit) * 100) : 0;
  return (
    <div className="gmb-limit">
      <span>
        {t('gambling.wagered')} <b>◈ {wallet.wageredToday}</b>
      </span>
      <span className="gmb-limit-bar">
        <i style={{ width: `${pct}%` }} />
      </span>
      <span>
        {t('gambling.daily')} <b>◈ {wallet.dailyLimit}</b>
      </span>
    </div>
  );
}
