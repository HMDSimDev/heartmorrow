import { describe, it, expect } from 'vitest';
import { zipSync, unzipSync, isSafeEntryName, ZipError, DEFAULT_UNZIP_LIMITS, type UnzipLimits } from './zip';

// These exercise the SECURITY wrapper around fflate — fflate does the DEFLATE/ZIP
// parsing; this module owns the name allow-list, the size/entry/total caps, and the
// shared cross-archive decompression budget (the anti-zip-bomb guards).

describe('isSafeEntryName', () => {
  const ok = ['manifest.json', 'characters/abc-123.json', 'assets/asset_9f.png', 'worlds/0.hmwrld'];
  const bad = [
    '',
    '../evil',
    'a/../b',
    'a/./b',
    '/abs/path',
    'C:/win',
    'c:\\win',
    'a\\b', // backslash
    'with space.json',
    'unicode-é.json',
    'trailing/',
    './x',
    'a//b', // empty segment
  ];
  it('accepts our tame names', () => {
    for (const n of ok) expect(isSafeEntryName(n, 512)).toBe(true);
  });
  it('rejects traversal / absolute / weird names', () => {
    for (const n of bad) expect(isSafeEntryName(n, 512)).toBe(false);
  });
  it('enforces the length cap', () => {
    expect(isSafeEntryName('a'.repeat(20), 10)).toBe(false);
  });
});

describe('zip round-trip', () => {
  it('preserves multiple entries (deflated + stored)', () => {
    const compressible = Buffer.from('abcabcabc'.repeat(5000)); // deflates well
    const tiny = Buffer.from('{"k":1}');
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
    const buf = zipSync([
      { name: 'manifest.json', data: tiny },
      { name: 'big.txt', data: compressible },
      { name: 'assets/a.png', data: binary, store: true },
    ]);
    const out = unzipSync(buf);
    expect(out.get('manifest.json')!.equals(tiny)).toBe(true);
    expect(out.get('big.txt')!.equals(compressible)).toBe(true);
    expect(out.get('assets/a.png')!.equals(binary)).toBe(true);
  });

  it('handles an empty-data entry', () => {
    const buf = zipSync([{ name: 'empty', data: Buffer.alloc(0) }]);
    expect(unzipSync(buf).get('empty')!.length).toBe(0);
  });
});

describe('unzip rejects malformed / hostile archives', () => {
  const limits: UnzipLimits = { ...DEFAULT_UNZIP_LIMITS };

  it('rejects a non-archive', () => {
    expect(() => unzipSync(Buffer.from('not a zip at all, just some bytes'))).toThrow(ZipError);
  });

  it('rejects a too-small buffer', () => {
    expect(() => unzipSync(Buffer.alloc(5))).toThrow(ZipError);
  });

  it('rejects a truncated archive', () => {
    const buf = zipSync([{ name: 'a.json', data: Buffer.from('hello world') }]);
    expect(() => unzipSync(buf.subarray(0, buf.length - 10))).toThrow(ZipError);
  });

  it('rejects a traversal entry name', () => {
    const buf = zipSync([{ name: '../evil', data: Buffer.from('x') }]);
    expect(() => unzipSync(buf)).toThrow(/Unsafe/);
  });

  it('rejects a backslash entry name', () => {
    const buf = zipSync([{ name: 'a\\b', data: Buffer.from('x') }]);
    expect(() => unzipSync(buf)).toThrow(/Unsafe/);
  });

  it('rejects an entry whose declared size exceeds the per-entry cap (before decompressing)', () => {
    const buf = zipSync([{ name: 'big', data: Buffer.alloc(2_000_000) }]);
    expect(() => unzipSync(buf, { ...limits, maxEntryBytes: 1000 })).toThrow(/too large/);
  });

  it('enforces the total-size cap across entries', () => {
    const buf = zipSync([
      { name: 'a', data: Buffer.alloc(600) },
      { name: 'b', data: Buffer.alloc(600) },
    ]);
    expect(() => unzipSync(buf, { ...limits, maxTotalBytes: 1000 })).toThrow(/total size/);
  });

  it('enforces the entry-count cap', () => {
    const buf = zipSync([
      { name: 'a', data: Buffer.from('1') },
      { name: 'b', data: Buffer.from('2') },
    ]);
    expect(() => unzipSync(buf, { ...limits, maxEntries: 1 })).toThrow(/too many entries/);
  });

  it('enforces a shared decompression budget across multiple unzip calls', () => {
    // The anti-amplification guard for nested .hmpack archives: a budget shared
    // across calls so a fan-out of small bombs can't each get a fresh cap.
    const a = zipSync([{ name: 'a', data: Buffer.alloc(600) }]);
    const b = zipSync([{ name: 'b', data: Buffer.alloc(600) }]);
    const budget = { remaining: 1000 };
    unzipSync(a, limits, budget); // 600 drawn down, 400 left
    expect(() => unzipSync(b, limits, budget)).toThrow(/across the bundle/);
  });
});
