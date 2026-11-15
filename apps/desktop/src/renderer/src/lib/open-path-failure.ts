import type { OpenPathResponse } from "@pwragent/shared";

/** A thrown value's message, without the "Error invoking remote method …" wrapper Electron adds. */
export function ipcErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "");
}

/** How an `openPath` / `revealPath` call settled. */
export type OpenPathOutcome =
  | { response: OpenPathResponse }
  | { error: unknown };

export type OpenPathFailure =
  | { kind: "missing" }
  | { kind: "failed"; message: string };

/**
 * Why an open or reveal showed nothing, or undefined when it worked. The
 * caller words a missing path for what it is (a project folder, a log file);
 * any other failure carries the reason to show.
 */
export function describeOpenPathFailure(
  outcome: OpenPathOutcome,
  fallback: string,
): OpenPathFailure | undefined {
  if ("response" in outcome) {
    const { response } = outcome;
    if (response.opened) return undefined;
    if (response.missing) return { kind: "missing" };
    return { kind: "failed", message: response.error?.trim() || fallback };
  }
  return { kind: "failed", message: ipcErrorMessage(outcome.error).trim() || fallback };
}
