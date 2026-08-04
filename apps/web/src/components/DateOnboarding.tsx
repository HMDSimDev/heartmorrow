import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from './Icon';
import { Modal } from './ui';
import './date-onboarding.css';

/** Seen-flag for the first-date walkthrough. Client-global (localStorage), so it
 *  spans every world and save — the concepts are the same everywhere. */
export const DATE_ONBOARDING_KEY = 'dsim.dateOnboardingSeen';

const STEPS = [
  { icon: 'date', titleKey: 'pages:chat.onboarding.talk.title', bodyKey: 'pages:chat.onboarding.talk.body' },
  { icon: 'location', titleKey: 'pages:chat.onboarding.scene.title', bodyKey: 'pages:chat.onboarding.scene.body' },
  { icon: 'preview', titleKey: 'pages:chat.onboarding.trajectory.title', bodyKey: 'pages:chat.onboarding.trajectory.body' },
  { icon: 'generate', titleKey: 'pages:chat.onboarding.intents.title', bodyKey: 'pages:chat.onboarding.intents.body' },
  { icon: 'recap', titleKey: 'pages:chat.onboarding.stakes.title', bodyKey: 'pages:chat.onboarding.stakes.body' },
] as const satisfies ReadonlyArray<{ icon: IconName; titleKey: string; bodyKey: string }>;

/**
 * A short stepped walkthrough of how dating works: shown automatically the first
 * time a date opens (any world, any save), and reopenable from the date screen's
 * "How dating works" button. The caller owns the seen-flag.
 */
export function DateOnboarding({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(['pages', 'common']);
  const [step, setStep] = useState(0);
  const s = STEPS[step]!;
  const last = step === STEPS.length - 1;
  return (
    <Modal onClose={onClose}>
      <div className="dob">
        <div className="kicker">{t('pages:chat.onboarding.kicker', { n: step + 1, total: STEPS.length })}</div>
        <div className="dob-emblem" aria-hidden="true">
          <Icon name={s.icon} size={26} />
        </div>
        <h2 className="dob-title">{t(s.titleKey)}</h2>
        <p className="dob-body">{t(s.bodyKey)}</p>
        <div className="dob-dots" aria-hidden="true">
          {STEPS.map((x, i) => (
            <span key={x.titleKey} className={i === step ? 'on' : ''} />
          ))}
        </div>
        <div className="row end" style={{ flexWrap: 'wrap' }}>
          {step > 0 ? (
            <button className="btn ghost" onClick={() => setStep(step - 1)}>
              {t('pages:chat.onboarding.back')}
            </button>
          ) : (
            <button className="btn ghost" onClick={onClose}>
              {t('pages:chat.onboarding.skip')}
            </button>
          )}
          <button className="btn primary" onClick={() => (last ? onClose() : setStep(step + 1))} autoFocus>
            {last ? t('pages:chat.onboarding.done') : t('pages:chat.onboarding.next')}
          </button>
        </div>
      </div>
    </Modal>
  );
}
