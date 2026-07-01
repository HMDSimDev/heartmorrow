import fs from 'node:fs';
import path from 'node:path';
import {
  AssetSchema,
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  EXPRESSIONS,
  type Asset,
  type AssetType,
  type AllowedImageMimeType,
  type Expression,
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

/**
 * Parse an image filename to extract character name and expression. Looks for
 * known expression words or "portrait" anywhere in the filename (not just at
 * specific positions), so any naming convention works as long as the trigger
 * words are present:
 *
 *   - `Nicky - Happy_00001_.png`       → "Nicky", expression "happy"
 *   - `Silvija, portrait (1).jpg`      → "Silvija", expression null, type portrait
 *   - `Donna Pinciotti - Happy_1.png`  → "Donna Pinciotti", expression "happy"
 *   - `nicky-happy.png`                → "Nicky", expression "happy"
 *   - `happy_nicky.png`                → "Nicky", expression "happy"
 *   - `portrait_silvija_1.jpg`         → "Silvija", type portrait
 *
 * Returns null when no known expression or "portrait" keyword is found.
 */
export interface ParsedAssetFilename {
  characterName: string;
  expression: Expression | null;
  type: AssetType;
}

/** Build a regex that matches any known expression word (case-insensitive,
 *  whole-word) plus surrounding separator/noise characters, so it can be
 *  removed cleanly from filenames regardless of position. */
const EXPR_PATTERN = new RegExp(
  `[-_\\s,()]*?(${EXPRESSIONS.join('|')})[-_\\s\\d,()]*`,
  'i',
);

const PORTRAIT_PATTERN = /[-_\s,()]*?portrait[-_\s\d,()]*/i;

/** Clean up leftover separator debris and tidy the character name. */
function tidyCharacterName(raw: string): string {
  return raw
    .replace(/[-_\s,()]+/g, ' ')   // collapse separators → space
    .replace(/\s{2,}/g, ' ')       // collapse multiple spaces
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()); // Title Case
}

export function parseAssetFilename(originalFilename: string): ParsedAssetFilename | null {
  const name = originalFilename.replace(/\.[^/.]+$/, '').trim();

  // 1. Look for any known expression keyword anywhere in the filename.
  const exprExec = EXPR_PATTERN.exec(name);
  if (exprExec) {
    const rawExpression = exprExec[1]!.toLowerCase();
    const expression = rawExpression as Expression;
    // Character name = the filename with the matched expression block removed.
    const remainder = name.slice(0, exprExec.index) + name.slice(exprExec.index + exprExec[0].length);
    const characterName = tidyCharacterName(remainder);
    if (characterName) {
      return { characterName, expression, type: 'expression' };
    }
  }

  // 2. Look for "portrait" keyword anywhere in the filename.
  const portExec = PORTRAIT_PATTERN.exec(name);
  if (portExec) {
    const remainder = name.slice(0, portExec.index) + name.slice(portExec.index + portExec[0].length);
    const characterName = tidyCharacterName(remainder);
    if (characterName) {
      return { characterName, expression: null, type: 'portrait' };
    }
  }

  return null;
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

  // Derive character + expression tags from the filename (deterministic parsing).
  const parsed = parseAssetFilename(input.originalFilename);
  const tags = [...(input.tags ?? [])];
  if (parsed) {
    tags.push(`character:${parsed.characterName}`);
    if (parsed.expression) tags.push(`expression:${parsed.expression}`);
    if (!tags.includes(`type:${parsed.type}`)) tags.push(`type:${parsed.type}`);
    // Override the upload type so expression images are auto-typed correctly.
    input.type = parsed.type;
  }

  const asset = AssetSchema.parse({
    id,
    type: input.type,
    path: storedName, // relative to uploads dir
    filename: sanitizeDisplayName(input.originalFilename) || storedName,
    mimeType: input.mimeType,
    altText: input.altText ?? '',
    tags,
    metadata: { bytes: input.buffer.byteLength },
    createdAt: Date.now(),
  });
  return assetsRepo.insert(asset);
}

/** Upload multiple assets in one call. Each file may be auto-tagged via
 *  {@link parseAssetFilename}. Returns all saved assets. */
export function saveBatchAssets(
  files: Array<{ buffer: Buffer; originalFilename: string; mimeType: string }>,
): Asset[] {
  return files.map((f) =>
    saveUploadedAsset({
      buffer: f.buffer,
      originalFilename: f.originalFilename,
      mimeType: f.mimeType,
      type: 'other', // will be overridden by parseAssetFilename if matched
    }),
  );
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
