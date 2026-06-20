import { z } from 'zod';
import { badRequest } from './errors';

/** Validate input against a schema, throwing a 400 AppError on failure. */
export function parseInput<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest('Validation failed.', result.error.flatten());
  }
  return result.data;
}
