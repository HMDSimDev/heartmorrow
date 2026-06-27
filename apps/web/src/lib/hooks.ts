import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

export interface AsyncState<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
  setData: (value: T) => void;
}

/** Run an async loader, exposing data/error/loading + a reload trigger.
 *
 *  Each call to reload() takes a monotonic ticket; only the most recent in-flight
 *  request is allowed to commit state. This drops out-of-order responses (a slow
 *  earlier load can't overwrite a newer one) and prevents setState-after-unmount
 *  (the unmount cleanup invalidates any pending ticket). */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const ticketRef = useRef(0);

  const reload = useCallback(() => {
    const ticket = ++ticketRef.current;
    const current = () => ticket === ticketRef.current;
    setLoading(true);
    setError(undefined);
    loaderRef.current()
      .then((d) => current() && setData(d))
      .catch((e) => current() && setError(errorMessage(e)))
      .finally(() => current() && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    reload();
  }, [reload]);

  // Invalidate any in-flight request when the component unmounts so a late
  // resolution can't call setState on an unmounted component.
  useEffect(() => () => void ++ticketRef.current, []);

  return { data, error, loading, reload, setData };
}

/** Zod's `flatten()` shape, as the server sends it in `ApiError.details` for a
 *  validation failure ({ error: 'Validation failed.', details: {…} }). */
interface ZodFlattened {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
}

function asZodFlattened(d: unknown): ZodFlattened | null {
  if (!d || typeof d !== 'object') return null;
  const f = d as Partial<ZodFlattened>;
  return Array.isArray(f.formErrors) && f.fieldErrors && typeof f.fieldErrors === 'object'
    ? (f as ZodFlattened)
    : null;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    // Surface which field(s) failed validation instead of a bare "Validation failed."
    const flat = asZodFlattened(err.details);
    if (flat) {
      const parts = [...flat.formErrors];
      for (const [field, msgs] of Object.entries(flat.fieldErrors)) {
        if (Array.isArray(msgs) && msgs.length) parts.push(`${field} — ${msgs.join(', ')}`);
      }
      if (parts.length) return `${err.message} ${parts.join('; ')}`;
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
