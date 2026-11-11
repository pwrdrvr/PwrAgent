/**
 * Calls every listener with `value`. A listener that throws is skipped: it
 * neither stops the listeners after it nor reaches the caller. `onError`, when
 * given, receives each thrown error so the caller can log it.
 *
 * Adapter listeners such as rate-limit observers are observability for the
 * desktop runtime. A failing one must not change how a delivery is handled.
 */
export function notifyEachListener<T>(
  listeners: Iterable<(value: T) => void>,
  value: T,
  onError?: (error: unknown) => void,
): void {
  for (const listener of listeners) {
    try {
      listener(value);
    } catch (error) {
      try {
        onError?.(error);
      } catch {
        // A failing error logger must not break isolation either.
      }
    }
  }
}

/**
 * Calls every listener with `value` and waits for each returned promise. A
 * listener that throws or rejects is passed to `onError` and never stops the
 * others. The returned promise never rejects, so a caller that cannot wait may
 * discard it with `void` without leaving an unhandled rejection.
 *
 * Listeners start together rather than one after another, so a slow listener
 * does not hold back the rest.
 */
export async function notifyEachListenerAsync<T>(
  listeners: Iterable<(value: T) => Promise<void> | void>,
  value: T,
  onError?: (error: unknown) => void,
): Promise<void> {
  const report = (error: unknown) => {
    try {
      onError?.(error);
    } catch {
      // A failing error logger must not break isolation either.
    }
  };
  const pending: Promise<void>[] = [];
  for (const listener of listeners) {
    try {
      const result = listener(value);
      if (result && typeof result.then === "function") {
        pending.push(Promise.resolve(result).then(undefined, report));
      }
    } catch (error) {
      report(error);
    }
  }
  await Promise.all(pending);
}
