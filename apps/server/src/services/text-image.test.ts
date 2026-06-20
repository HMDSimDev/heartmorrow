import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb, seedWorldAndCharacter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import type { ChatAdapter, ChatRequest, ChatResult, ChatContentPart, ChatImagePart } from '../llm/types';
import { addPlayerMessage, createSession } from './conversation-service';
import { saveUploadedAsset, deleteAsset } from './asset-service';
import { sendPlayerText } from './text-message-service';

/** Records EVERY request it's given (sendPlayerText makes a reply + a judge call). */
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
  async listModels(): Promise<string[]> {
    return [];
  }
}

const REPLY = JSON.stringify({ body: 'aw, cute pic!', tone: 'warm' });
const JUDGE = JSON.stringify({ engagement: 2, hostile: false });

const createdAssetIds: string[] = [];
function makePhoto(): string {
  const asset = saveUploadedAsset({
    buffer: Buffer.from('downscaled-jpeg-bytes'),
    originalFilename: 'pic.jpg',
    mimeType: 'image/jpeg',
    type: 'other',
  });
  createdAssetIds.push(asset.id);
  return asset.id;
}

/** A character the player has actually dated (so texting is allowed). */
function datedCharacter() {
  const { character } = seedWorldAndCharacter();
  const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
  addPlayerMessage(session.id, 'hi there');
  return character;
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

describe('sending an image over text (vision)', () => {
  it('routes the photo to the model as a multimodal image part and persists it', async () => {
    const adapter = new RecordingAdapter([REPLY, JUDGE]);
    setAdapterOverride(adapter);
    const character = datedCharacter();
    const assetId = makePhoto();

    const res = await sendPlayerText(character.id, 'look at this', assetId);

    expect(res.reply?.body).toBe('aw, cute pic!');
    expect(res.playerMessage.imageAssetId).toBe(assetId);

    // At least one call (the reply) carried the image as a data URL.
    const withImage = adapter.requests.find((r) => r.messages.some((m) => Array.isArray(m.content)));
    expect(withImage).toBeTruthy();
    const arrayMsg = withImage!.messages.find((m) => Array.isArray(m.content))!;
    const parts = arrayMsg.content as ChatContentPart[];
    const image = parts.find((p): p is ChatImagePart => p.type === 'image_url');
    expect(image).toBeTruthy();
    expect(image!.image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('allows an image-only text (no caption)', async () => {
    setAdapterOverride(new RecordingAdapter([REPLY, JUDGE]));
    const character = datedCharacter();
    const assetId = makePhoto();

    const res = await sendPlayerText(character.id, '', assetId);
    expect(res.playerMessage.body).toBe('');
    expect(res.playerMessage.imageAssetId).toBe(assetId);
    expect(res.reply).not.toBeNull();
  });

  it('a plain text (no image) sends no image part', async () => {
    const adapter = new RecordingAdapter([REPLY, JUDGE]);
    setAdapterOverride(adapter);
    const character = datedCharacter();

    await sendPlayerText(character.id, 'just words');
    const anyImage = adapter.requests.some((r) => r.messages.some((m) => Array.isArray(m.content)));
    expect(anyImage).toBe(false);
  });

  it('rejects an empty text with no image', async () => {
    setAdapterOverride(new RecordingAdapter([REPLY, JUDGE]));
    const character = datedCharacter();
    await expect(sendPlayerText(character.id, '   ')).rejects.toThrow();
  });
});
