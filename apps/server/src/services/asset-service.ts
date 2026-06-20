import fs from 'node:fs';
import path from 'node:path';
import {
  AssetSchema,
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  type Asset,
  type AssetType,
  type AllowedImageMimeType,
} from '@dsim/shared';
import { config, ensureDirectories } from '../config';
import { assetsRepo } from '../db/repositories';
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
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw badRequest('Resolved path escapes the uploads directory.');
  }
  return target;
}

export interface SaveAssetInput {
  buffer: Buffer;
  originalFilename: string;
  mimeType: string;
  type: AssetType;
  altText?: string;
  tags?: string[];
}

export function saveUploadedAsset(input: SaveAssetInput): Asset {
  if (!isAllowedMime(input.mimeType)) {
    throw badRequest(
      `Unsupported image type "${input.mimeType}". Allowed: ${ALLOWED_IMAGE_MIME_TYPES.join(', ')}.`,
    );
  }
  if (input.buffer.byteLength === 0) {
    throw badRequest('Uploaded file is empty.');
  }
  if (input.buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw badRequest(`File too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MiB).`);
  }

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
    metadata: { bytes: input.buffer.byteLength },
    createdAt: Date.now(),
  });
  return assetsRepo.insert(asset);
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

export function deleteAsset(id: string): void {
  const asset = getAsset(id);
  try {
    const abs = safeUploadsPath(asset.path);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
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
