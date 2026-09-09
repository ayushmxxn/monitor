/**
 * Small, framework-independent concurrency primitives shared by
 * `store.ts` (storage write serialization) and `checker.ts` (per-monitor
 * check dedup). Kept dependency-free — no `chrome.*`/`browser.*` calls —
 * the same way `resolveSettledValue` (`locate.ts`) and `searchByScrolling`
 * (`scrollRecovery.ts`) are, so the actual race-prevention logic is
 * directly unit-testable without pulling in the extension runtime.
 */

/**
 * Runs `fn` after every previously-queued call for the same `key` has
 * settled, so calls that share a key always execute strictly one after
 * another - each one starting from the real result of the one before
 * it, never from a snapshot taken before that one ran.
 *
 * Exists for read-modify-write operations over shared state with no
 * atomic compare-and-swap (e.g. `chrome.storage`'s plain get/set pair):
 * two overlapping calls that each read the same starting value before
 * either has written back will otherwise silently lose whichever write
 * lands first - a classic lost-update race. Serializing by key closes
 * that race without blocking calls that use a *different* key.
 *
 * `queues` is passed in (rather than module-private) so a caller can
 * hold one queue per logical resource - `store.ts` uses one for the
 * monitors list and one per monitor's history, so a write to one
 * monitor's history is never held up by a write to another's.
 */
export function serializeByKey<T>(
  queues: Map<string, Promise<unknown>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  // Chain the next caller off this call's completion regardless of
  // success/failure, but never let one failed call poison the queue for
  // every call after it.
  queues.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * Runs `run` for `key`, or returns the already-in-flight promise for
 * that same key if one exists instead of starting a duplicate.
 * Deterministic and memory-safe: the map entry is always removed the
 * instant the run settles (success or failure), so a long-lived caller
 * (a background worker that lives for the life of the browser session)
 * never accumulates stale entries for keys that finished long ago.
 *
 * `inFlight` is passed in for the same reason as `serializeByKey`'s
 * `queues` - the caller owns the map's lifetime and scope.
 */
export function dedupeInFlight<T>(
  inFlight: Map<string, Promise<T>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = run().finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}
