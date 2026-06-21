import { zipSync as fflateZipSync, unzipSync as fflateUnzipSync, type Zippable, type UnzipFileInfo } from 'fflate';

/**
 * A thin, DELIBERATELY STRICT security wrapper around `fflate` (pure-JS, zero-dep,
 * the most widely used JS compression library) — just enough to produce and consume
 * the share files (`.hmchr` / `.hmwrld` / `.hmpack`). fflate does the battle-tested
 * DEFLATE + ZIP structure parsing; this module owns the SECURITY policy a generic
 * zip library does not: it treats every imported archive as hostile.
 *
 * On read (`unzipSync`) it:
 *   - reads sizes from fflate's central-directory parse and rejects, via the per-file
 *     `filter` (BEFORE any decompression), any entry that is too large, pushes the
 *     archive over its total cap, or exceeds the shared cross-archive budget — so a
 *     zip-bomb / decompression-bomb is refused without doing the work;
 *   - allow-lists entry names to tame ASCII only (rejecting absolute paths, `..`
 *     segments, backslashes, NUL, control chars, spaces, and unicode tricks);
 *   - caps the entry count and per-name length.
 *
 * fflate additionally bounds decompression to each entry's DECLARED uncompressed size
 * (it inflates into a buffer pre-sized from the central directory and does not grow
 * it), so a "lying header" bomb cannot expand past the size the filter already
 * checked.
 *
 * Two things a hand-rolled reader did that this intentionally does NOT, because the
 * IMPORTER's design makes them moot: it does not inspect Unix-mode symlink bits and
 * does not verify CRC-32. Neither matters here — callers NEVER write an archive's
 * entry name to disk (assets are re-saved under server-generated names), so a symlink
 * entry is just inert bytes; and a corrupted/forged entry simply fails the downstream
 * JSON / image validation and is rejected. The name allow-list below remains the
 * primary zip-slip defense, in depth.
 */

export interface UnzipLimits {
  /** Maximum number of entries in the archive. */
  maxEntries: number;
  /** Maximum uncompressed bytes for any single entry. */
  maxEntryBytes: number;
  /** Maximum uncompressed bytes summed across every entry. */
  maxTotalBytes: number;
  /** Maximum length (bytes) of any entry NAME. */
  maxNameLength: number;
}

export const DEFAULT_UNZIP_LIMITS: UnzipLimits = {
  maxEntries: 4096,
  maxEntryBytes: 32 * 1024 * 1024, // 32 MiB — assets are capped well below this
  maxTotalBytes: 256 * 1024 * 1024, // 256 MiB aggregate
  maxNameLength: 512,
};

/**
 * A decompression budget SHARED across several `unzipSync` calls (e.g. a `.hmpack`
 * and all the nested `.hmchr`/`.hmwrld` it contains). Each call decrements
 * `remaining` by the uncompressed size of every entry BEFORE inflating it, and
 * throws once it goes negative — so the per-archive caps can't be multiplied across
 * a nested fan-out. Without one, each archive gets a fresh `maxTotalBytes`, which a
 * bundle of many bombs could exploit.
 */
export interface DecompressBudget {
  remaining: number;
}

export interface ZipEntryInput {
  name: string;
  data: Buffer;
  /** When true, store (level 0) — already-compressed bytes like PNG/JPEG, or a
   *  nested archive: deflating them again wastes CPU for ~nothing. */
  store?: boolean;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

// --- name validation --------------------------------------------------------

// Tame ASCII only: letters, digits, dot, dash, underscore, forward slash. By
// construction this rejects spaces, NUL, control chars, backslashes, drive letters,
// and every non-ASCII unicode trick — nothing our exporter writes needs more.
const SAFE_NAME = /^[A-Za-z0-9._/-]+$/;
const WINDOWS_DRIVE = /^[A-Za-z]:/;

/**
 * Accept ONLY the tame names our exporter produces (`manifest.json`,
 * `characters/<id>.json`, `assets/<id>.png`, nested `worlds/0.hmwrld`). A tight
 * allow-list both blocks traversal tricks and keeps the reader obvious. Returns true
 * when the name is safe.
 */
export function isSafeEntryName(name: string, maxLength: number): boolean {
  if (!name || name.length > maxLength) return false;
  if (name.startsWith('/')) return false; // absolute (posix)
  if (WINDOWS_DRIVE.test(name)) return false; // absolute (windows drive)
  if (name.endsWith('/')) return false; // directory entry
  if (!SAFE_NAME.test(name)) return false; // allow-list (blocks .., backslash, NUL, spaces, unicode)
  // No empty / dot / dotdot path segments anywhere.
  for (const seg of name.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// --- writer -----------------------------------------------------------------

/**
 * Build a ZIP archive from in-memory entries. Stored (level 0) when `store` is set,
 * else DEFLATE level 6. Returns a Node Buffer.
 */
export function zipSync(entries: ZipEntryInput[]): Buffer {
  const archive: Zippable = {};
  for (const entry of entries) {
    // [bytes, options] — level 0 stores (already-compressed bytes / nested archives),
    // level 6 is a balanced deflate for JSON. (mtime is left to fflate's default; a
    // pinned 0 maps to 1970, which is below ZIP's 1980 floor and fflate rejects.)
    archive[entry.name] = [entry.data, { level: entry.store ? 0 : 6 }];
  }
  return Buffer.from(fflateZipSync(archive));
}

// --- reader -----------------------------------------------------------------

/**
 * Parse + validate an archive, returning a map of entry name -> uncompressed bytes.
 * Throws {@link ZipError} on anything malformed or that trips a security limit.
 *
 * `budget`, when supplied, is a running allowance shared with other `unzipSync`
 * calls in the same operation (the anti-amplification guard for nested archives):
 * every entry's uncompressed size is drawn down from it before that entry is
 * inflated, so the SUM of all decompression across a `.hmpack` is bounded, not just
 * each archive individually.
 */
export function unzipSync(
  buf: Buffer,
  limits: UnzipLimits = DEFAULT_UNZIP_LIMITS,
  budget?: DecompressBudget,
): Map<string, Buffer> {
  let count = 0;
  let totalBytes = 0;

  // The filter runs BEFORE fflate decompresses an entry, so every rejection here
  // happens without doing the (potentially bomb-sized) decompression work.
  const filter = (file: UnzipFileInfo): boolean => {
    if (file.name.endsWith('/')) return false; // skip directory entries (never ours)

    count += 1;
    if (count > limits.maxEntries) {
      throw new ZipError(`Archive has too many entries (> ${limits.maxEntries}).`);
    }
    if (!isSafeEntryName(file.name, limits.maxNameLength)) {
      throw new ZipError(`Unsafe or unsupported entry name ("${file.name}").`);
    }

    const size = file.originalSize;
    if (size > limits.maxEntryBytes) {
      throw new ZipError(`Entry "${file.name}" is too large (${size} > ${limits.maxEntryBytes} bytes).`);
    }
    totalBytes += size;
    if (totalBytes > limits.maxTotalBytes) {
      throw new ZipError(`Archive's total size exceeds the limit (${limits.maxTotalBytes} bytes).`);
    }
    // Shared cross-archive budget (drawn down BEFORE inflating, so a nested fan-out
    // of bombs can't multiply the per-archive cap — and we never even do the work).
    if (budget) {
      budget.remaining -= size;
      if (budget.remaining < 0) {
        throw new ZipError('Total decompressed size across the bundle exceeds the limit.');
      }
    }
    return true;
  };

  let decoded: Record<string, Uint8Array>;
  try {
    decoded = fflateUnzipSync(buf, { filter });
  } catch (e) {
    if (e instanceof ZipError) throw e; // our own limit/name rejection
    throw new ZipError(`Not a valid ZIP archive (${(e as Error).message}).`);
  }

  const out = new Map<string, Buffer>();
  for (const [name, data] of Object.entries(decoded)) {
    // Defense in depth: re-validate whatever fflate handed back.
    if (!isSafeEntryName(name, limits.maxNameLength)) {
      throw new ZipError(`Unsafe or unsupported entry name ("${name}").`);
    }
    out.set(name, Buffer.from(data));
  }
  return out;
}
