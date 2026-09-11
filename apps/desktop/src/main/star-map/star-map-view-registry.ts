import type { WebContents } from "electron";
import type { StarMapViewSnapshot } from "@pwragent/shared";

/**
 * Latest published Star Map view, per publishing renderer.
 *
 * In memory only, deliberately: this turns over as fast as the operator
 * drags a card, and a per-frame SQLite commit is exactly the write pattern
 * the repository budgets against. Nothing here survives a restart, and
 * nothing needs to — a closed map has no on-screen state to report.
 *
 * Keyed by `WebContents.id` because both surfaces can be open at once (the
 * dedicated Star Map window and the in-app layer in the main window). Reads
 * serve the most recently published live entry. That is a heuristic, not a
 * fact about focus: a map the operator is reading without touching stops
 * republishing, so a background map with a live turn in it can be the more
 * recent one. Good enough while the map is a single window; revisit with a
 * focus tiebreaker if the in-app layer returns.
 */
type Entry = {
  snapshot: StarMapViewSnapshot;
  webContents: WebContents;
  receivedAt: number;
};

const entries = new Map<number, Entry>();

function isLive(entry: Entry): boolean {
  return !entry.webContents.isDestroyed();
}

function prune(): void {
  for (const [id, entry] of entries) {
    if (!isLive(entry)) entries.delete(id);
  }
}

export function publishStarMapView(params: {
  snapshot: StarMapViewSnapshot;
  webContents: WebContents;
  now?: number;
}): void {
  prune();
  if (params.webContents.isDestroyed()) return;
  const id = params.webContents.id;
  if (!entries.has(id)) {
    // The map surface can close without ever publishing again, and a stale
    // entry would answer for a window that is no longer on screen.
    params.webContents.once("destroyed", () => {
      entries.delete(id);
    });
  }
  entries.set(id, {
    snapshot: params.snapshot,
    webContents: params.webContents,
    receivedAt: params.now ?? Date.now(),
  });
}

/** Most recently published still-live view, or undefined when no map is open. */
export function readStarMapView(): StarMapViewSnapshot | undefined {
  return currentEntry()?.snapshot;
}

function currentEntry(): Entry | undefined {
  prune();
  let latest: Entry | undefined;
  for (const entry of entries.values()) {
    if (!latest || entry.receivedAt > latest.receivedAt) latest = entry;
  }
  return latest;
}

/** Test seam: drop every published view. */
export function resetStarMapViewRegistry(): void {
  entries.clear();
}
