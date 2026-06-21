import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { callStructuredLlm } from './structured';
import { ScriptedAdapter, testSettings } from '../test/helpers';
import type { ChatAdapter, ChatRequest, ChatResult, LlmModelInfo } from './types';

const Schema = z.object({ mood: z.string(), score: z.number().int() });

/** Rejects a specific response_format type (like newer LM Studio rejecting json_object). */
class FormatPickyAdapter implements ChatAdapter {
  readonly name = 'picky';
  calls = 0;
  formatsSeen: string[] = [];
  constructor(
    private readonly reject: string,
    private readonly payload: string,
  ) {}
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.calls += 1;
    const type = req.responseFormat?.type ?? 'none';
    this.formatsSeen.push(type);
    if (type === this.reject) {
      throw new Error(`LLM endpoint returned 400: 'response_format.type' must be 'json_schema' or 'text'`);
    }
    return { content: this.payload };
  }
  async streamChat(req: ChatRequest, onDelta: (t: string) => void): Promise<ChatResult> {
    const r = await this.chat(req);
    onDelta(r.content);
    return r;
  }
  async listModels(): Promise<LlmModelInfo[]> {
    return [];
  }
}

describe('callStructuredLlm', () => {
  it('succeeds after an initial malformed response (retry/repair)', async () => {
    const adapter = new ScriptedAdapter([
      'sorry, here is your answer!', // not JSON
      JSON.stringify({ mood: 'happy', score: 5 }),
    ]);
    const res = await callStructuredLlm(Schema, [{ role: 'user', content: 'task' }], {
      settings: testSettings({ maxRetries: 3 }),
      task: 'unit test',
      adapter,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({ mood: 'happy', score: 5 });
      expect(res.attempts).toBe(2);
    }
    expect(adapter.calls).toBe(2);
  });

  it('fails safely after exhausting retries', async () => {
    const adapter = new ScriptedAdapter(['nope', 'still not json']);
    const res = await callStructuredLlm(Schema, [{ role: 'user', content: 'task' }], {
      settings: testSettings({ maxRetries: 2 }),
      task: 'unit test',
      adapter,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.attempts).toBe(3); // 1 initial + 2 retries
      expect(res.error).toContain('failed after 3');
    }
    expect(adapter.calls).toBe(3);
  });

  it('rejects valid JSON that violates the schema', async () => {
    const adapter = new ScriptedAdapter([JSON.stringify({ mood: 'ok', score: 'not-a-number' })]);
    const res = await callStructuredLlm(Schema, [{ role: 'user', content: 't' }], {
      settings: testSettings({ maxRetries: 0 }),
      task: 'unit test',
      adapter,
    });
    expect(res.ok).toBe(false);
    expect(adapter.calls).toBe(1);
  });

  it('auto-downgrades the response_format when the server rejects it', async () => {
    const adapter = new FormatPickyAdapter('json_object', JSON.stringify({ mood: 'happy', score: 5 }));
    const res = await callStructuredLlm(Schema, [{ role: 'user', content: 'task' }], {
      settings: testSettings({ structuredMode: 'json_object', maxRetries: 3 }),
      task: 'unit test',
      adapter,
    });
    expect(res.ok).toBe(true);
    // It tried json_object (rejected), then downgraded to json_schema (accepted)
    // WITHOUT consuming a content retry.
    expect(adapter.formatsSeen).toEqual(['json_object', 'json_schema']);
    if (res.ok) expect(res.attempts).toBe(1);
  });

  it('never performs regex/partial-JSON salvage (prose with embedded JSON still fails)', async () => {
    const adapter = new ScriptedAdapter([
      'Here you go: {"mood":"happy","score":5} hope that helps!',
    ]);
    const res = await callStructuredLlm(Schema, [{ role: 'user', content: 't' }], {
      settings: testSettings({ maxRetries: 0 }),
      task: 'unit test',
      adapter,
    });
    // Strict JSON.parse fails on prose-wrapped JSON; we do NOT extract it.
    expect(res.ok).toBe(false);
  });
});
