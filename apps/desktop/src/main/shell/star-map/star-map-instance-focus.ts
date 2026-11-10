import type { WebContents } from "electron";
import { sendStarMapCommand } from "./star-map-command-bus";

/**
 * How long a Federation chip click keeps trying to reach its instance. A map
 * opened by the click needs its thread feed and peer directory before the
 * instance body exists, so the first flights can miss.
 */
export const STAR_MAP_INSTANCE_FOCUS_TIMEOUT_MS = 15_000;

type PendingFocus = {
  webContentsId: number;
  instanceId: string;
  expiresAt: number;
  inFlight: boolean;
};

/** One at a time: a second click supersedes a flight the map has not made yet. */
let pendingFocus: PendingFocus | undefined;

/**
 * Fly the map to a federation instance, now if it has drawn, otherwise on
 * the view it publishes next. In memory only; a closed map has nothing to fly.
 */
export function requestStarMapInstanceFocus(params: {
  webContents: WebContents;
  instanceId: string;
  /** The map has published a view, so its command listener is mounted. */
  mapReady: boolean;
  now?: number;
}): void {
  pendingFocus = {
    webContentsId: params.webContents.id,
    instanceId: params.instanceId,
    expiresAt: (params.now ?? Date.now()) + STAR_MAP_INSTANCE_FOCUS_TIMEOUT_MS,
    inFlight: false,
  };
  if (params.mapReady) attemptStarMapInstanceFocus(params.webContents, params.now);
}

/**
 * Called for each view the map publishes. A publish is the map saying it has
 * drawn, so it is when a waiting flight is worth trying again.
 */
export function attemptStarMapInstanceFocus(
  webContents: WebContents,
  now = Date.now(),
): void {
  const focus = pendingFocus;
  if (!focus || focus.webContentsId !== webContents.id || focus.inFlight) return;
  if (now > focus.expiresAt || webContents.isDestroyed()) {
    pendingFocus = undefined;
    return;
  }
  focus.inFlight = true;
  void sendStarMapCommand(
    { kind: "fly_to", target: { kind: "instance", instanceId: focus.instanceId } },
    { webContents: () => webContents },
  ).then((response) => {
    focus.inFlight = false;
    if (pendingFocus !== focus) return;
    // not_found means the body is not drawn yet; the next publish retries.
    if (response?.ok || response?.error.code !== "not_found") pendingFocus = undefined;
  });
}

/** Test seam. */
export function resetStarMapInstanceFocus(): void {
  pendingFocus = undefined;
}
