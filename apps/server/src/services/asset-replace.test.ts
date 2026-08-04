import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { resetDb } from '../test/helpers';
import {
  saveUploadedAsset,
  replaceAssetFile,
  deleteAsset,
  listAssets,
  readAssetFile,
  safeUploadsPath,
  getAsset,
} from './asset-service';

const png = (tag: string) =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);
const jpg = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(tag)]);

beforeEach(() => resetDb());
afterEach(() => {
  for (const a of listAssets()) deleteAsset(a.id);
});

describe('replaceAssetFile', () => {
  it('swaps bytes in place: same id, kept metadata, refreshed hash', () => {
    const a = saveUploadedAsset({
      buffer: png('one'),
      originalFilename: 'pic.png',
      mimeType: 'image/png',
      type: 'portrait',
      tags: ['keep'],
    });
    const before = getAsset(a.id);

    const next = replaceAssetFile(a.id, { buffer: png('two'), mimeType: 'image/png' });

    expect(next.id).toBe(a.id);
    expect(next.filename).toBe(before.filename); // display metadata survives
    expect(next.tags).toEqual(['keep']);
    expect(next.type).toBe('portrait');
    expect(readAssetFile(a.id).buffer.equals(png('two'))).toBe(true);
    expect(next.metadata.sha256).not.toBe(before.metadata.sha256);
  });

  it('handles a png -> jpg swap: path and mime change, old file is unlinked', () => {
    const a = saveUploadedAsset({
      buffer: png('x'),
      originalFilename: 'x.png',
      mimeType: 'image/png',
      type: 'other',
    });
    const oldAbs = safeUploadsPath(a.path);

    const next = replaceAssetFile(a.id, { buffer: jpg('y'), mimeType: 'image/jpeg' });

    expect(next.id).toBe(a.id);
    expect(next.path.endsWith('.jpg')).toBe(true);
    expect(next.mimeType).toBe('image/jpeg');
    expect(fs.existsSync(oldAbs)).toBe(false);
    expect(readAssetFile(a.id).buffer.equals(jpg('y'))).toBe(true);
  });

  it('rejects a non-image replacement and leaves the asset untouched', () => {
    const a = saveUploadedAsset({
      buffer: png('keep'),
      originalFilename: 'k.png',
      mimeType: 'image/png',
      type: 'other',
    });
    expect(() => replaceAssetFile(a.id, { buffer: Buffer.from('nope'), mimeType: 'text/plain' })).toThrow();
    expect(readAssetFile(a.id).buffer.equals(png('keep'))).toBe(true);
  });
});
