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
