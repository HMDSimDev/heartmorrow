import fs from 'node:fs';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  PACK_FORMAT_TAG,
  PACK_FORMAT_VERSION,
  CharacterSchema,
  CompanySchema,
  PropertySchema,
  WorldSchema,
  WorldNoteSchema,
  CharacterPackPayloadSchema,
  WorldPackPayloadSchema,
  PackManifestSchema,
  type Character,
  type Company,
  type Property,
  type PortableAsset,
  type PackManifest,
  type CharacterPackPayload,
  type WorldPackPayload,
  type PackInspectResult,
  type PackImportResult,
  type PackWorldPreview,
  type PackCharacterPreview,
} from '@dsim/shared';
import { getDb } from '../db/index';
import {
  charactersRepo,
  worldsRepo,
  worldNotesRepo,
  propertiesRepo,
  companiesRepo,
} from '../db/repositories';
import { newId } from '../lib/ids';
import { badRequest, notFound } from '../lib/errors';
import { getCharacter } from './character-service';
import { getWorld } from './world-service';
import { ensureRelationship } from './relationship-service';
import { getAsset, readAssetFile, saveUploadedAsset, safeUploadsPath } from './asset-service';
import { recordEvent } from './event-service';
import {
  zipSync,
  unzipSync,
  ZipError,
  type UnzipLimits,
  type DecompressBudget,
  type ZipEntryInput,
} from '../lib/zip';

/**
 * Share files — export/import of authored CONTENT as portable `.hmchr` / `.hmwrld` /
 * `.hmpack` archives so creators can hand characters and worlds to each other.
 *
 * What travels: DEFINITIONS only — a character's profile + portraits, a world's
 * setting/notes/cast + authored property/company content + every referenced image.
 * What never travels: relationships, money, memories, messages, day history, or any
 * other per-playthrough progress. Sharing a world is sharing the stage, not your save.
 *
 * Every id is regenerated on import and every cross-reference (links, portraits,
 * expressions, location/property/company images, a company's linked character) is
 * remapped onto the new ids, with dangling references dropped — exactly the
 * copy-as-fresh semantics of {@link cloneWorld}, but sourced from a file instead of
 * the database.
 *
 * SECURITY: the archive is untrusted. Decoding goes through the strict reader in
 * `lib/zip` (zip-bomb / traversal / symlink / encryption defenses), and image bytes
 * are MIME-allow-listed, magic-byte-sniffed, size-capped, and re-saved under
 * server-generated names (never the archive's path) via the same audited
 * {@link saveUploadedAsset} an upload uses. The whole import runs in one transaction;
 * any asset files written are unlinked if it rolls back.
 */

const GENERATOR = 'heartmorrow';
const APP_VERSION = '0.1.0';

/** Entry name of the JSON payload inside a single-unit archive, per kind. */
const PAYLOAD_FILE = { character: 'character.json', world: 'world.json' } as const;
const MANIFEST_FILE = 'manifest.json';

/** Hard caps for decoding an uploaded archive (anti resource-exhaustion). The outer
 *  file allows a larger per-entry size because a bundled `.hmwrld` is one entry. */
const IMPORT_LIMITS: UnzipLimits = {
  maxEntries: 4096,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxNameLength: 512,
};
const NESTED_LIMITS: UnzipLimits = {
  maxEntries: 4096,
  maxEntryBytes: 16 * 1024 * 1024, // a single asset is <= 8 MiB; JSON payloads are small
  maxTotalBytes: 64 * 1024 * 1024, // one nested world, fully decoded
  maxNameLength: 512,
};
/** Max nested archives honored inside a `.hmpack` (bounds the import fan-out). */
const MAX_PACK_ITEMS = 256;
/**
 * Total decompressed bytes allowed across ONE import/inspect operation. The outer
 * archive AND every nested archive draw from this single shared budget, so a
 * `.hmpack` of many small decompression bombs can't multiply the per-archive caps
 * into an out-of-memory crash. Generous for any real bundle; an adversarial fan-out
 * trips it and gets a clean 400.
 */
const GLOBAL_DECOMPRESS_BUDGET = 512 * 1024 * 1024;

const MIME_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' };

function isAllowedImageMime(mime: string): boolean {
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mime);
}

/** Confirm the bytes really are the image type they claim (magic numbers). Even a
 *  mismatched image is only ever served statically / shown to a vision model, but
 *  this turns "claims PNG, isn't" into an up-front drop rather than a silent oddity. */
function sniffImageMime(buf: Buffer): string | null {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

/** Turn a world/character name into a filesystem-safe download filename stem. */
export function slugFilename(name: string): string {
  const s = (name ?? '')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return s || 'heartmorrow';
}

// --- export -----------------------------------------------------------------

function jsonEntry(name: string, value: unknown): ZipEntryInput {
  return { name, data: Buffer.from(JSON.stringify(value, null, 2), 'utf8') };
}

function makeManifest(
  kind: PackManifest['kind'],
  fields: Partial<Omit<PackManifest, 'format' | 'formatVersion' | 'kind' | 'generator'>>,
): PackManifest {
  return PackManifestSchema.parse({
    format: PACK_FORMAT_TAG,
    formatVersion: PACK_FORMAT_VERSION,
    kind,
    generator: GENERATOR,
    appVersion: APP_VERSION,
    createdAt: Date.now(),
    ...fields,
  });
}

function collectCharacterAssetIds(chars: Character[], into = new Set<string>()): Set<string> {
  for (const c of chars) {
    if (c.portraitAssetId) into.add(c.portraitAssetId);
    for (const v of Object.values(c.expressionAssets)) if (v) into.add(v);
  }
  return into;
}

/**
 * Read every referenced asset's row + bytes and turn them into portable descriptors
 * plus the archive's binary entries. Assets that are missing, non-image, or whose
 * file is gone are simply skipped (their reference is dropped on import).
 */
function gatherAssets(ids: Set<string>): { portable: PortableAsset[]; entries: ZipEntryInput[] } {
  const portable: PortableAsset[] = [];
  const entries: ZipEntryInput[] = [];
  for (const id of ids) {
    try {
      const asset = getAsset(id);
      if (!isAllowedImageMime(asset.mimeType)) continue;
      const { buffer, mimeType } = readAssetFile(id);
      if (!isAllowedImageMime(mimeType) || buffer.byteLength === 0) continue;
      const ext = MIME_EXT[mimeType];
      const file = `assets/${id}.${ext}`;
      portable.push({
        id,
        type: asset.type,
        filename: asset.filename,
        mimeType,
        altText: asset.altText,
        tags: asset.tags,
        file,
      });
      entries.push({ name: file, data: buffer, store: true }); // images are already compressed
    } catch {
      // Missing asset row or file on disk — drop the reference, keep exporting.
    }
  }
  return { portable, entries };
}

/** Export one or more characters as a `.hmchr` archive (their `worldId` is nulled —
 *  they're portable, and bound to a world only at import). */
export function exportCharacterPack(ids: string[], opts: { title?: string; note?: string } = {}): Buffer {
  if (ids.length === 0) throw badRequest('No characters selected to export.');
  const chars = ids.map((id) => getCharacter(id)); // throws notFound on a bad id
  const { portable, entries } = gatherAssets(collectCharacterAssetIds(chars));
  const payload = CharacterPackPayloadSchema.parse({
    characters: chars.map((c) => ({ ...c, worldId: null })),
    assets: portable,
  });
  const manifest = makeManifest('character', {
    title: opts.title?.trim() || (chars.length === 1 ? chars[0]!.name : `${chars.length} characters`),
    note: opts.note?.trim() ?? '',
    counts: { worlds: 0, characters: chars.length, assets: portable.length },
  });
  return zipSync([jsonEntry(MANIFEST_FILE, manifest), jsonEntry(PAYLOAD_FILE.character, payload), ...entries]);
}

/**
 * Export a world as a `.hmwrld` archive: its definition, notes, authored
 * property/company content, and every referenced image. When `includeCharacters` is
 * true (the default) the world's whole CAST and their portraits travel too; when
 * false, only the world itself ships (its setting + locations + property/company
 * content) — a company's `linkedCharacterId` is dropped since the character isn't
 * coming along.
 */
export function exportWorldPack(
  worldId: string,
  opts: { includeCharacters?: boolean; title?: string; note?: string } = {},
): Buffer {
  const includeCharacters = opts.includeCharacters ?? true;
  const world = getWorld(worldId);
  const worldNotes = worldNotesRepo.listByWorld(worldId);
  const characters = includeCharacters ? charactersRepo.listByWorld(worldId) : [];
  const properties = propertiesRepo.listByWorld(worldId);
  // Without the cast, a company can't reference a character that didn't travel.
  const companies = companiesRepo
    .listByWorld(worldId)
    .map((c) => (includeCharacters ? c : { ...c, linkedCharacterId: null }));

  const ids = collectCharacterAssetIds(characters); // empty when characters excluded
  for (const loc of world.locations) if (loc.imageAssetId) ids.add(loc.imageAssetId);
  for (const p of properties) if (p.assetId) ids.add(p.assetId);
  for (const c of companies) if (c.assetId) ids.add(c.assetId);
  const { portable, entries } = gatherAssets(ids);

  const payload = WorldPackPayloadSchema.parse({
    world,
    worldNotes,
    characters,
    properties,
    companies,
    assets: portable,
  });
  const manifest = makeManifest('world', {
    title: opts.title?.trim() || world.name,
    summary: world.summary,
    note: opts.note?.trim() ?? '',
    counts: { worlds: 1, characters: characters.length, assets: portable.length },
  });
  return zipSync([jsonEntry(MANIFEST_FILE, manifest), jsonEntry(PAYLOAD_FILE.world, payload), ...entries]);
}

/**
 * Export an arbitrary SELECTION (multiple worlds, and/or a set of loose characters)
 * as a `.hmpack` — a ZIP of nested `.hmwrld` / `.hmchr` files plus a manifest listing
 * them. Each selected world is its own nested `.hmwrld`; all selected loose characters
 * become a single nested `.hmchr`.
 */
export function exportBundlePack(input: {
  worldIds: string[];
  characterIds: string[];
  includeCharacters?: boolean;
  title?: string;
  note?: string;
}): Buffer {
  const includeCharacters = input.includeCharacters ?? true;
  const worldIds = [...new Set(input.worldIds)];
  const characterIds = [...new Set(input.characterIds)];
  if (worldIds.length === 0 && characterIds.length === 0) {
    throw badRequest('Nothing selected to export.');
  }
  const entries: ZipEntryInput[] = [];
  const items: PackManifest['items'] = [];
  // Collect the referenced asset ids across every nested pack so the manifest can
  // report a real (deduped) image count. Mirrors the collection each child exporter
  // does; without this `counts.assets` was hard-coded to 0 and the pre-import preview
  // reported no images even for packs full of portraits.
  const assetIds = new Set<string>();

  worldIds.forEach((wid, i) => {
    const world = getWorld(wid);
    const file = `worlds/${i}.hmwrld`;
    entries.push({ name: file, data: exportWorldPack(wid, { includeCharacters }), store: true });
    items.push({ kind: 'world', file, title: world.name });
    const worldChars = includeCharacters ? charactersRepo.listByWorld(wid) : [];
    for (const id of collectCharacterAssetIds(worldChars)) assetIds.add(id);
    for (const loc of world.locations) if (loc.imageAssetId) assetIds.add(loc.imageAssetId);
    for (const p of propertiesRepo.listByWorld(wid)) if (p.assetId) assetIds.add(p.assetId);
    for (const c of companiesRepo.listByWorld(wid)) if (c.assetId) assetIds.add(c.assetId);
  });
  if (characterIds.length > 0) {
    const file = 'characters/0.hmchr';
    entries.push({ name: file, data: exportCharacterPack(characterIds), store: true });
    items.push({ kind: 'character', file, title: `${characterIds.length} characters` });
    for (const id of collectCharacterAssetIds(characterIds.map((id) => getCharacter(id)))) assetIds.add(id);
  }

  // Count only assets that actually resolve to stored bytes (what gets shipped),
  // deduped across the whole bundle.
  const assetTotal = gatherAssets(assetIds).portable.length;

  const manifest = makeManifest('pack', {
    title: input.title?.trim() || 'Heartmorrow bundle',
    note: input.note?.trim() ?? '',
    counts: { worlds: worldIds.length, characters: characterIds.length, assets: assetTotal },
    items,
  });
  return zipSync([jsonEntry(MANIFEST_FILE, manifest), ...entries]);
}

// --- decode helpers (no side effects) ---------------------------------------

function safeUnzip(buf: Buffer, limits: UnzipLimits, budget?: DecompressBudget): Map<string, Buffer> {
  try {
    return unzipSync(buf, limits, budget);
  } catch (e) {
    if (e instanceof ZipError) throw badRequest(e.message);
    throw e;
  }
}

function readJson(map: Map<string, Buffer>, name: string): unknown {
  const buf = map.get(name);
  if (!buf) throw badRequest(`This isn't a valid Heartmorrow share file (missing "${name}").`);
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw badRequest(`The share file has invalid JSON in "${name}".`);
  }
}

function parseManifest(map: Map<string, Buffer>): PackManifest {
  const parsed = PackManifestSchema.safeParse(readJson(map, MANIFEST_FILE));
  if (!parsed.success) throw badRequest('The share file has an invalid manifest.');
  if (parsed.data.format !== PACK_FORMAT_TAG) {
    throw badRequest('This file is not a Heartmorrow share file.');
  }
  return parsed.data;
}

function parseCharacterPayload(map: Map<string, Buffer>): CharacterPackPayload {
  const parsed = CharacterPackPayloadSchema.safeParse(readJson(map, PAYLOAD_FILE.character));
  if (!parsed.success) throw badRequest('The character data in this share file is invalid or corrupt.');
  return parsed.data;
}

function parseWorldPayload(map: Map<string, Buffer>): WorldPackPayload {
  const parsed = WorldPackPayloadSchema.safeParse(readJson(map, PAYLOAD_FILE.world));
  if (!parsed.success) throw badRequest('The world data in this share file is invalid or corrupt.');
  return parsed.data;
}

/** The nested `.hmchr`/`.hmwrld` files to import from a `.hmpack`: the manifest's
 *  listed items, plus any matching entries actually present (deduped, capped). */
function nestedFiles(root: Map<string, Buffer>, manifest: PackManifest): string[] {
  const files = new Set<string>();
  for (const it of manifest.items) files.add(it.file);
  for (const name of root.keys()) {
    if (name.endsWith('.hmchr') || name.endsWith('.hmwrld')) files.add(name);
  }
  return [...files].slice(0, MAX_PACK_ITEMS);
}

// --- import (mutating) ------------------------------------------------------

/**
 * Write each portable image to the uploads dir under a FRESH server-generated name
 * (via the audited {@link saveUploadedAsset}) and return an old-id -> new-id map for
 * remapping references. Images that are absent, non-image, oversized, or whose bytes
 * don't match their declared type are dropped. Written file paths are appended to
 * `written` so the caller can unlink them if the surrounding transaction rolls back.
 */
function materializeAssets(
  assets: PortableAsset[],
  entries: Map<string, Buffer>,
  written: string[],
): { idMap: Map<string, string>; skipped: number } {
  const idMap = new Map<string, string>();
  let skipped = 0;
  for (const pa of assets) {
    const bytes = entries.get(pa.file);
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_UPLOAD_BYTES) {
      skipped += 1;
      continue;
    }
    if (!isAllowedImageMime(pa.mimeType) || sniffImageMime(bytes) !== pa.mimeType) {
      skipped += 1;
      continue;
    }
    const asset = saveUploadedAsset({
      buffer: bytes,
      originalFilename: pa.filename,
      mimeType: pa.mimeType,
      type: pa.type,
      altText: pa.altText,
      tags: pa.tags,
    });
    written.push(safeUploadsPath(asset.path));
    idMap.set(pa.id, asset.id);
  }
  return { idMap, skipped };
}

const mapId = (id: string | null, idMap: Map<string, string>): string | null =>
  id && idMap.has(id) ? idMap.get(id)! : null;

/**
 * Insert a set of character DEFINITIONS as fresh characters in `targetWorldId`,
 * mirroring {@link cloneCharactersToWorld}: new ids, a clean relationship each, intra
 * set links remapped (links outside the set dropped), and asset references remapped
 * onto the freshly-imported images. Returns the new ids and the old->new id map.
 */
function importCharacterDefs(
  defs: Character[],
  targetWorldId: string | null,
  assetIdMap: Map<string, string>,
): { ids: string[]; idMap: Map<string, string> } {
  const now = Date.now();
  const idMap = new Map<string, string>();

  // Pass 1: insert each with links stripped + assets remapped, recording old->new ids.
  const created = defs.map((src) => {
    const cloneId = newId('char');
    idMap.set(src.id, cloneId);
    const expressionAssets: Record<string, string> = {};
    for (const [label, assetId] of Object.entries(src.expressionAssets)) {
      const mapped = mapId(assetId, assetIdMap);
      if (mapped) expressionAssets[label] = mapped;
    }
    const copy = CharacterSchema.parse({
      ...src,
      id: cloneId,
      worldId: targetWorldId,
      links: [],
      portraitAssetId: mapId(src.portraitAssetId, assetIdMap),
      expressionAssets,
      createdAt: now,
      updatedAt: now,
    });
    charactersRepo.insert(copy);
    ensureRelationship(cloneId);
    return { src, cloneId };
  });

  // Pass 2: remap links that point WITHIN the imported set onto the new ids.
  for (const { src, cloneId } of created) {
    const links = src.links
      .filter((l) => idMap.has(l.targetId))
      .map((l) => ({ ...l, targetId: idMap.get(l.targetId)! }));
    if (links.length === 0) continue;
    const cur = charactersRepo.get(cloneId)!;
    charactersRepo.update(CharacterSchema.parse({ ...cur, links, updatedAt: Date.now() }));
  }

  return { ids: created.map((c) => c.cloneId), idMap };
}

/** Insert a world payload as a brand-new world: world + notes + cast + authored
 *  property/company content, all with fresh ids and references remapped. */
function importWorldPayload(
  payload: WorldPackPayload,
  assetIdMap: Map<string, string>,
  includeCharacters: boolean,
): { worldId: string; characterIds: string[] } {
  const now = Date.now();
  const newWorldId = newId('world');

  const locations = payload.world.locations.map((loc) => ({
    ...loc,
    imageAssetId: mapId(loc.imageAssetId, assetIdMap),
  }));
  worldsRepo.insert(
    WorldSchema.parse({ ...payload.world, id: newWorldId, locations, createdAt: now, updatedAt: now }),
  );

  for (const n of payload.worldNotes) {
    worldNotesRepo.insert(
      WorldNoteSchema.parse({ ...n, id: newId('note'), worldId: newWorldId, createdAt: now, updatedAt: now }),
    );
  }

  // Skip the cast entirely when the importer asked for "just the world". A company's
  // linkedCharacterId then resolves to null (the character isn't in this world).
  const cast = includeCharacters ? payload.characters : [];
  const { ids: characterIds, idMap: charIdMap } = importCharacterDefs(cast, newWorldId, assetIdMap);

  for (const p of payload.properties as Property[]) {
    propertiesRepo.insert(
      PropertySchema.parse({
        ...p,
        id: newId('prop'),
        worldId: newWorldId,
        assetId: mapId(p.assetId, assetIdMap),
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
  for (const c of payload.companies as Company[]) {
    companiesRepo.insert(
      CompanySchema.parse({
        ...c,
        id: newId('company'),
        worldId: newWorldId,
        assetId: mapId(c.assetId, assetIdMap),
        linkedCharacterId: mapId(c.linkedCharacterId, charIdMap),
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  return { worldId: newWorldId, characterIds };
}

/**
 * Read a share file's manifest + names WITHOUT importing — a safe preview the UI
 * shows before the user commits. Fully decodes (so it validates the archive), but
 * touches neither the database nor the disk.
 */
export function inspectPack(buffer: Buffer): PackInspectResult {
  // One shared decompression budget for the outer archive AND every nested archive,
  // so previewing a malicious `.hmpack` can't be turned into a CPU/memory bomb.
  const budget: DecompressBudget = { remaining: GLOBAL_DECOMPRESS_BUDGET };
  const root = safeUnzip(buffer, IMPORT_LIMITS, budget);
  const manifest = parseManifest(root);
  const warnings: string[] = [];
  if (manifest.formatVersion > PACK_FORMAT_VERSION) {
    warnings.push(`Made by a newer version (format v${manifest.formatVersion}); unknown details will be ignored.`);
  }
  const worlds: PackWorldPreview[] = [];
  const characters: PackCharacterPreview[] = [];

  const charPreview = (
    c: WorldPackPayload['characters'][number],
    world: string | null,
    assets: WorldPackPayload['assets'],
  ): PackCharacterPreview => ({
    name: c.name,
    age: c.age,
    pronouns: c.pronouns,
    shortDescription: c.shortDescription,
    hasPortrait: !!c.portraitAssetId && assets.some((a) => a.id === c.portraitAssetId),
    world,
  });

  const addWorld = (p: WorldPackPayload): void => {
    worlds.push({
      name: p.world.name,
      summary: p.world.summary,
      tone: p.world.tone,
      locations: p.world.locations.map((l) => l.name),
      characterCount: p.characters.length,
      propertyCount: p.properties.length,
      companyCount: p.companies.length,
    });
    for (const c of p.characters) characters.push(charPreview(c, p.world.name, p.assets));
  };
  const addLooseCharacters = (p: CharacterPackPayload): void => {
    for (const c of p.characters) characters.push(charPreview(c, null, p.assets));
  };

  if (manifest.kind === 'character') {
    addLooseCharacters(parseCharacterPayload(root));
  } else if (manifest.kind === 'world') {
    addWorld(parseWorldPayload(root));
  } else {
    for (const file of nestedFiles(root, manifest)) {
      const nestedBuf = root.get(file);
      if (!nestedBuf) continue;
      // `nested` is scoped to this iteration → GC-eligible before the next archive,
      // so peak memory is one nested archive, not all of them.
      const nested = safeUnzip(nestedBuf, NESTED_LIMITS, budget);
      const nm = parseManifest(nested);
      if (nm.kind === 'character') addLooseCharacters(parseCharacterPayload(nested));
      else if (nm.kind === 'world') addWorld(parseWorldPayload(nested));
      else warnings.push(`Skipped nested bundle "${file}" (a pack can't contain another pack).`);
    }
  }

  return {
    kind: manifest.kind,
    title: manifest.title,
    summary: manifest.summary,
    note: manifest.note,
    formatVersion: manifest.formatVersion,
    createdAt: manifest.createdAt,
    counts: manifest.counts,
    worlds,
    characters,
    warnings,
  };
}

/** Materialize one character payload's assets + characters into the open transaction,
 *  accumulating into `result`. */
function applyCharacterUnit(
  payload: CharacterPackPayload,
  entries: Map<string, Buffer>,
  targetWorldId: string | null,
  written: string[],
  result: PackImportResult,
): void {
  const { idMap, skipped } = materializeAssets(payload.assets, entries, written);
  result.assets += idMap.size;
  result.skippedAssets += skipped;
  const { ids } = importCharacterDefs(payload.characters, targetWorldId, idMap);
  result.characters += ids.length;
  result.characterIds.push(...ids);
}

/** Asset ids the WORLD itself references (location / property / company images) —
 *  i.e. everything except character portraits/expressions. */
function worldOwnAssetIds(payload: WorldPackPayload): Set<string> {
  const ids = new Set<string>();
  for (const loc of payload.world.locations) if (loc.imageAssetId) ids.add(loc.imageAssetId);
  for (const p of payload.properties) if (p.assetId) ids.add(p.assetId);
  for (const c of payload.companies) if (c.assetId) ids.add(c.assetId);
  return ids;
}

/** Materialize one world payload (world + content + optionally its cast) into the
 *  open transaction, accumulating into `result`. When `includeCharacters` is false,
 *  only the world's own images are materialized (not character portraits). */
function applyWorldUnit(
  payload: WorldPackPayload,
  entries: Map<string, Buffer>,
  written: string[],
  result: PackImportResult,
  includeCharacters: boolean,
): void {
  // Without the cast, don't materialize their portraits — only the world's own images.
  const assets = includeCharacters
    ? payload.assets
    : payload.assets.filter((a) => worldOwnAssetIds(payload).has(a.id));
  const { idMap, skipped } = materializeAssets(assets, entries, written);
  result.assets += idMap.size;
  result.skippedAssets += skipped;
  const { worldId, characterIds } = importWorldPayload(payload, idMap, includeCharacters);
  result.worlds += 1;
  result.worldIds.push(worldId);
  result.characters += characterIds.length;
  result.characterIds.push(...characterIds);
}

/**
 * Import a share file's content into the database (additive — never destructive).
 * Loose characters land in `targetWorldId` if given (else world-less); worlds are
 * always created fresh. Runs in one transaction; any asset files written are removed
 * if it fails, so a partial import never leaks orphaned uploads.
 *
 * A `.hmpack`'s nested archives are decoded AND applied one at a time, so peak memory
 * is a single nested archive rather than all of them, and they all draw from one
 * shared decompression budget — the anti-amplification guard for a bundle of bombs.
 */
export function importPack(
  buffer: Buffer,
  opts: { targetWorldId?: string | null; includeCharacters?: boolean } = {},
): PackImportResult {
  const targetWorldId = opts.targetWorldId ?? null;
  // Default true. Scopes to characters that travel WITH a world (a world's cast and
  // any loose-character units inside a pack); a standalone .hmchr always imports.
  const includeCharacters = opts.includeCharacters ?? true;
  if (targetWorldId) getWorld(targetWorldId); // validate the destination up front

  const budget: DecompressBudget = { remaining: GLOBAL_DECOMPRESS_BUDGET };
  const root = safeUnzip(buffer, IMPORT_LIMITS, budget);
  const manifest = parseManifest(root);
  const warnings: string[] = [];
  if (manifest.formatVersion > PACK_FORMAT_VERSION) {
    warnings.push(`Made by a newer version (format v${manifest.formatVersion}); unknown details were ignored.`);
  }

  const written: string[] = [];
  const result: PackImportResult = {
    kind: manifest.kind,
    worlds: 0,
    characters: 0,
    assets: 0,
    worldIds: [],
    characterIds: [],
    skippedAssets: 0,
    warnings,
  };

  try {
    getDb().transaction(() => {
      if (manifest.kind === 'character') {
        // A standalone character file IS characters — the world-scoped toggle doesn't apply.
        applyCharacterUnit(parseCharacterPayload(root), root, targetWorldId, written, result);
      } else if (manifest.kind === 'world') {
        applyWorldUnit(parseWorldPayload(root), root, written, result, includeCharacters);
      } else {
        let imported = 0;
        for (const file of nestedFiles(root, manifest)) {
          const nestedBuf = root.get(file);
          if (!nestedBuf) {
            warnings.push(`Missing nested file "${file}".`);
            continue;
          }
          // Decode + apply this nested archive, then drop it: the next iteration
          // rebinds `nested`, so only one nested archive's bytes are ever resident.
          const nested = safeUnzip(nestedBuf, NESTED_LIMITS, budget);
          const nm = parseManifest(nested);
          if (nm.kind === 'character') {
            // Loose people in a bundle travel with the worlds — skip them on "just the worlds".
            if (!includeCharacters) {
              warnings.push(`Skipped the people in "${file}" (importing worlds only).`);
              continue;
            }
            applyCharacterUnit(parseCharacterPayload(nested), nested, targetWorldId, written, result);
            imported += 1;
          } else if (nm.kind === 'world') {
            applyWorldUnit(parseWorldPayload(nested), nested, written, result, includeCharacters);
            imported += 1;
          } else {
            warnings.push(`Skipped nested bundle "${file}" (a pack can't contain another pack).`);
          }
        }
        if (imported === 0) throw badRequest('The share file contained nothing importable.');
      }
    });
  } catch (e) {
    // The DB transaction rolled back; unlink any asset files it left behind so a
    // failed import never leaks orphaned uploads.
    for (const p of written) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* best effort */
      }
    }
    throw e;
  }

  recordEvent('pack_imported', {
    kind: manifest.kind,
    worlds: result.worlds,
    characters: result.characters,
    assets: result.assets,
  });
  return result;
}

/** Resolve a notFound for a missing world/character into the export's error surface. */
export function assertExportable(kind: 'world' | 'character', id: string): void {
  if (kind === 'world') getWorld(id);
  else if (!charactersRepo.get(id)) throw notFound(`Character ${id} not found.`);
}
