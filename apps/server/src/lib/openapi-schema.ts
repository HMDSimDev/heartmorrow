import { z, type ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { FastifySchema } from 'fastify';

/**
 * Build a Fastify route `schema` from the existing @dsim/shared Zod schemas so
 * `@fastify/swagger` can emit OpenAPI for the route.
 *
 * IMPORTANT: attaching `schema.body`/`querystring` makes Fastify's AJV validate
 * the request at runtime. To keep this purely additive — i.e. never reject a
 * request that the in-handler `parseInput()` would have accepted — the generated
 * JSON Schema is RELAXED:
 *   - `additionalProperties: false` is dropped (so AJV neither rejects nor strips
 *     extra fields; matches Zod's default "strip" behaviour),
 *   - `format` is dropped (so Fastify's AJV never fails to compile on a format it
 *     doesn't know, e.g. `email`/`uri`/`date-time`),
 *   - the `$schema` marker is dropped.
 * `parseInput()` remains the authoritative validator (and applies Zod
 * defaults/transforms). Response schemas are intentionally never attached so
 * fast-json-stringify never strips response fields.
 */

type JsonRecord = Record<string, unknown>;

/** Recursively relax a generated JSON Schema so AJV stays a permissive superset. */
function relax(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) relax(item);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as JsonRecord;
    delete obj.$schema;
    delete obj.format;
    // `parseInput()` is the authoritative validator and applies Zod defaults;
    // the attached schema is documentation/relaxation only. A `default` keyword
    // left in the generated JSON Schema trips Fastify's AJV strict mode
    // ("default is ignored for: …") when it sits somewhere AJV won't apply it,
    // so drop it everywhere — it never has runtime meaning here.
    delete obj.default;
    if (obj.additionalProperties === false) delete obj.additionalProperties;
    // `zod-to-json-schema`'s openApi3 target emits the draft-04 boolean form of
    // `exclusiveMinimum`/`exclusiveMaximum` (a boolean paired with `minimum`/
    // `maximum`), but Fastify's AJV is draft-2020-12 where these MUST be numbers.
    // A boolean there fails schema compilation ("exclusiveMinimum must be number").
    // Normalise to the numeric form so the schema compiles either way.
    for (const [bound, incl] of [
      ['exclusiveMinimum', 'minimum'],
      ['exclusiveMaximum', 'maximum'],
    ] as const) {
      if (typeof obj[bound] === 'boolean') {
        if (obj[bound] === true && typeof obj[incl] === 'number') {
          obj[bound] = obj[incl];
          delete obj[incl];
        } else {
          delete obj[bound];
        }
      }
    }
    for (const value of Object.values(obj)) relax(value);
  }
}

function toJson(schema: ZodTypeAny): JsonRecord {
  const json = zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' }) as JsonRecord;
  relax(json);
  return json;
}

export interface DocSchemaOptions {
  tags?: string[];
  summary?: string;
  description?: string;
  body?: ZodTypeAny;
  querystring?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Documentation-oriented Fastify route schema built from Zod schemas. The
 * non-validating doc keys (`tags`/`summary`/`description`) are assembled on a
 * plain object and cast, so we don't need to pull in `@fastify/swagger`'s type
 * augmentation at runtime in every route module.
 */
export function docSchema(opts: DocSchemaOptions): FastifySchema {
  const schema: JsonRecord = {};
  if (opts.tags) schema.tags = opts.tags;
  if (opts.summary) schema.summary = opts.summary;
  if (opts.description) schema.description = opts.description;
  if (opts.body) schema.body = toJson(opts.body);
  if (opts.querystring) schema.querystring = toJson(opts.querystring);
  if (opts.params) schema.params = toJson(opts.params);
  return schema as FastifySchema;
}

/**
 * The ubiquitous per-world query parameter. Kept OPTIONAL on purpose: many
 * handlers fall back to a legacy/default world when `worldId` is absent, so
 * marking it required here would break that fallback.
 */
export const WorldScopedQuerySchema = z.object({ worldId: z.string().optional() });
