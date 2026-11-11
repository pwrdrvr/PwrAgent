/**
 * Calls every listener with `value`. A listener that throws is skipped: it
 * neither stops the listeners after it nor reaches the caller.
 *
 * Adapter listeners such as rate-limit observers are observability for the
 * desktop runtime. A failing one must not change how a delivery is handled.
 */
export function notifyEachListener<T>(
  listeners: Iterable<(value: T) => void>,
  value: T,
): void {
  for (const listener of listeners) {
    try {
      listener(value);
    } catch {
      // Isolated by design; see above.
    }
  }
}
