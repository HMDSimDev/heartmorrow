import { z } from 'zod';
import type { RelationshipStatKey } from './stats';

/**
 * Training / Work activities — solo or with a character, costing a daily action
 * (1 stamina) and passing time. WORK earns money; TRAINING is quality time that
 * improves a relationship stat with a chosen character. Effect magnitudes are
 * server-defined here (never client-supplied).
 */

export const ActivityKindSchema = z.enum(['work', 'training']);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

export interface ActivityDef {
  id: string;
  kind: ActivityKind;
  label: string;
  description: string;
  /** Work: money earned. */
  money?: number;
  /** Training: which relationship stat improves, and by how much. */
  relationshipStat?: RelationshipStatKey;
  amount?: number;
}

export const ACTIVITIES: readonly ActivityDef[] = [
  { id: 'work_shift', kind: 'work', label: 'Work a shift', description: 'Steady hours for steady pay.', money: 50 },
  { id: 'odd_jobs', kind: 'work', label: 'Hustle odd jobs', description: 'Grittier work, a better cut.', money: 90 },
  {
    id: 'bond_cook',
    kind: 'training',
    label: 'Cook a meal together',
    description: 'A cozy, low-key evening in.',
    relationshipStat: 'comfort',
    amount: 4,
  },
  {
    id: 'bond_talk',
    kind: 'training',
    label: 'Heart-to-heart',
    description: 'Open up and really listen.',
    relationshipStat: 'trust',
    amount: 4,
  },
  {
    id: 'bond_active',
    kind: 'training',
    label: 'Work out together',
    description: 'Sweat, banter, and a little chemistry.',
    relationshipStat: 'chemistry',
    amount: 4,
  },
];

export const PerformActivitySchema = z.object({
  activityId: z.string().min(1),
  worldId: z.string().min(1),
  characterId: z.string().min(1).nullable().default(null),
});
export type PerformActivity = z.input<typeof PerformActivitySchema>;
