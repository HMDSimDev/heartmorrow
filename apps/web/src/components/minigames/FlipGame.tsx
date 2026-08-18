import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FlipConfig, FlipSubmission } from '@dsim/shared';
import { OnboardingSteps, shouldAutoOpenOnboarding, type OnboardingStep } from '../OnboardingSteps';
import { MinigameShell } from './MinigameShell';

/* The Flip — market-day haggling. One buyer at a time: read the two tells, name a
   price above the piece's worth, and (on a bite) choose to shake or press for more.
   ONLY THE MARGIN above street value is profit, and that margin is exactly the coin
   the shift pays out — the "cleared" counter is the real number. The config carries
   each buyer's hidden ceiling so this component can adjudicate accept-vs-walk live —
   it is NEVER rendered; the server re-derives the profit from the raw deals. */

type Phase = 'haggle' | 'bite' | 'settled';
type Outcome = 'sold' | 'pressWin' | 'pressLose' | 'walked';

const NUDGES = [-10, -1, +1, +10] as const;

/** Seen-flag for the first-shift walkthrough. Client-global (localStorage), like
 *  the date onboarding — the stall works the same in every world and save. */
export const FLIP_ONBOARDING_KEY = 'dsim.flipOnboardingSeen';

const ONB_STEPS = [
  { icon: 'coin', titleKey: 'common:minigame.flipOnb.margin.title', bodyKey: 'common:minigame.flipOnb.margin.body' },
  { icon: 'preview', titleKey: 'common:minigame.flipOnb.read.title', bodyKey: 'common:minigame.flipOnb.read.body' },
  { icon: 'work', titleKey: 'common:minigame.flipOnb.press.title', bodyKey: 'common:minigame.flipOnb.press.body' },
] as const satisfies ReadonlyArray<OnboardingStep>;

/** Stepped "how the stall works" walkthrough: auto-shown before the first shift,
 *  reopenable from the board. The caller owns the seen-flag. */
function FlipOnboarding({ onClose }: { onClose: () => void }) {
  return (
    <OnboardingSteps
      steps={ONB_STEPS}
      kickerKey="common:minigame.flipOnb.kicker"
      doneKey="common:minigame.flipOnb.done"
      onClose={onClose}
    />
  );
}

export function FlipGame({
  config,
  onComplete,
}: {
  config: FlipConfig;
  onComplete: (submission: FlipSubmission) => void;
}) {
  const { t } = useTranslation();
  const total = config.buyers.length;
  const [idx, setIdx] = useState(0);
  const [quote, setQuote] = useState(config.buyers[0]?.baseValue ?? 1);
  const [phase, setPhase] = useState<Phase>('haggle');
  const [outcome, setOutcome] = useState<{ kind: Outcome; paid: number; cleared: number } | null>(null);
  const [deals, setDeals] = useState<Array<{ quote: number; pressed: boolean }>>([]);
  const [cleared, setCleared] = useState(0);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const doneRef = useRef(false);

  // First shift ever: explain the stall before a single coin is misread. Mark it
  // seen immediately (the Chat.tsx pattern) so a mid-walkthrough refresh doesn't
  // greet every later shift — the "how the stall works" button is the way back in.
  useEffect(() => {
    if (shouldAutoOpenOnboarding(FLIP_ONBOARDING_KEY)) setOnboardingOpen(true);
  }, []);

  const buyer = config.buyers[Math.min(idx, total - 1)]!;
  const pressTo = Math.round(quote * config.pressMult);
  const margin = quote - buyer.baseValue;
  const last = idx >= total - 1;

  // You never offer a piece below its own worth — the floor is the street value.
  const nudge = (d: number) =>
    setQuote((q) => Math.max(buyer.baseValue, Math.min(buyer.baseValue * 3, q + d)));

  const offer = () => {
    if (phase !== 'haggle') return;
    if (quote <= buyer.ceiling) {
      setPhase('bite');
      return;
    }
    setDeals((ds) => [...ds, { quote, pressed: false }]);
    setOutcome({ kind: 'walked', paid: 0, cleared: 0 });
    setPhase('settled');
  };

  const shake = () => {
    if (phase !== 'bite') return;
    setDeals((ds) => [...ds, { quote, pressed: false }]);
    setCleared((p) => p + margin);
    setOutcome({ kind: 'sold', paid: quote, cleared: margin });
    setPhase('settled');
  };

  const press = () => {
    if (phase !== 'bite') return;
    const win = pressTo <= buyer.ceiling;
    const clearedNow = win ? pressTo - buyer.baseValue : 0;
    setDeals((ds) => [...ds, { quote, pressed: true }]);
    if (win) setCleared((p) => p + clearedNow);
    setOutcome({ kind: win ? 'pressWin' : 'pressLose', paid: win ? pressTo : 0, cleared: clearedNow });
    setPhase('settled');
  };

  const next = () => {
    if (phase !== 'settled') return;
    if (last) {
      if (doneRef.current) return;
      doneRef.current = true;
      onComplete({ deals });
      return;
    }
    const n = idx + 1;
    setIdx(n);
    setQuote(config.buyers[n]!.baseValue);
    setPhase('haggle');
    setOutcome(null);
  };

  const outcomeLine = (o: { kind: Outcome; paid: number; cleared: number }): string => {
    switch (o.kind) {
      case 'sold':
        return t('minigame.flipSold', { n: o.paid, m: o.cleared });
      case 'pressWin':
        return t('minigame.flipPressWin', { n: o.paid, m: o.cleared });
      case 'pressLose':
        return t('minigame.flipPressLose');
      case 'walked':
        return t('minigame.flipWalked');
    }
  };

  return (
    <MinigameShell
      title={t('minigame.theFlip')}
      progress={{ current: Math.min(idx + 1, total), total }}
      combo={cleared > 0 ? <span className="mga-flip-pouch">{t('minigame.flipPouch', { n: cleared })}</span> : undefined}
    >
      <div className="mg-board mga-board mga-flip">
        <div className="mga-flip-buyer">
          <span className="mga-flip-glyph" aria-hidden>
            {buyer.glyph}
          </span>
          <div className="mga-flip-goods">
            <div className="mga-flip-item">{buyer.item}</div>
            <div className="mga-flip-worth">{t('minigame.flipWorth', { value: buyer.baseValue })}</div>
          </div>
        </div>

        <ul className="mga-flip-tells">
          {buyer.tells.map((tell, i) => (
            <li key={i}>{tell}</li>
          ))}
        </ul>

        {phase === 'haggle' && (
          <>
            <div className="mga-flip-price">
              {NUDGES.slice(0, 2).map((d) => (
                <button
                  key={d}
                  type="button"
                  className="btn sm ghost"
                  onClick={() => nudge(d)}
                  aria-label={t('minigame.flipLower', { n: -d })}
                >
                  {d}
                </button>
              ))}
              <span className="mga-flip-quote" aria-live="polite">
                ◈{quote}
              </span>
              {NUDGES.slice(2).map((d) => (
                <button
                  key={d}
                  type="button"
                  className="btn sm ghost"
                  onClick={() => nudge(d)}
                  aria-label={t('minigame.flipRaise', { n: d })}
                >
                  +{d}
                </button>
              ))}
            </div>
            <div className="mga-flip-margin">
              {margin > 0 ? t('minigame.flipMargin', { m: margin }) : t('minigame.flipNoMargin')}
            </div>
            <button className="btn primary block" onClick={offer}>
              {t('minigame.flipOffer', { q: quote })}
            </button>
          </>
        )}

        {phase === 'bite' && (
          <>
            <div className="mga-flip-line fp-bite">{t('minigame.flipBite', { q: quote })}</div>
            <div className="mga-flip-choices">
              <button className="btn primary" onClick={shake}>
                {t('minigame.flipShake')}
              </button>
              <button className="btn ghost" onClick={press}>
                {t('minigame.flipPress', { p: pressTo })}
              </button>
            </div>
          </>
        )}

        {phase === 'settled' && outcome && (
          <>
            <div className={`mga-flip-line fp-${outcome.kind.toLowerCase()}`}>{outcomeLine(outcome)}</div>
            <button className="btn primary block" onClick={next}>
              {last ? t('minigame.flipPack') : t('minigame.flipNext')}
            </button>
          </>
        )}

        <div className="mga-flip-help">
          <button type="button" className="btn sm ghost" onClick={() => setOnboardingOpen(true)}>
            {t('minigame.flipHowTo')}
          </button>
        </div>
      </div>
      {onboardingOpen && <FlipOnboarding onClose={() => setOnboardingOpen(false)} />}
    </MinigameShell>
  );
}
