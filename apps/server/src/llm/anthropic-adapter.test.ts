import { describe, it, expect, afterEach, vi } from 'vitest';
import { AnthropicAdapter } from './anthropic-adapter';
import type { ChatMessage } from './types';

function makeAdapter() {
  return new AnthropicAdapter({
    baseUrl: 'https://example.test/v1',
    apiKey: 'sk-test',
    model: 'claude-test',
    anthropicVersion: '2023-06-01',
    sampling: { topP: 0.9, topK: 40 },
  });
}

/** Stub global fetch with a JSON response and capture the request it received. */
function stubFetch(json: unknown): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  });
  return { calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('AnthropicAdapter.chat request translation', () => {
  it('extracts system, merges consecutive same-role turns, and sets headers', async () => {
    const captured = stubFetch({
      content: [{ type: 'text', text: 'hi there' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 11, output_tokens: 3 },
    });
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a tester.' },
      { role: 'user', content: 'First.' },
      { role: 'user', content: 'Second.' }, // consecutive user → must merge
    ];

    const res = await makeAdapter().chat({ messages, temperature: 1.5, maxTokens: 64 });

    const { url, init } = captured.calls[0]!;
    expect(url).toBe('https://example.test/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');

    const body = JSON.parse(init.body as string);
    expect(body.system).toBe('You are a tester.');
    expect(body.max_tokens).toBe(64);
    // temperature clamped from 1.5 into Anthropic's [0,1] range
    expect(body.temperature).toBe(1);
    expect(body.top_p).toBe(0.9);
    expect(body.top_k).toBe(40);
    // Two user messages collapse into one turn with two text blocks.
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'First.' }, { type: 'text', text: 'Second.' }] },
    ]);

    // Response parsing: text joined, usage camelCased, totals summed.
    expect(res.content).toBe('hi there');
    expect(res.finishReason).toBe('end_turn');
    expect(res.usage).toEqual({ promptTokens: 11, completionTokens: 3, totalTokens: 14 });
  });

  it('maps a base64 data-URL image into an Anthropic image block', async () => {
    const captured = stubFetch({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB' } },
        ],
      },
    ];

    await makeAdapter().chat({ messages });

    const body = JSON.parse(captured.calls[0]!.init.body as string);
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'describe' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAB' } },
    ]);
  });

  it('maps json_schema response format to output_config.format', async () => {
    const captured = stubFetch({ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn' });
    const schema = { type: 'object', properties: {} };
    await makeAdapter().chat({
      messages: [{ role: 'user', content: 'go' }],
      responseFormat: { type: 'json_schema', json_schema: { name: 'R', schema } },
    });

    const body = JSON.parse(captured.calls[0]!.init.body as string);
    expect(body.output_config).toEqual({ format: { type: 'json_schema', schema } });
  });

  it('errors with status + body when the endpoint rejects the request', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('bad model', { status: 400, statusText: 'Bad Request' })),
    );
    await expect(makeAdapter().chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(
      /400 Bad Request: bad model/,
    );
  });
});
