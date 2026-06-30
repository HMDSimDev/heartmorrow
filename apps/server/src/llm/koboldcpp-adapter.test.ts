import { describe, it, expect, afterEach, vi } from 'vitest';
import { KoboldcppAdapter, buildKoboldPrompt, type KoboldcppAdapterConfig } from './koboldcpp-adapter';
import type { ChatMessage } from './types';

function makeAdapter(overrides: Partial<KoboldcppAdapterConfig> = {}) {
  return new KoboldcppAdapter({
    baseUrl: 'http://localhost:5001',
    apiKey: '',
    model: 'local-model',
    template: 'alpaca',
    sampling: { topP: 0.9, topK: 40, repeatPenalty: 1.1 },
    ...overrides,
  });
}

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

/** Build a streaming Response whose body emits the given raw SSE text. */
function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

afterEach(() => vi.unstubAllGlobals());

const SAMPLE: ChatMessage[] = [
  { role: 'system', content: 'You are a tester.' },
  { role: 'user', content: 'Say hi.' },
];

describe('buildKoboldPrompt templates', () => {
  it('alpaca: instruction/response markers + response cue + stop', () => {
    const { prompt, stops } = buildKoboldPrompt('alpaca', SAMPLE);
    expect(prompt).toBe('You are a tester.\n\n### Instruction:\nSay hi.\n\n### Response:\n');
    expect(stops).toContain('### Instruction:');
  });

  it('chatml: im_start/im_end framing ending in an assistant cue', () => {
    const { prompt, stops } = buildKoboldPrompt('chatml', SAMPLE);
    expect(prompt).toBe(
      '<|im_start|>system\nYou are a tester.<|im_end|>\n' +
        '<|im_start|>user\nSay hi.<|im_end|>\n' +
        '<|im_start|>assistant\n',
    );
    expect(stops).toEqual(['<|im_end|>', '<|im_start|>']);
  });

  it('llama3: header_id framing with the assistant header cue', () => {
    const { prompt, stops } = buildKoboldPrompt('llama3', SAMPLE);
    expect(prompt.endsWith('<|start_header_id|>assistant<|end_header_id|>\n\n')).toBe(true);
    expect(prompt).toContain('<|start_header_id|>system<|end_header_id|>\n\nYou are a tester.<|eot_id|>');
    expect(stops).toContain('<|eot_id|>');
  });

  it('vicuna: USER/ASSISTANT markers', () => {
    const { prompt, stops } = buildKoboldPrompt('vicuna', SAMPLE);
    expect(prompt).toBe('You are a tester.\n\nUSER: Say hi.\nASSISTANT: ');
    expect(stops).toEqual(['USER:']);
  });

  it('mistral: folds system into the first [INST] block, no extra cue', () => {
    const { prompt, stops } = buildKoboldPrompt('mistral', SAMPLE);
    expect(prompt).toBe('[INST] You are a tester.\n\nSay hi. [/INST]');
    expect(stops).toEqual(['[INST]']);
  });

  it('plain: no role markers, blank cue', () => {
    const { prompt, stops } = buildKoboldPrompt('plain', SAMPLE);
    expect(prompt).toBe('You are a tester.\n\nSay hi.\n\n');
    expect(stops).toEqual([]);
  });

  it('does not append a cue when the conversation already ends on an assistant turn', () => {
    const { prompt } = buildKoboldPrompt('alpaca', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    expect(prompt.endsWith('### Response:\nhello\n\n')).toBe(true);
    expect(prompt.endsWith('### Response:\n')).toBe(false);
  });

  it('splits base64 data-URL images out of the prompt into the image list', () => {
    const { prompt, images } = buildKoboldPrompt('alpaca', [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB' } },
          { type: 'image_url', image_url: { url: 'https://example.test/x.png' } }, // remote → dropped
        ],
      },
    ]);
    expect(images).toEqual(['AAAB']);
    expect(prompt).toContain('### Instruction:\nlook');
  });
});

describe('KoboldcppAdapter.chat', () => {
  it('hits /api/v1/generate, maps sampling, and parses results[0]', async () => {
    const captured = stubFetch({ results: [{ text: 'hi there', finish_reason: 'stop' }] });
    const res = await makeAdapter().chat({ messages: SAMPLE, temperature: 0.7, maxTokens: 200 });

    const { url, init } = captured.calls[0]!;
    expect(url).toBe('http://localhost:5001/api/v1/generate');
    const body = JSON.parse(init.body as string);
    expect(body.max_length).toBe(200);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
    expect(body.top_k).toBe(40);
    expect(body.rep_pen).toBe(1.1); // repeatPenalty → rep_pen
    expect(body.trim_stop).toBe(true);
    expect(body.stop_sequence).toContain('### Instruction:');
    expect(body.prompt).toContain('### Response:\n');
    expect('grammar' in body).toBe(false); // no structured format requested

    expect(res.content).toBe('hi there');
    expect(res.finishReason).toBe('stop');
    expect(res.usage).toBeUndefined(); // native generate reports no token counts
  });

  it('sets a JSON GBNF grammar for structured output, none for plain text', async () => {
    const cap1 = stubFetch({ results: [{ text: '{}' }] });
    await makeAdapter().chat({
      messages: SAMPLE,
      responseFormat: { type: 'json_schema', json_schema: { name: 'R', schema: {} } },
    });
    const g = JSON.parse(cap1.calls[0]!.init.body as string).grammar;
    expect(typeof g).toBe('string');
    expect(g).toContain('root');

    vi.unstubAllGlobals();
    const cap2 = stubFetch({ results: [{ text: 'ok' }] });
    await makeAdapter().chat({ messages: SAMPLE, responseFormat: { type: 'text' } });
    expect('grammar' in JSON.parse(cap2.calls[0]!.init.body as string)).toBe(false);
  });

  it('sends a bearer token only when an API key is set', async () => {
    const captured = stubFetch({ results: [{ text: 'ok' }] });
    await makeAdapter({ apiKey: 'kobold-pw' }).chat({ messages: SAMPLE });
    expect((captured.calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer kobold-pw');
  });

  it('strips a trailing /api from the base URL', async () => {
    const captured = stubFetch({ results: [{ text: 'ok' }] });
    await makeAdapter({ baseUrl: 'http://localhost:5001/api' }).chat({ messages: SAMPLE });
    expect(captured.calls[0]!.url).toBe('http://localhost:5001/api/v1/generate');
  });

  it('errors with status + body when the endpoint rejects the request', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response('bad grammar', { status: 400, statusText: 'Bad Request' })),
    );
    await expect(makeAdapter().chat({ messages: SAMPLE })).rejects.toThrow(/400 Bad Request: bad grammar/);
  });
});

describe('KoboldcppAdapter.streamChat', () => {
  it('accumulates SSE token deltas and captures finish_reason', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        sseResponse([
          'event: message\ndata: {"token": "Hel", "finish_reason": null}\n\n',
          'event: message\ndata: {"token": "lo", "finish_reason": null}\n\n',
          'event: message\ndata: {"token": "", "finish_reason": "stop"}\n\n',
        ]),
      ),
    );
    const deltas: string[] = [];
    const res = await makeAdapter().streamChat({ messages: SAMPLE }, (d) => deltas.push(d));
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(res.content).toBe('Hello');
    expect(res.finishReason).toBe('stop');
  });

  it('requests the SSE stream endpoint with an event-stream Accept header', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(sseResponse(['data: {"token": "x", "finish_reason": "stop"}\n\n']));
    });
    await makeAdapter().streamChat({ messages: SAMPLE }, () => {});
    expect(calls[0]!.url).toBe('http://localhost:5001/api/extra/generate/stream');
    expect((calls[0]!.init.headers as Record<string, string>).Accept).toBe('text/event-stream');
  });
});

describe('KoboldcppAdapter.listModels', () => {
  it('returns the single loaded model (prefix stripped) with context length', async () => {
    vi.stubGlobal('fetch', (url: string) => {
      if (url.endsWith('/api/v1/model')) {
        return Promise.resolve(new Response(JSON.stringify({ result: 'koboldcpp/L3-8B-Stheno' }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ value: 8192 }), { status: 200 }));
    });
    const models = await makeAdapter().listModels();
    expect(models).toEqual([{ id: 'L3-8B-Stheno', loaded: true, contextLength: 8192 }]);
  });

  it('still returns the model when the context-length probe fails', async () => {
    vi.stubGlobal('fetch', (url: string) => {
      if (url.endsWith('/api/v1/model')) {
        return Promise.resolve(new Response(JSON.stringify({ result: 'MyModel' }), { status: 200 }));
      }
      return Promise.resolve(new Response('nope', { status: 404 }));
    });
    const models = await makeAdapter().listModels();
    expect(models).toEqual([{ id: 'MyModel', loaded: true, contextLength: undefined }]);
  });
});
