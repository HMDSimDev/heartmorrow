import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb, seedWorldAndCharacter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import type { ChatAdapter, ChatRequest, ChatResult, ChatContentPart, ChatImagePart, LlmModelInfo } from '../llm/types';
import { saveUploadedAsset, deleteAsset } from './asset-service';
import { generateCharacterFromImage } from './character-service';

/**
 * Records EVERY request. Character-from-image is now TWO calls:
 *  1) the vision description (free text, carries the image),
 *  2) the structured character build (text-only).
 * Responses are returned by call index.
 */
class RecordingAdapter implements ChatAdapter {
  readonly name = 'recording';
  requests: ChatRequest[] = [];
  constructor(private readonly responses: string[]) {}
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.requests.push(req);
    const idx = Math.min(this.requests.length - 1, this.responses.length - 1);
    return { content: this.responses[idx] ?? '' };
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

const DESCRIPTION = 'A woman in her late twenties with warm brown skin, dark curly hair, and a calm half-smile.';

/** A full, valid template with deliberately out-of-range edges to exercise bounding. */
const TEMPLATE = {
  name: '  Marisol Vega  ',
  age: 16, // below the adult floor → lifted to 18
  pronouns: 'she/her',
  gender: 'woman', // not in the enum → coerced to 'unspecified'
  sexuality: 'straight',
  shortDescription: 'A harbor-town painter.',
  personality: 'Warm, observant, a little guarded.',
  speechStyle: 'Soft, dry humor.',
  relationshipPreferences: 'Slow burn.',
  relationshipStyle: 'monogamous',
  likes: ['  oil paint  ', '', 'sea air'],
  dislikes: ['small talk'],
  goals: ['open a studio'],
  boundaries: ['no yelling'],
  appearance: 'Lean, freckled, paint-stained fingers.',
  textingStyle: 'lowercase, few emoji',
  onlinePersona: 'quiet lurker',
  loveLanguage: 'acts of service',
  physicalNeeds: ['quiet mornings'],
  physicalDesires: ['being noticed'],
  physicalDislikes: ['crowds'],
  insecurities: ['fear of being ordinary'],
  quirks: ['hums while working'],
  datingStats: { charm: 150, empathy: -20, humor: 50, confidence: 50, intellect: 50, style: 50 },
};

const createdAssetIds: string[] = [];
function makePortrait(): string {
  const asset = saveUploadedAsset({
    buffer: Buffer.from('not-a-real-png-but-non-empty'),
    originalFilename: 'face.png',
    mimeType: 'image/png',
    type: 'portrait',
  });
  createdAssetIds.push(asset.id);
  return asset.id;
}

beforeEach(() => resetDb());
afterEach(() => {
  for (const id of createdAssetIds.splice(0)) {
    try {
      deleteAsset(id);
    } catch {
      /* row already gone */
    }
  }
  setAdapterOverride(null);
});

describe('character generation from a portrait (two-stage vision)', () => {
  it('stage 1 sends the image; stage 2 (the build) is text-only', async () => {
    const adapter = new RecordingAdapter([DESCRIPTION, JSON.stringify(TEMPLATE)]);
    setAdapterOverride(adapter);
    const assetId = makePortrait();

    const res = await generateCharacterFromImage({ assetId, worldId: null });
    expect(res.ok).toBe(true);
    expect(adapter.requests.length).toBe(2);

    // Stage 1 (first call) carries the portrait as a multimodal image part.
    const visionMsg = adapter.requests[0]!.messages.find((m) => Array.isArray(m.content));
    expect(visionMsg).toBeTruthy();
    const parts = visionMsg!.content as ChatContentPart[];
    const image = parts.find((p): p is ChatImagePart => p.type === 'image_url');
    expect(image).toBeTruthy();
    expect(image!.image_url.url.startsWith('data:image/png;base64,')).toBe(true);

    // Stage 2 (the structured build) never sees the image — all text content.
    const buildHasImage = adapter.requests[1]!.messages.some((m) => Array.isArray(m.content));
    expect(buildHasImage).toBe(false);
    // …and the stage-1 description was fed into the build prompt.
    const buildText = adapter.requests[1]!.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
    expect(buildText).toContain(DESCRIPTION);
  });

  it('bounds the draft: age floor, stat clamp, enum coercion, trimming', async () => {
    setAdapterOverride(new RecordingAdapter([DESCRIPTION, JSON.stringify(TEMPLATE)]));
    const assetId = makePortrait();

    const res = await generateCharacterFromImage({ assetId, worldId: null });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const d = res.data;

    expect(d.name).toBe('Marisol Vega');
    expect(d.age).toBe(18);
    expect(d.gender).toBe('unspecified');
    expect(d.sexuality).toBe('straight');
    expect(d.datingStats.charm).toBe(100);
    expect(d.datingStats.empathy).toBe(0);
    expect(d.likes).toEqual(['oil paint', 'sea air']);
  });

  it('fails safe (ok:false) when the build stage returns unusable output', async () => {
    setAdapterOverride(new RecordingAdapter([DESCRIPTION, 'not json at all']));
    const assetId = makePortrait();

    const res = await generateCharacterFromImage({ assetId, worldId: null });
    expect(res.ok).toBe(false);
  });

  it('fails safe (ok:false) when the vision stage returns no description', async () => {
    setAdapterOverride(new RecordingAdapter(['', JSON.stringify(TEMPLATE)]));
    const assetId = makePortrait();

    const res = await generateCharacterFromImage({ assetId, worldId: null });
    expect(res.ok).toBe(false);
  });

  it('feeds the world’s existing cast into the build prompt with a no-duplicate rule', async () => {
    const adapter = new RecordingAdapter([DESCRIPTION, JSON.stringify(TEMPLATE)]);
    setAdapterOverride(adapter);
    const { world } = seedWorldAndCharacter(); // creates a world + "Test Character"
    const assetId = makePortrait();

    const res = await generateCharacterFromImage({ assetId, worldId: world.id });
    expect(res.ok).toBe(true);

    const buildText = adapter
      .requests[1]!.messages.map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    expect(buildText).toContain('Test Character'); // the existing cast member
    expect(buildText.toLowerCase()).toContain('do not duplicate');
  });

  it('rejects a missing asset before any model call', async () => {
    const adapter = new RecordingAdapter([DESCRIPTION, JSON.stringify(TEMPLATE)]);
    setAdapterOverride(adapter);
    await expect(generateCharacterFromImage({ assetId: 'does-not-exist', worldId: null })).rejects.toThrow();
    expect(adapter.requests.length).toBe(0);
  });
});
