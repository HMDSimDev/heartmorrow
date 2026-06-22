/**
 * Per-key in-process async mutex. Serializes async critical sections that share a
 * key so a check-then-act spanning an `await` (e.g. "is the last message a player
 * turn? → call the model → insert the reply") can't interleave with a concurrent
 * request — two browser tabs on the same local DB, or a double-fired button. The
 * server is single-process (node:sqlite), so an in-process chain is sufficient.
 *
 * Usage: `await withKeyedLock(key, async () => { ...critical section... })`. Calls
 * with the same key run one at a time, in arrival order; different keys are
 * independent and still run concurrently.
 */
const chains = new Map<string, Promise<unknown>>();

export function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(() => fn());
  // A never-rejecting tail so the next waiter chains after this one regardless of
  // whether `fn` resolved or threw.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);
  // Keep the map bounded: drop the entry once this is the last link in its chain.
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}
