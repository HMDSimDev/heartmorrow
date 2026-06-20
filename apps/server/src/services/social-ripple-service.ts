import { VOUCH_DELTAS, linkTo } from '@dsim/shared';
import { charactersRepo } from '../db/repositories';
import { ensureRelationship } from './relationship-service';
import { applyRelationshipChange, setRelationshipFlag } from './stat-service';
import { addMemoriesFromEvaluation } from './memory-service';
import { recordEvent } from './event-service';

/**
 * Ripple a relationship milestone/commitment through the subject's social web:
 * characters who consider the subject a friend/family/partner warm to the player
 * (an "intro" bump + a vouching memory); rivals/exes cool. One-time per (rippled
 * character, subject) via a `vouch:<subjectId>` flag, so calling it from both the
 * milestone path and the DTR-accept path is safe. Server-clamped, like every
 * stat change.
 */
export function rippleSocialVouch(subjectId: string): void {
  const subject = charactersRepo.get(subjectId);
  if (!subject?.worldId) return;

  for (const c of charactersRepo.listByWorld(subject.worldId)) {
    if (c.id === subjectId) continue;
    const link = linkTo(c.links, subjectId);
    if (!link) continue;
    const delta = VOUCH_DELTAS[link.kind];
    // A mere acquaintance (empty delta) doesn't vouch or sabotage — crossing paths
    // isn't an endorsement: no stat change, no vouch flag, no planted memory, no event.
    if (Object.keys(delta).length === 0) continue;

    const flag = `vouch:${subjectId}`;
    const rel = ensureRelationship(c.id);
    if (rel.flags[flag]) continue; // fire once per subject

    setRelationshipFlag(c.id, flag, true, { source: 'vouch' });
    applyRelationshipChange(c.id, delta, { source: 'vouch', detail: { subjectId, link: link.kind } });

    const positive = link.kind === 'friend' || link.kind === 'family' || link.kind === 'partner';
    addMemoriesFromEvaluation(
      c.id,
      [{
        text: positive
          ? `Heard from ${subject.name} that things are going well between them and the player.`
          : `Heard the player has been getting close with ${subject.name}.`,
        importance: 3,
        tags: ['social'],
      }],
      null,
    );
    recordEvent('social_vouch', { characterId: c.id, subjectId, link: link.kind, positive });
  }
}
