import { BrowserWindow, type NativeImage, type WebContents } from "electron";
import type {
  StarMapViewSnapshot,
  StarMapViewSurface,
} from "@pwragent/shared";
import { getMainLogger } from "../log";

const log = getMainLogger("pwragent:star-map-view");

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
 * serve the most recently published live entry, which is the one the
 * operator is actually looking at.
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

export type StarMapCapture = {
  surface: StarMapViewSurface;
  png: Buffer;
  width: number;
  height: number;
};

/**
 * Capture the surface that published the current view.
 *
 * Capturing the *publisher* rather than "the star map window" is what keeps
 * the pixels and the structured snapshot describing the same thing: when the
 * operator is using the in-app layer, the dedicated window may be stale or
 * absent entirely.
 */
export async function captureStarMapView(options: {
  maxWidth?: number;
} = {}): Promise<StarMapCapture | undefined> {
  const entry = currentEntry();
  if (!entry) return undefined;
  const window = BrowserWindow.fromWebContents(entry.webContents);
  if (!window || window.isDestroyed()) return undefined;
  try {
    let image: NativeImage = await entry.webContents.capturePage();
    if (image.isEmpty()) return undefined;
    const size = image.getSize();
    if (options.maxWidth && size.width > options.maxWidth) {
      image = image.resize({ width: options.maxWidth, quality: "good" });
    }
    const resized = image.getSize();
    return {
      surface: entry.snapshot.surface,
      png: image.toPNG(),
      width: resized.width,
      height: resized.height,
    };
  } catch (error) {
    log.warn("star map capture failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Test seam: drop every published view. */
export function resetStarMapViewRegistry(): void {
  entries.clear();
}
