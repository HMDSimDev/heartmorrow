import { z } from 'zod';
import {
  AssetTypeSchema,
  CharacterSchema,
  CompanySchema,
  PropertySchema,
  WorldSchema,
  WorldNoteSchema,
} from './entities';

/**
 * Share files — portable, asset-bearing bundles people can hand to each other to
 * share authored CONTENT (characters, worlds, or any mix), independent of a save.
 *
 * Three container types, all ordinary ZIP archives that differ only by what they
 * carry (and by file extension so a double-click is unambiguous):
 *   - `.hmchr`  — one or more characters + their portrait/expression images.
 *   - `.hmwrld` — a world: its definition, notes, cast, authored property/company
 *                 content, and every image any of those reference.
 *   - `.hmpack` — a ZIP of nested `.hmchr`/`.hmwrld` files + a top-level manifest;
 *                 the way to share more than one world, or worlds + loose people.
 *
 * Each archive holds a `manifest.json` (this file's {@link PackManifestSchema}), one
 * or more JSON payloads validated by the canonical entity schemas, and the raw image
 * bytes under `assets/`. Because every entity schema defaults each field, an OLD file
 * imported by a NEW build gains the new fields' defaults, and a NEW file imported by
 * an OLD build simply drops fields it doesn't know — the format is forward- AND
 * backward-compatible by construction. `formatVersion` rides along for future
 * migrations but import treats a higher version as a best-effort, not a hard stop.
 *
 * SCOPE: authored DEFINITIONS only. No relationships, money, memories, messages, or
 * any per-playthrough progress is ever exported — sharing a character/world hands
 * over the content, never your save.
 */

/** Bumped only when the on-disk archive LAYOUT changes incompatibly (not when a
 *  field is added to an entity — those are absorbed by schema defaults). */
export const PACK_FORMAT_VERSION = 1;

/** The magic string stamped in every manifest's `format` field (sniff/validation). */
export const PACK_FORMAT_TAG = 'heartmorrow-pack';

export const PackKindSchema = z.enum(['character', 'world', 'pack']);
export type PackKind = z.infer<typeof PackKindSchema>;

/** File extension (no dot) for each kind of share file. */
export const PACK_EXT: Record<PackKind, string> = {
  character: 'hmchr',
  world: 'hmwrld',
  pack: 'hmpack',
};

/** Custom MIME used on download (browsers treat it as a binary attachment). */
export const PACK_MIME = 'application/zip';

/**
 * One image carried inside an archive. This is the Asset row MINUS its server-only
 * on-disk `path` (which is meaningless on another machine): the bytes live at the
 * archive entry named by `file`, and on import are re-saved under a fresh,
 * server-generated name. `id` is the EXPORT-TIME asset id, used purely to remap the
 * references that point at it (portraits, expressions, location/property/company
 * images) onto the new ids minted at import.
 */
export const PortableAssetSchema = z.object({
  id: z.string().min(1),
  type: AssetTypeSchema.default('other'),
  filename: z.string().default('image'),
  mimeType: z.string().min(1),
  altText: z.string().default(''),
  tags: z.array(z.string()).default([]),
  /** Archive-relative entry path holding the raw bytes, e.g. `assets/<id>.png`. */
  file: z.string().min(1),
});
export type PortableAsset = z.infer<typeof PortableAssetSchema>;

/** Payload of a `.hmchr` (the JSON next to the `assets/` bytes). Characters carry a
 *  null `worldId` — they're portable, and bound to a world only at import time. */
export const CharacterPackPayloadSchema = z.object({
  characters: z.array(CharacterSchema).default([]),
  assets: z.array(PortableAssetSchema).default([]),
});
export type CharacterPackPayload = z.infer<typeof CharacterPackPayloadSchema>;

/** Payload of a `.hmwrld`: the world definition and everything authored that belongs
 *  to it. Playthrough state (ownership/leases/holdings/prices/news/relationships) is
 *  deliberately excluded — only the authored content travels. */
export const WorldPackPayloadSchema = z.object({
  world: WorldSchema,
  worldNotes: z.array(WorldNoteSchema).default([]),
  characters: z.array(CharacterSchema).default([]),
  properties: z.array(PropertySchema).default([]),
  companies: z.array(CompanySchema).default([]),
  assets: z.array(PortableAssetSchema).default([]),
});
export type WorldPackPayload = z.infer<typeof WorldPackPayloadSchema>;

/** A nested archive listed in a `.hmpack` manifest (one `.hmchr`/`.hmwrld` entry). */
export const PackItemSchema = z.object({
  kind: PackKindSchema,
  /** Archive-relative path of the nested `.hmchr`/`.hmwrld`. */
  file: z.string().min(1),
  title: z.string().default(''),
});
export type PackItem = z.infer<typeof PackItemSchema>;

export const PackCountsSchema = z.object({
  worlds: z.number().int().nonnegative().default(0),
  characters: z.number().int().nonnegative().default(0),
  assets: z.number().int().nonnegative().default(0),
});
export type PackCounts = z.infer<typeof PackCountsSchema>;

/**
 * The `manifest.json` at the root of every archive. The `kind` + `format` are the
 * authoritative dispatch on import (the file extension is only a hint). Everything
 * here is descriptive — counts and titles for a friendly pre-import preview.
 */
export const PackManifestSchema = z.object({
  format: z.string().default(PACK_FORMAT_TAG),
  formatVersion: z.number().int().positive().default(PACK_FORMAT_VERSION),
  kind: PackKindSchema,
  generator: z.string().default('heartmorrow'),
  appVersion: z.string().default(''),
  title: z.string().default(''),
  summary: z.string().default(''),
  /** An optional free-text note from whoever exported it (shown on import). */
  note: z.string().default(''),
  /** Epoch ms the file was created (0 = unknown). */
  createdAt: z.number().int().nonnegative().default(0),
  counts: PackCountsSchema.default({}),
  /** Only for `kind: 'pack'` — the nested `.hmchr`/`.hmwrld` files it contains. */
  items: z.array(PackItemSchema).default([]),
});
export type PackManifest = z.infer<typeof PackManifestSchema>;

/** Body of `POST /packs/export` — the selection to bundle into a `.hmpack`. When
 *  `includeCharacters` is false, each selected world ships WITHOUT its cast (just the
 *  world: setting, notes, locations, and authored property/company content). */
export const PackExportRequestSchema = z.object({
  worldIds: z.array(z.string().min(1)).default([]),
  characterIds: z.array(z.string().min(1)).default([]),
  includeCharacters: z.boolean().default(true),
  /** Optional creator-set title + note stamped into the file's manifest. */
  title: z.string().max(120).default(''),
  note: z.string().max(2000).default(''),
});
export type PackExportRequest = z.infer<typeof PackExportRequestSchema>;

/** A world as previewed (read-only) from a share file before import. */
export interface PackWorldPreview {
  name: string;
  summary: string;
  tone: string;
  /** Location names in the world (for the preview list). */
  locations: string[];
  characterCount: number;
  propertyCount: number;
  companyCount: number;
}

/** A character as previewed (read-only) from a share file before import. */
export interface PackCharacterPreview {
  name: string;
  age: number;
  pronouns: string;
  shortDescription: string;
  /** Whether this person carries a portrait image in the file. */
  hasPortrait: boolean;
  /** The world they belong to in the file, or null for a loose character. */
  world: string | null;
}

/** What `POST /packs/inspect` returns — a safe, read-only, RICH preview of a share
 *  file (manifest + structured details of every world and person inside) so the UI
 *  can show what's in it and let the user tweak before importing. */
export interface PackInspectResult {
  kind: PackKind;
  title: string;
  summary: string;
  /** The exporter's free-text note, if any. */
  note: string;
  formatVersion: number;
  createdAt: number;
  counts: PackCounts;
  worlds: PackWorldPreview[];
  characters: PackCharacterPreview[];
  /** Non-fatal notices (e.g. "made by a newer version" or dropped images). */
  warnings: string[];
}

/** What `POST /packs/import` returns — a summary of what landed in the database. */
export interface PackImportResult {
  kind: PackKind;
  worlds: number;
  characters: number;
  assets: number;
  /** Ids of the worlds/characters created (the client can jump straight to them). */
  worldIds: string[];
  characterIds: string[];
  /** Images that were referenced but not present / failed validation, so were dropped. */
  skippedAssets: number;
  warnings: string[];
}
