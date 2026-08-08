import { OnboardingSteps, type OnboardingStep } from './OnboardingSteps';

/** Seen-flag for the first-date walkthrough. Client-global (localStorage), so it
 *  spans every world and save — the concepts are the same everywhere. */
export const DATE_ONBOARDING_KEY = 'dsim.dateOnboardingSeen';

const STEPS = [
  { icon: 'date', titleKey: 'pages:chat.onboarding.talk.title', bodyKey: 'pages:chat.onboarding.talk.body' },
  { icon: 'location', titleKey: 'pages:chat.onboarding.scene.title', bodyKey: 'pages:chat.onboarding.scene.body' },
  { icon: 'preview', titleKey: 'pages:chat.onboarding.trajectory.title', bodyKey: 'pages:chat.onboarding.trajectory.body' },
  { icon: 'generate', titleKey: 'pages:chat.onboarding.intents.title', bodyKey: 'pages:chat.onboarding.intents.body' },
  { icon: 'recap', titleKey: 'pages:chat.onboarding.stakes.title', bodyKey: 'pages:chat.onboarding.stakes.body' },
] as const satisfies ReadonlyArray<OnboardingStep>;

/**
 * A short stepped walkthrough of how dating works: shown automatically the first
 * time a date opens (any world, any save), and reopenable from the date screen's
 * "How dating works" button. The caller owns the seen-flag. Chrome lives in the
 * shared {@link OnboardingSteps}; this file keeps the date-specific content and
 * its original i18n keys (incl. per-walkthrough Back/Skip/Next flavor).
 */
export function DateOnboarding({ onClose }: { onClose: () => void }) {
  return (
    <OnboardingSteps
      steps={STEPS}
      kickerKey="pages:chat.onboarding.kicker"
      doneKey="pages:chat.onboarding.done"
      backKey="pages:chat.onboarding.back"
      skipKey="pages:chat.onboarding.skip"
      nextKey="pages:chat.onboarding.next"
      onClose={onClose}
    />
  );
}
