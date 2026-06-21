import { LlmSettingsSchema, type LlmSettings } from '@dsim/shared';
import { initDatabase } from '../db/index';
import { createWorld } from '../services/world-service';
import { createCharacter } from '../services/character-service';
import type { ChatAdapter, ChatRequest, ChatResult } from '../llm/types';

/** Reset to a fresh in-memory database for each test. */
export function resetDb(): void {
  initDatabase({ memory: true });
}

export function testSettings(overrides: Partial<LlmSettings> = {}): LlmSettings {
  return LlmSettingsSchema.parse({ model: 'test-model', ...overrides });
}

/** Adapter that returns a scripted sequence of responses (last one repeats). */
export class ScriptedAdapter implements ChatAdapter {
  readonly name = 'scripted';
  calls = 0;
  constructor(private readonly responses: string[]) {}

  async chat(_req: ChatRequest): Promise<ChatResult> {
    const idx = Math.min(this.calls, this.responses.length - 1);
    this.calls += 1;
    return { content: this.responses[idx] ?? '' };
  }

  async streamChat(req: ChatRequest, onDelta: (t: string) => void): Promise<ChatResult> {
    const result = await this.chat(req);
    onDelta(result.content);
    return result;
  }

  async listModels(): Promise<string[]> {
    return [];
  }
}

export function seedWorldAndCharacter() {
  const world = createWorld({ name: 'Test World' });
  const character = createCharacter({
    worldId: world.id,
    name: 'Test Character',
    age: 25,
    datingStats: { charm: 50, empathy: 50, humor: 50, confidence: 50, intellect: 50, style: 50 },
  });
  return { world, character };
}

const STATS = { charm: 50, empathy: 50, humor: 50, confidence: 50, intellect: 50, style: 50 };

/** A world with group dates enabled + two available characters (the host `a` and a
 *  co-attendee `b`), for exercising the group-date data spine and turn loop. */
export function seedGroupWorld() {
  const world = createWorld({ name: 'Group World', featureFlags: { groupDates: true } });
  const a = createCharacter({ worldId: world.id, name: 'Avery', age: 27, datingStats: STATS });
  const b = createCharacter({ worldId: world.id, name: 'Bo', age: 29, datingStats: STATS });
  return { world, a, b };
}
