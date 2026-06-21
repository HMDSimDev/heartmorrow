import type { FastifyInstance } from 'fastify';
import { PACK_MIME, PackExportRequestSchema } from '@dsim/shared';
import { parseInput } from '../lib/validate';
import { badRequest } from '../lib/errors';
import { getCharacter } from '../services/character-service';
import { getWorld } from '../services/world-service';
import {
  exportBundlePack,
  exportCharacterPack,
  exportWorldPack,
  importPack,
  inspectPack,
  slugFilename,
} from '../services/pack-service';

/** Upload ceiling for an imported share file. Generous (worlds carry portraits) but
 *  bounded so a huge upload can't exhaust memory before the strict ZIP caps apply. */
const PACK_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

/** Read the single uploaded file as a Buffer, mapping the multipart "too large"
 *  error onto a friendly 400 instead of a 413/500. */
async function readUploadedArchive(req: import('fastify').FastifyRequest): Promise<Buffer> {
  const file = await req.file({ limits: { fileSize: PACK_MAX_UPLOAD_BYTES, files: 1 } });
  if (!file) throw badRequest('No file was uploaded.');
  try {
    return await file.toBuffer();
  } catch {
    throw badRequest('That file is too large to import (max 64 MB).');
  }
}

function sendArchive(reply: import('fastify').FastifyReply, filename: string, buffer: Buffer): Buffer {
  reply
    .header('Content-Type', PACK_MIME)
    .header('Content-Disposition', `attachment; filename="${filename}"`)
    .header('Content-Length', String(buffer.length))
    // These files are device-local content, never cache them in a shared proxy.
    .header('Cache-Control', 'no-store');
  return buffer;
}

export async function packRoutes(app: FastifyInstance): Promise<void> {
  // --- export (download a share file) ---

  // One character -> .hmchr
  app.get('/packs/character/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const character = getCharacter(id); // 404s on a bad id
    return sendArchive(reply, `${slugFilename(character.name)}.hmchr`, exportCharacterPack([id]));
  });

  // One world -> .hmwrld. `?includeCharacters=false` ships just the world (its
  // setting, locations, and authored property/company content) WITHOUT its cast.
  app.get('/packs/world/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { includeCharacters } = req.query as { includeCharacters?: string };
    const world = getWorld(id); // 404s on a bad id
    return sendArchive(
      reply,
      `${slugFilename(world.name)}.hmwrld`,
      exportWorldPack(id, { includeCharacters: !isFalsey(includeCharacters) }),
    );
  });

  // A selection (with optional title/note tweaks). The server picks the right file
  // type: one world -> .hmwrld, one loose character -> .hmchr, otherwise -> .hmpack.
  app.post('/packs/export', async (req, reply) => {
    const { worldIds, characterIds, includeCharacters, title, note } = parseInput(
      PackExportRequestSchema,
      req.body,
    );
    if (worldIds.length === 0 && characterIds.length === 0) {
      throw badRequest('Select at least one world or character to export.');
    }
    if (worldIds.length === 1 && characterIds.length === 0) {
      const world = getWorld(worldIds[0]!);
      const stem = slugFilename(title.trim() || world.name);
      return sendArchive(reply, `${stem}.hmwrld`, exportWorldPack(worldIds[0]!, { includeCharacters, title, note }));
    }
    if (worldIds.length === 0 && characterIds.length === 1) {
      const character = getCharacter(characterIds[0]!);
      const stem = slugFilename(title.trim() || character.name);
      return sendArchive(reply, `${stem}.hmchr`, exportCharacterPack([characterIds[0]!], { title, note }));
    }
    const stem = slugFilename(title.trim() || 'heartmorrow-bundle');
    return sendArchive(reply, `${stem}.hmpack`, exportBundlePack({ worldIds, characterIds, includeCharacters, title, note }));
  });

  // --- import ---

  // Read-only preview of an uploaded file (manifest + names) before committing.
  app.post('/packs/inspect', async (req) => {
    const buffer = await readUploadedArchive(req);
    return inspectPack(buffer);
  });

  // Import the file's content. ?targetWorldId scopes where loose characters land
  // (worlds are always created fresh). ?includeCharacters=false imports worlds only
  // (no cast / no loose people) — a standalone character file always imports.
  app.post('/packs/import', async (req) => {
    const { targetWorldId, includeCharacters } = req.query as {
      targetWorldId?: string;
      includeCharacters?: string;
    };
    const buffer = await readUploadedArchive(req);
    return importPack(buffer, {
      targetWorldId: targetWorldId ?? null,
      includeCharacters: !isFalsey(includeCharacters),
    });
  });
}

/** Treat only an explicit "false"/"0" query value as false; absent/anything else is true. */
function isFalsey(v: string | undefined): boolean {
  return v === 'false' || v === '0';
}
