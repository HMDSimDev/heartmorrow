import type { FastifyInstance } from 'fastify';
import { AssetUploadFieldsSchema } from '@dsim/shared';
import { parseInput } from '../lib/validate';
import { badRequest } from '../lib/errors';
import { deleteAsset, listAssets, saveUploadedAsset } from '../services/asset-service';
import { docSchema } from '../lib/openapi-schema';

export async function assetRoutes(app: FastifyInstance): Promise<void> {
  app.get('/assets', { schema: docSchema({ tags: ['assets'], summary: 'List uploaded assets' }) }, async () => listAssets());

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

    reply.code(201);
    return saveUploadedAsset({
      buffer,
      originalFilename: filename,
      mimeType,
      type: parsed.type,
      altText: parsed.altText,
      tags,
    });
  });

  app.delete('/assets/:id', { schema: docSchema({ tags: ['assets'], summary: 'Delete an asset by id' }) }, async (req) => {
    const { id } = req.params as { id: string };
    deleteAsset(id);
    return { ok: true };
  });
}
