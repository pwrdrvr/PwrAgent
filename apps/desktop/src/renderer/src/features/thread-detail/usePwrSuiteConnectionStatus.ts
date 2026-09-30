import { useCallback, useEffect, useRef, useState } from "react";

/** Wait before each retry of a failed read; the last delay then repeats. */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];

/** Failed reads in a row, with nothing read yet, before the card says so. */
const UNREACHABLE_AFTER_FAILURES = 2;

/** An action's failure without the "Error invoking remote method …" wrapper Electron adds. */
export function connectionActionError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "");
}

/**
 * Reads a PwrSuite app's connection status for its New Thread card.
 *
 * An app that is offline is a read that succeeds: it reports `installed` or
 * `not_installed`, and the card offers Open or Get. A read that throws is
 * PwrAgent's own connection service failing to answer — most often another
 * PwrAgent instance on this profile that exited while holding the MCP
 * connection lease, whose broker socket refuses connections until the
 * dead-owner grace lets this instance take over. That is not something the
 * operator can act on from the card, so the card never shows the error: it
 * keeps the last status it read and retries until a read succeeds.
 */
export function usePwrSuiteConnectionStatus<T>(
  read: (() => Promise<T>) | undefined,
  /** Runs after each successful read, so the card can clear a stale action error. */
  onRead?: () => void,
) {
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;
  const [status, setStatusState] = useState<T>();
  const [failures, setFailures] = useState(0);
  // Bumped by every read and every status set from elsewhere (a Connect
  // response). A read that resolves after a newer one started, or after
  // Connect answered, is older than what the card shows and is dropped.
  const generation = useRef(0);

  const setStatus = useCallback((next: T) => {
    generation.current += 1;
    setStatusState(next);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!read) return;
    const started = ++generation.current;
    try {
      const next = await read();
      if (started !== generation.current) return;
      setStatusState(next);
      setFailures(0);
      onReadRef.current?.();
    } catch {
      if (started !== generation.current) return;
      setFailures((count) => count + 1);
    }
  }, [read]);

  useEffect(() => {
    void refresh();
    // Pairing happens in the app's own window, so the answer usually arrives
    // while this window is in the background. Re-read on focus.
    const onFocus = (): void => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  useEffect(() => {
    if (failures === 0) return;
    const delay =
      RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length) - 1];
    const timer = window.setTimeout(() => void refresh(), delay);
    return () => window.clearTimeout(timer);
  }, [failures, refresh]);

  return {
    status,
    setStatus,
    refresh,
    unreachable:
      status === undefined && failures >= UNREACHABLE_AFTER_FAILURES,
  };
}
