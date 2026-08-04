import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Jimp } from 'jimp';
import {
  AssetSchema,
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  type Asset,
  type AssetType,
  type AssetUpdate,
  type AssetUsage,
  type AssetUsageMap,
  type ThumbnailRebuildResult,
  type AllowedImageMimeType,
} from '@dsim/shared';
import { config, ensureDirectories } from '../config';
import {
  assetsRepo,
  charactersRepo,
  companiesRepo,
  propertiesRepo,
  shopItemsRepo,
  textMessagesRepo,
  worldsRepo,
} from '../db/repositories';
import { newId } from '../lib/ids';
import { badRequest, notFound } from '../lib/errors';

const MIME_EXT: Record<AllowedImageMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

function isAllowedMime(mime: string): mime is AllowedImageMimeType {
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mime);
}

/**
 * Resolve a relative path INSIDE the uploads directory, rejecting any path that
 * would escape it (path-traversal guard). Returns an absolute path.
 */
export function safeUploadsPath(relativePath: string): string {
  const root = path.resolve(config.uploadsDir);
  // Normalize backslashes to forward slashes so traversal segments are caught
  // consistently on POSIX, where `path.resolve` treats `\` as a literal
  // filename character rather than a separator.
  const normalized = relativePath.replace(/\\/g, '/');
  const target = path.resolve(root, normalized);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw badRequest('Resolved path escapes the uploads directory.');
  }
  return target;
}

// --- Thumbnails --------------------------------------------------------------
//
// Thumbs are DERIVED files, not schema state: `<id>.<ext>` -> `<id>.thumb.<ext>`
// beside the original in the uploads dir. Clients request the thumb URL and fall
// back to the original on 404, so a missing thumb is never an error — just a
// heavier image. That keeps the Asset schema (and pack export format) untouched.

const THUMB_SIZE = 256;

/** `asset_x.png` -> `asset_x.thumb.png`. Pure string derivation, shared with the client. */
export function thumbRelPath(assetPath: string): string {
  return assetPath.replace(/\.(png|jpg)$/i, '.thumb.$1');
}

/** Write a downscaled copy beside the original. Returns false when the original
 *  is already small enough that the fallback-to-original serves fine as-is. */
async function writeThumbnail(asset: Asset, buffer: Buffer): Promise<boolean> {
  const image = await Jimp.fromBuffer(buffer);
  if (image.width <= THUMB_SIZE && image.height <= THUMB_SIZE) return false;
  image.scaleToFit({ w: THUMB_SIZE, h: THUMB_SIZE });
  const out =
    asset.mimeType === 'image/png'
      ? await image.getBuffer('image/png')
      : await image.getBuffer('image/jpeg', { quality: 80 });
  fs.writeFileSync(safeUploadsPath(thumbRelPath(asset.path)), out);
  return true;
}

/** Generate any missing thumbnails (existing ones are never re-encoded). */
export async function rebuildThumbnails(): Promise<ThumbnailRebuildResult> {
  let generated = 0;
  let skipped = 0;
  let failed = 0;
  for (const a of assetsRepo.list()) {
    try {
      const abs = safeUploadsPath(a.path);
      if (!fs.existsSync(abs)) {
        failed += 1;
        continue;
      }
      if (fs.existsSync(safeUploadsPath(thumbRelPath(a.path)))) {
        skipped += 1;
        continue;
      }
      if (await writeThumbnail(a, fs.readFileSync(abs))) generated += 1;
      else skipped += 1;
    } catch {
      failed += 1;
    }
  }
  return { generated, skipped, failed };
}

export interface SaveAssetInput {
  buffer: Buffer;
  originalFilename: string;
  mimeType: string;
  type: AssetType;
  altText?: string;
  tags?: string[];
}

const sha256Hex = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

/** Shared gate for anything that writes image bytes: mime allowlist, non-empty, size cap. */
function assertValidImage(buffer: Buffer, mimeType: string): asserts mimeType is AllowedImageMimeType {
  if (!isAllowedMime(mimeType)) {
    throw badRequest(
      `Unsupported image type "${mimeType}". Allowed: ${ALLOWED_IMAGE_MIME_TYPES.join(', ')}.`,
    );
  }
  if (buffer.byteLength === 0) {
    throw badRequest('Uploaded file is empty.');
  }
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw badRequest(`File too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MiB).`);
  }
}

export function saveUploadedAsset(input: SaveAssetInput): Asset {
  assertValidImage(input.buffer, input.mimeType);

  ensureDirectories();

  // Generate a safe stored filename — we NEVER trust the client's filename for
  // the on-disk name, eliminating path traversal at the source.
  const id = newId('asset');
  const ext = MIME_EXT[input.mimeType];
  const storedName = `${id}.${ext}`;
  const absPath = safeUploadsPath(storedName);
  fs.writeFileSync(absPath, input.buffer);

  const asset = AssetSchema.parse({
    id,
    type: input.type,
    path: storedName, // relative to uploads dir
    filename: sanitizeDisplayName(input.originalFilename) || storedName,
    mimeType: input.mimeType,
    altText: input.altText ?? '',
    tags: input.tags ?? [],
    metadata: { bytes: input.buffer.byteLength, sha256: sha256Hex(input.buffer) },
    createdAt: Date.now(),
  });
  // Fire-and-forget: the upload response never waits on (or fails because of)
  // thumbnailing. Until the thumb lands, clients fall back to the original.
  void writeThumbnail(asset, input.buffer).catch(() => {});
  return assetsRepo.insert(asset);
}

/**
 * Save an upload UNLESS a byte-identical asset already exists — then reuse that
 * row instead (the fix for re-imported packs multiplying every image). On a hit,
 * incoming tags are merged in (so contextual auto-tags accumulate on the shared
 * asset) and nothing new touches the disk — callers that track written files for
 * rollback must skip deduped results. The oldest matching asset wins, and a hit
 * whose file has gone missing on disk falls through to a fresh save.
 */
export function dedupeOrSaveAsset(input: SaveAssetInput): { asset: Asset; deduped: boolean } {
  const existing =
    input.buffer.byteLength > 0 ? assetsRepo.findByHash(sha256Hex(input.buffer)) : undefined;
  if (existing && fs.existsSync(safeUploadsPath(existing.path))) {
    const merged = [...new Set([...existing.tags, ...(input.tags ?? [])])];
    const asset =
      merged.length !== existing.tags.length
        ? assetsRepo.update(AssetSchema.parse({ ...existing, tags: merged }))
        : existing;
    // Older rows may predate thumbnails; top one up while we have the bytes.
    if (!fs.existsSync(safeUploadsPath(thumbRelPath(asset.path)))) {
      void writeThumbnail(asset, input.buffer).catch(() => {});
    }
    return { asset, deduped: true };
  }
  return { asset: saveUploadedAsset(input), deduped: false };
}

/**
 * One-time-ish startup pass: stamp `metadata.sha256` onto assets uploaded before
 * dedup existed so they participate in matching. Idempotent and cheap (only
 * hashes rows missing the field). Returns how many were stamped.
 */
export function backfillAssetHashes(): number {
  let stamped = 0;
  for (const a of assetsRepo.list()) {
    if (typeof a.metadata.sha256 === 'string') continue;
    try {
      const abs = safeUploadsPath(a.path);
      if (!fs.existsSync(abs)) continue;
      const sha256 = sha256Hex(fs.readFileSync(abs));
      assetsRepo.update(AssetSchema.parse({ ...a, metadata: { ...a.metadata, sha256 } }));
      stamped += 1;
    } catch {
      // Unreadable file: leave the row unhashed; dedup simply won't match it.
    }
  }
  return stamped;
}

export function listAssets(): Asset[] {
  return assetsRepo.list();
}

/**
 * Read an uploaded asset's bytes from the controlled uploads directory. Path is
 * resolved through {@link safeUploadsPath} (traversal guard), so callers never
 * touch arbitrary filesystem paths. Used by server-side image generation to
 * base64-encode a portrait for a vision model.
 */
export function readAssetFile(id: string): { buffer: Buffer; mimeType: string } {
  const asset = getAsset(id);
  const abs = safeUploadsPath(asset.path);
  if (!fs.existsSync(abs)) throw notFound(`Asset ${id} file is missing.`);
  return { buffer: fs.readFileSync(abs), mimeType: asset.mimeType };
}

export function getAsset(id: string): Asset {
  const a = assetsRepo.get(id);
  if (!a) throw notFound(`Asset ${id} not found.`);
  return a;
}

/** Edit display metadata only — swapping the actual image goes through
 *  {@link replaceAssetFile}. */
export function updateAsset(id: string, patch: AssetUpdate): Asset {
  const existing = getAsset(id);
  // AssetUpdateSchema is a strict partial of these four fields, so a plain
  // spread applies exactly what the caller sent and nothing else.
  const next = AssetSchema.parse({ ...existing, ...patch });
  return assetsRepo.update(next);
}

/**
 * Swap an asset's image bytes IN PLACE: the id — and therefore every reference
 * (portraits, expressions, locations, items, texts) — stays put and simply shows
 * the new picture. Display metadata (filename, alt, tags, type) is kept; bytes,
 * hash, and thumbnail are refreshed. The extension may change (png <-> jpg), in
 * which case the old file is unlinked after the new one lands.
 */
export function replaceAssetFile(
  id: string,
  input: { buffer: Buffer; mimeType: string },
): Asset {
  const existing = getAsset(id);
  assertValidImage(input.buffer, input.mimeType);
  ensureDirectories();

  const newPath = `${id}.${MIME_EXT[input.mimeType]}`;
  fs.writeFileSync(safeUploadsPath(newPath), input.buffer);

  const next = AssetSchema.parse({
    ...existing,
    path: newPath,
    mimeType: input.mimeType,
    metadata: { ...existing.metadata, bytes: input.buffer.byteLength, sha256: sha256Hex(input.buffer) },
  });
  assetsRepo.update(next);

  // Old original (only when the extension changed) + old thumb are now stale.
  try {
    if (existing.path !== newPath) {
      const oldAbs = safeUploadsPath(existing.path);
      if (fs.existsSync(oldAbs)) fs.unlinkSync(oldAbs);
    }
    const oldThumb = safeUploadsPath(thumbRelPath(existing.path));
    if (fs.existsSync(oldThumb)) fs.unlinkSync(oldThumb);
  } catch {
    // Stale files are cosmetic; the row already points at the new bytes.
  }
  void writeThumbnail(next, input.buffer).catch(() => {});
  return next;
}

/**
 * Scan every asset-referencing field in the DB and report, per asset id, the
 * places it appears. Assets referenced nowhere are absent from the map — that
 * absence is what the client's "Unused" filter keys off. Play-through data
 * (image texts) is aggregated to a count rather than listed row by row.
 */
export function getAssetUsages(): AssetUsageMap {
  const usages: AssetUsageMap = {};
  const add = (assetId: string | null | undefined, entry: AssetUsage): void => {
    if (!assetId) return;
    (usages[assetId] ??= []).push(entry);
  };

  const worlds = worldsRepo.list();
  const worldName = new Map(worlds.map((w) => [w.id, w.name]));
  const inWorld = (worldId: string, name: string): string => {
    const w = worldName.get(worldId);
    return w ? `${w} — ${name}` : name;
  };

  for (const c of charactersRepo.list()) {
    add(c.portraitAssetId, { kind: 'portrait', refId: c.id, label: c.name, worldId: c.worldId });
    // One entry per character per asset, carrying every expression name that
    // points at it — so clients can say "Minh An — blushing", not just "used".
    const exprByAsset = new Map<string, string[]>();
    for (const [expression, assetId] of Object.entries(c.expressionAssets)) {
      if (!assetId) continue;
      const list = exprByAsset.get(assetId) ?? [];
      list.push(expression);
      exprByAsset.set(assetId, list);
    }
    for (const [assetId, expressions] of exprByAsset) {
      add(assetId, { kind: 'expression', refId: c.id, label: c.name, worldId: c.worldId, expressions });
    }
  }
  for (const w of worlds) {
    for (const loc of w.locations) {
      add(loc.imageAssetId, {
        kind: 'location',
        refId: w.id,
        label: `${w.name} — ${loc.name}`,
        worldId: w.id,
      });
    }
  }
  // Shop items are global (worldId null): they surface under "All worlds" only.
  for (const s of shopItemsRepo.list()) {
    add(s.assetId, { kind: 'item', refId: s.id, label: s.name, worldId: null });
  }
  for (const p of propertiesRepo.list()) {
    add(p.assetId, { kind: 'property', refId: p.id, label: inWorld(p.worldId, p.name), worldId: p.worldId });
  }
  for (const co of companiesRepo.list()) {
    add(co.assetId, { kind: 'company', refId: co.id, label: inWorld(co.worldId, co.name), worldId: co.worldId });
  }
  for (const t of textMessagesRepo.countByImageAsset()) {
    add(t.assetId, { kind: 'texts', refId: t.assetId, label: '', worldId: t.worldId, count: t.count });
  }
  return usages;
}

export function deleteAsset(id: string): void {
  const asset = getAsset(id);
  try {
    const abs = safeUploadsPath(asset.path);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
    const thumbAbs = safeUploadsPath(thumbRelPath(asset.path));
    if (fs.existsSync(thumbAbs)) fs.unlinkSync(thumbAbs);
  } catch {
    // Best effort: still remove the DB row even if the file is already gone.
  }
  assetsRepo.delete(id);
}

/** Keep a human-readable original name for display, stripped of path parts. */
function sanitizeDisplayName(name: string): string {
  const base = name.replace(/^.*[\\/]/, '').trim();
  return base.replace(/[^\w.\- ]+/g, '_').slice(0, 120);
}
