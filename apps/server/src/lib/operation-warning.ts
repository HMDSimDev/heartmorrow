import type { OperationWarning } from '@dsim/shared';
import { recordEvent } from '../services/event-service';

function failureText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export function reportOperationFailure(code: string, message: string, error: unknown, context: Record<string, unknown> = {}): OperationWarning {
  const detail = failureText(error);
  console.warn(`[operation-warning] ${code}: ${detail}`);
  try {
    recordEvent('operation_warning', { ...context, code, error: detail });
  } catch (recordError) {
    console.warn(`[operation-warning] could not record ${code}: ${failureText(recordError)}`);
  }
  return { code, message };
}
