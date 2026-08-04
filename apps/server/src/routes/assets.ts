import type { FastifyInstance } from 'fastify';
import { AssetUpdateSchema, AssetUploadFieldsSchema } from '@dsim/shared';
import { parseInput } from '../lib/validate';
import { badRequest } from '../lib/errors';
import {
  dedupeOrSaveAsset,
  deleteAsset,
  getAssetUsages,
  listAssets,
  rebuildThumbnails,
  replaceAssetFile,
  updateAsset,
} from '../services/asset-service';
import { docSchema } from '../lib/openapi-schema';

export async function assetRoutes(app: FastifyInstance): Promise<void> {
  app.get('/assets', { schema: docSchema({ tags: ['assets'], summary: 'List uploaded assets' }) }, async () => listAssets());

  app.get(
    '/assets/usage',
    {
      schema: docSchema({
        tags: ['assets'],
        summary: 'Map of asset id -> everywhere it is referenced (unreferenced assets are absent)',
      }),
    },
    async () => getAssetUsages(),
  );

  app.post(
    '/assets/thumbnails/rebuild',
    {
      schema: docSchema({
        tags: ['assets'],
        summary: 'Generate any missing thumbnails for existing assets',
      }),
    },
    async () => rebuildThumbnails(),
  );

  app.post('/assets', { schema: docSchema({ tags: ['assets'], summary: 'Upload an asset file' }) }, async (req, reply) => {
    let buffer: Buffer | null = null;
    let filename = 'upload';
    let mimeType = '';
    const fields: Record<string, string> = {};

    for await (const part of req.parts()) {
      if (part.type === 'file') {
        filename = part.filename || 'upload';
        mimeType = part.mimetype;
        buffer = await part.toBuffer();
      } else {
        fields[part.fieldname] = String(part.value ?? '');
      }
    }

    if (!buffer) throw badRequest('No file field found in the upload.');
    const parsed = parseInput(AssetUploadFieldsSchema, fields);
    const tags = parsed.tags
      ? parsed.tags.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    // Byte-identical re-uploads reuse the existing asset (with tags merged in)
    // instead of storing a duplicate; the client treats both shapes the same.
    const { asset, deduped } = dedupeOrSaveAsset({
      buffer,
      originalFilename: filename,
      mimeType,
      type: parsed.type,
      altText: parsed.altText,
      tags,
    });
    reply.code(deduped ? 200 : 201);
    return asset;
  });

  app.post(
    '/assets/:id/file',
    {
      schema: docSchema({
        tags: ['assets'],
        summary:
          'Replace an asset\'s image in place — same id, so every reference shows the new picture',
      }),
    },
    async (req) => {
      const { id } = req.params as { id: string };
      let buffer: Buffer | null = null;
      let mimeType = '';
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          mimeType = part.mimetype;
          buffer = await part.toBuffer();
        }
      }
      if (!buffer) throw badRequest('No file field found in the upload.');
      return replaceAssetFile(id, { buffer, mimeType });
    },
  );

  app.patch(
    '/assets/:id',
    {
      schema: docSchema({
        tags: ['assets'],
        summary: 'Update an asset\'s display metadata (filename, alt text, tags, type)',
        body: AssetUpdateSchema,
      }),
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const patch = parseInput(AssetUpdateSchema, req.body ?? {});
      return updateAsset(id, patch);
    },
  );

  app.delete('/assets/:id', { schema: docSchema({ tags: ['assets'], summary: 'Delete an asset by id' }) }, async (req) => {
    const { id } = req.params as { id: string };
    deleteAsset(id);
    return { ok: true };
  });
}
