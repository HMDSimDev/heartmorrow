import type { Relationship } from './schemas/entities';
import { warmthBand, bandIndex, currentStatus, isBrokenUp } from './social';

/**
 * Tragic-outcome ("despair") model — OPT-IN, behind settings.tragicOutcomesEnabled
 * (itself behind NSFW). This is the dark mirror of the soft-win ending: sustained,
 * severe mistreatment of someone who was deeply attached to you can spiral into a
 * self-harm outcome that permanently memorializes them.
 *
 * Design principles baked into the numbers below:
 *  - It NEVER triggers from a shallow relationship — only someone who loved you.
 *  - Despair HEALS every day on its own, so simply STOPPING (or leaving them be)
 *    pulls them back. The player must actively, repeatedly harm them over many
 *    days, ignoring escalating warnings, to reach the end.
 *  - The act itself is NEVER depicted — only its aftermath (a memorial). No method,
 *    no graphic content, ever.
 */

export const DESPAIR = {
  /** Natural daily healing — the off-ramp. A few quiet days fully recover them. */
  decayPerDay: 8,
  /** Showing up for a real, non-cruel date with them heals more — kindness works. */
  dateHeal: 12,

  // Acute harm bursts the SERVER adds when a specific cruelty occurs:
  /** A breakup (scaled up by how many times you've already broken their heart). */
  breakupBase: 12,
  breakupPerPrior: 6,
  /** Cheating discovered while they were committed to you. */
  cheatHit: 16,
  /** You were hostile/cruel enough that they walked out. */
  hostility: 14,

  // Stage thresholds on a 0..100 scale:
  withdrawn: 40, // quiet, low, pulling away — first visible warning
  crisis: 70, // openly struggling; a friend reaches out
  terminal: 90, // only reachable after sustained crisis (see below)

  /** Minimum days a character must stay AT crisis (with warnings firing) before
   *  the terminal outcome is even possible — guarantees many chances to pull back. */
  crisisDaysBeforeTerminal: 3,

  max: 100,
} as const;

export type DespairStage = 'stable' | 'withdrawn' | 'crisis';

export function despairStage(value: number): DespairStage {
  if (value >= DESPAIR.crisis) return 'crisis';
  if (value >= DESPAIR.withdrawn) return 'withdrawn';
  return 'stable';
}

/**
 * Only a character who was DEEPLY attached can be devastated this way. True if
 * they're close/committed now, were ever committed (broke up / breakup history),
 * or have been flagged attached once despair began accruing.
 */
export function despairEligible(rel: Relationship): boolean {
  const attachedNow = bandIndex(warmthBand(rel)) >= bandIndex('close') || currentStatus(rel) !== 'none';
  const breakupCount = typeof rel.flags['breakup:count'] === 'number' ? (rel.flags['breakup:count'] as number) : 0;
  const wasAttached = isBrokenUp(rel) || breakupCount > 0 || rel.flags['harm:attached'] === true;
  return attachedNow || wasAttached;
}

/** A memorialized character is permanently out of active play (a soft, kept record). */
export function isMemorialized(rel: Relationship): boolean {
  return rel.flags['harm:memorial'] === true;
}

export interface CrisisResource {
  label: string;
  detail: string;
}

/** Real-world help, surfaced to the PLAYER at the toggle and if an outcome occurs. */
export const CRISIS_RESOURCES: CrisisResource[] = [
  { label: '988 Suicide & Crisis Lifeline (US)', detail: 'Call or text 988, any time, day or night.' },
  { label: 'Crisis Text Line', detail: 'Text HOME to 741741 (US & Canada), or 85258 (UK).' },
  { label: 'Find a helpline anywhere', detail: 'findahelpline.com lists free, confidential lines worldwide.' },
];

export const CRISIS_BLURB =
  'If you or someone you know is struggling, you are not alone — free, confidential help is available any time.';
