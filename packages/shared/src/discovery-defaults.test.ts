import { describe, it, expect } from 'vitest';
import { LlmSettingsSchema } from './schemas/settings';
import { DiscoveryConfigSchema } from './schemas/entities';

/** These are deliberate PRODUCT defaults (see the schema comments). Locked here so a
 *  refactor can't quietly flip them: a fresh install starts as strangers, knowing no one. */
describe('discovery product defaults', () => {
  it('discoveryMode is ON by default — you start as strangers', () => {
    expect(LlmSettingsSchema.parse({}).discoveryMode).toBe(true);
  });

  it('startKnownCount is 0 by default — a fresh world starts you knowing literally no one', () => {
    expect(DiscoveryConfigSchema.parse({}).startKnownCount).toBe(0);
  });
});
