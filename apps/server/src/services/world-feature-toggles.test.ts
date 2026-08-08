import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FeatureFlagsSchema } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { updateWorld } from './world-service';
import { featureEnabled } from './world-feature-service';
import { generateDailyEmails, listEmails } from './email-service';
import { generatePostcardsForDay } from './postcard-service';
import { createPlayerPost, generateFeedForDay, getFeedView } from './feed-service';
import { ensureWorldState } from './world-clock-service';

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('per-world Mail/Faces toggles', () => {
  it('default ON — unlike the opt-in money systems — so existing worlds are unchanged', () => {
    // The schema is the back-compat contract: a stored flag blob from before the
    // toggles existed parses to email/faces ENABLED and the money systems off.
    expect(FeatureFlagsSchema.parse({})).toEqual({
      property: false,
      stockMarket: false,
      gambling: false,
      email: true,
      faces: true,
    });
    const { world } = seedWorldAndCharacter();
    expect(featureEnabled(world.id, 'email')).toBe(true);
    expect(featureEnabled(world.id, 'faces')).toBe(true);
  });

  it('turning them off stops all generation — zero model calls, zero rows', async () => {
    const { world } = seedWorldAndCharacter();
    updateWorld(world.id, { featureFlags: { property: false, stockMarket: false, gambling: false, email: false, faces: false } });
    const adapter = new ScriptedAdapter(['{}']);
    setAdapterOverride(adapter);

    const day = ensureWorldState(world.id).day;
    await generateDailyEmails(world.id, day);
    await generatePostcardsForDay(world.id, day);
    await generateFeedForDay(world.id, day);

    expect(adapter.calls).toBe(0); // the whole point: a disabled system spends no tokens
    expect(listEmails(world.id)).toHaveLength(0);
    expect(getFeedView(world.id).posts).toHaveLength(0);
  });

  it('a faces-off world refuses player feed posts server-side (403), like the wealth gates', async () => {
    const { world } = seedWorldAndCharacter();
    updateWorld(world.id, { featureFlags: { property: false, stockMarket: false, gambling: false, email: false, faces: false } });
    await expect(createPlayerPost({ worldId: world.id, body: 'hello, town' })).rejects.toThrow(/not enabled/i);
  });

  it('with the defaults, a player post still lands', async () => {
    const { world } = seedWorldAndCharacter();
    const res = await createPlayerPost({ worldId: world.id, body: 'lovely evening on the pier' });
    expect(res.post.body).toBe('lovely evening on the pier');
    expect(getFeedView(world.id).posts.length).toBeGreaterThan(0);
  });
});
