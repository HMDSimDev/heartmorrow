import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from './Icon';
import { Modal } from './ui';
import './date-onboarding.css';

/** One card of a stepped walkthrough. Keys may carry an explicit namespace
 *  (e.g. `pages:chat.onboarding.talk.title`) — they're resolved with the
 *  caller-facing `t`. */
export interface OnboardingStep {
  icon: IconName;
  titleKey: string;
  bodyKey: string;
}

/**
 * Master kill-switch for AUTO-opening walkthroughs — set by harnesses (the
 * screenshot tool, demo drivers) so no first-use modal ever covers a shot,
 * without having to know every seen-flag that exists. Deliberately does NOT
 * mark anything seen: clear it and a real first-run experience is intact.
 * Reopen buttons ignore it — an explicit click always opens.
 */
export const ONBOARDING_SUPPRESS_KEY = 'dsim.onboardingSuppressed';

/**
 * The one gate every walkthrough's auto-open goes through: false when the
 * harness suppress switch is on or the walkthrough was already seen; otherwise
 * marks it seen IMMEDIATELY (so a mid-walkthrough refresh doesn't re-greet —
 * the Chat.tsx pattern) and returns true. Callers `setOpen(true)` on true.
 */
export function shouldAutoOpenOnboarding(seenKey: string): boolean {
  if (localStorage.getItem(ONBOARDING_SUPPRESS_KEY) === '1') return false;
  if (localStorage.getItem(seenKey) === '1') return false;
  localStorage.setItem(seenKey, '1');
  return true;
}

/**
 * The shared "how this works" walkthrough chrome (the `.dob` almanac card) used
 * by every first-use explainer — dating, the Flip's stall, time Together, the
 * first day, leasing a home. One implementation so every such moment in the
 * game reads as the same almanac page. Callers own the seen-flag and the
 * mount/reopen affordance; `kickerKey` receives `{n}`/`{total}`, and `doneKey`
 * labels the final button (flavored per walkthrough). Back/Skip/Next default
 * to the shared `common:onboarding.*` set.
 */
export function OnboardingSteps({
  steps,
  kickerKey,
  doneKey,
  backKey = 'onboarding.back',
  skipKey = 'onboarding.skip',
  nextKey = 'onboarding.next',
  onClose,
}: {
  steps: ReadonlyArray<OnboardingStep>;
  kickerKey: string;
  doneKey: string;
  backKey?: string;
  skipKey?: string;
  nextKey?: string;
  onClose: () => void;
}) {
  // Subscribe for language changes via useTranslation, but resolve through a
  // string-typed view: step keys arrive as plain strings the typed-key
  // TFunction can't validate (the labels.ts pattern).
  const { t: typedT } = useTranslation(['common', 'pages', 'phone']);
  const t = typedT as unknown as (key: string, opts?: Record<string, unknown>) => string;
  const [step, setStep] = useState(0);
  const s = steps[step]!;
  const last = step === steps.length - 1;
  return (
    <Modal onClose={onClose}>
      <div className="dob">
        <div className="kicker">{t(kickerKey, { n: step + 1, total: steps.length })}</div>
        <div className="dob-emblem" aria-hidden="true">
          <Icon name={s.icon} size={26} />
        </div>
        <h2 className="dob-title">{t(s.titleKey)}</h2>
        <p className="dob-body">{t(s.bodyKey)}</p>
        <div className="dob-dots" aria-hidden="true">
          {steps.map((x, i) => (
            <span key={x.titleKey} className={i === step ? 'on' : ''} />
          ))}
        </div>
        <div className="row end" style={{ flexWrap: 'wrap' }}>
          {step > 0 ? (
            <button className="btn ghost" onClick={() => setStep(step - 1)}>
              {t(backKey)}
            </button>
          ) : (
            <button className="btn ghost" onClick={onClose}>
              {t(skipKey)}
            </button>
          )}
          <button className="btn primary" onClick={() => (last ? onClose() : setStep(step + 1))} autoFocus>
            {last ? t(doneKey) : t(nextKey)}
          </button>
        </div>
      </div>
    </Modal>
  );
}
