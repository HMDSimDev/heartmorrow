import { describe, it, expect, afterEach, vi } from 'vitest';
import { OllamaAdapter, type OllamaAdapterConfig } from './ollama-adapter';
import type { ChatMessage } from './types';

function makeAdapter(overrides: Partial<OllamaAdapterConfig> = {}) {
  return new OllamaAdapter({
    baseUrl: 'http://localhost:11434',
    apiKey: '',
    model: 'llama3.2',
    sampling: { topP: 0.9, topK: 40 },
    ...overrides,
  });
}

/** Stub global fetch with a JSON response and capture each request it received. */
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

/** Build a streaming Response whose body emits the given NDJSON lines. */
function ndjsonResponse(lines: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const line of lines) controller.enqueue(enc.encode(line + '\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('OllamaAdapter.chat request translation', () => {
  it('hits /api/chat, nests options, and parses message/usage/stats', async () => {
    const captured = stubFetch({
      message: { role: 'assistant', content: 'blue sky' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 11,
      eval_count: 18,
      load_duration: 100_000_000,
      prompt_eval_duration: 13_000_000,
      eval_duration: 36_000_000_000, // 36s → 0.5 tok/s for 18 tokens
    });

    const res = await makeAdapter().chat({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'why is the sky blue?' },
      ],
      temperature: 0.7,
      maxTokens: 256,
    });

    const { url, init } = captured.calls[0]!;
    expect(url).toBe('http://localhost:11434/api/chat');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('llama3.2');
    expect(body.stream).toBe(false);
    // Sampling + token cap live under `options`, with Ollama field names.
    expect(body.options).toMatchObject({ temperature: 0.7, num_predict: 256, top_p: 0.9, top_k: 40 });
    // No think field when left at the default.
    expect('think' in body).toBe(false);
    // Messages pass through as { role, content }.
    expect(body.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'why is the sky blue?' },
    ]);

    expect(res.content).toBe('blue sky');
    expect(res.finishReason).toBe('stop');
    expect(res.usage).toEqual({ promptTokens: 11, completionTokens: 18, totalTokens: 29 });
    expect(res.stats?.tokensPerSecond).toBeCloseTo(0.5, 5);
    expect(res.stats?.generationTimeSec).toBeCloseTo(36, 5);
    expect(res.stats?.timeToFirstTokenSec).toBeCloseTo(0.113, 5);
  });

  it.each([
    ['default', undefined],
    ['off', false],
    ['on', true],
    ['high', 'high'],
    ['max', 'max'],
  ] as const)('maps think=%s to the wire value', async (think, expected) => {
    const captured = stubFetch({ message: { content: 'ok' }, done: true });
    await makeAdapter({ think }).chat({ messages: [{ role: 'user', content: 'x' }] });
    const body = JSON.parse(captured.calls[0]!.init.body as string);
    if (expected === undefined) expect('think' in body).toBe(false);
    else expect(body.think).toBe(expected);
  });

  it('maps json_schema response format to a raw `format` schema', async () => {
    const captured = stubFetch({ message: { content: '{}' }, done: true });
    const schema = { type: 'object', properties: { answer: { type: 'string' } } };
    await makeAdapter().chat({
      messages: [{ role: 'user', content: 'go' }],
      responseFormat: { type: 'json_schema', json_schema: { name: 'R', schema } },
    });
    const body = JSON.parse(captured.calls[0]!.init.body as string);
    expect(body.format).toEqual(schema);
  });

  it('maps json_object response format to format: "json"', async () => {
    const captured = stubFetch({ message: { content: '{}' }, done: true });
    await makeAdapter().chat({
      messages: [{ role: 'user', content: 'go' }],
      responseFormat: { type: 'json_object' },
    });
    expect(JSON.parse(captured.calls[0]!.init.body as string).format).toBe('json');
  });

  it('splits a base64 data-URL image into Ollama content + images[]', async () => {
    const captured = stubFetch({ message: { content: 'ok' }, done: true });
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB' } },
          { type: 'image_url', image_url: { url: 'https://example.test/x.png' } }, // remote → dropped
        ],
      },
    ];
    await makeAdapter().chat({ messages });
    const body = JSON.parse(captured.calls[0]!.init.body as string);
    expect(body.messages[0]).toEqual({ role: 'user', content: 'describe', images: ['AAAB'] });
  });

  it('falls back to message.thinking when content is empty', async () => {
    stubFetch({ message: { content: '', thinking: 'reasoned text' }, done: true });
    const res = await makeAdapter({ think: 'on' }).chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(res.content).toBe('reasoned text');
  });

  it('sends a bearer token only when an API key is set', async () => {
    const captured = stubFetch({ message: { content: 'ok' }, done: true });
    await makeAdapter({ apiKey: 'sk-test' }).chat({ messages: [{ role: 'user', content: 'x' }] });
    expect((captured.calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('strips a trailing /v1 from the base URL so a pasted OpenAI URL still resolves', async () => {
    const captured = stubFetch({ message: { content: 'ok' }, done: true });
    await makeAdapter({ baseUrl: 'http://localhost:11434/v1' }).chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(captured.calls[0]!.url).toBe('http://localhost:11434/api/chat');
  });

  it('errors with status + body when the endpoint rejects the request', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('model does not support thinking', { status: 400, statusText: 'Bad Request' })),
    );
    await expect(makeAdapter({ think: 'on' }).chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(
      /400 Bad Request: model does not support thinking/,
    );
  });
});

describe('OllamaAdapter.streamChat', () => {
  it('accumulates NDJSON content deltas and reads usage from the final chunk', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        ndjsonResponse([
          JSON.stringify({ message: { content: 'Hello' }, done: false }),
          JSON.stringify({ message: { content: ', world' }, done: false }),
          JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 2 }),
        ]),
      ),
    );
    const deltas: string[] = [];
    const res = await makeAdapter().streamChat({ messages: [{ role: 'user', content: 'hi' }] }, (d) => deltas.push(d));
    expect(deltas).toEqual(['Hello', ', world']);
    expect(res.content).toBe('Hello, world');
    expect(res.finishReason).toBe('stop');
    expect(res.usage).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });
  });

  it('does not stream the reasoning trace, but surfaces it if content stays empty', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        ndjsonResponse([
          JSON.stringify({ message: { content: '', thinking: 'mulling' }, done: false }),
          JSON.stringify({ message: { content: '', thinking: ' it over' }, done: true, done_reason: 'stop' }),
        ]),
      ),
    );
    const deltas: string[] = [];
    const res = await makeAdapter({ think: 'on' }).streamChat(
      { messages: [{ role: 'user', content: 'hi' }] },
      (d) => deltas.push(d),
    );
    // Only the fallback emission (once content proved empty), never the live trace.
    expect(deltas).toEqual(['mulling it over']);
    expect(res.content).toBe('mulling it over');
  });
});

describe('OllamaAdapter.listModels', () => {
  it('maps /api/tags entries and flags loaded ones from /api/ps', async () => {
    vi.stubGlobal('fetch', (url: string) => {
      if (url.endsWith('/api/tags')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              models: [
                { name: 'llama3.2:latest', details: { family: 'llama', quantization_level: 'Q4_K_M' } },
                { name: 'qwen3:8b', details: { family: 'qwen3', quantization_level: 'Q8_0' } },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      // /api/ps → only llama3.2 is loaded
      return Promise.resolve(new Response(JSON.stringify({ models: [{ name: 'llama3.2:latest' }] }), { status: 200 }));
    });

    const models = await makeAdapter().listModels();
    expect(models).toEqual([
      { id: 'llama3.2:latest', loaded: true, quantization: 'Q4_K_M', type: 'llama' },
      { id: 'qwen3:8b', loaded: false, quantization: 'Q8_0', type: 'qwen3' },
    ]);
  });

  it('still lists models when /api/ps is unavailable (no loaded flags)', async () => {
    vi.stubGlobal('fetch', (url: string) => {
      if (url.endsWith('/api/tags')) {
        return Promise.resolve(new Response(JSON.stringify({ models: [{ name: 'llama3.2:latest' }] }), { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    const models = await makeAdapter().listModels();
    expect(models).toEqual([{ id: 'llama3.2:latest', loaded: undefined, quantization: undefined, type: undefined }]);
  });
});
