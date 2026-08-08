import { OnboardingSteps, type OnboardingStep } from './OnboardingSteps';

/** Seen-flag for the first-day walkthrough — the energy loop that gates every
 *  other mechanic. Client-global (localStorage): the day works the same in
 *  every world and save. */
export const DAY_ONBOARDING_KEY = 'dsim.dayOnboardingSeen';

const STEPS = [
  { icon: 'work', titleKey: 'common:dayOnb.actions.title', bodyKey: 'common:dayOnb.actions.body' },
  { icon: 'phone', titleKey: 'common:dayOnb.talk.title', bodyKey: 'common:dayOnb.talk.body' },
  { icon: 'moon', titleKey: 'common:dayOnb.sleep.title', bodyKey: 'common:dayOnb.sleep.body' },
] as const satisfies ReadonlyArray<OnboardingStep>;

/** Shown once, the first time the player enters a world (App shell mount with an
 *  active world). The caller owns the seen-flag; the Help guide's "Your daily
 *  energy" topic stays the deep reference. */
export function DayOnboarding({ onClose }: { onClose: () => void }) {
  return (
    <OnboardingSteps steps={STEPS} kickerKey="common:dayOnb.kicker" doneKey="common:dayOnb.done" onClose={onClose} />
  );
}
