import type {
  ResourceCheckoutActionRequest,
  ResourceCheckoutActionResult,
  ResourceCheckoutsChangedEvent,
  ResourceCheckoutsSnapshot,
} from "@pwragent/shared/contracts/resource-checkouts";
import type { DesktopApi } from "../../lib/desktop-api";

/**
 * Where the Resources screen reads checkout state and sends actions.
 *
 * `live` sources are backed by the serving authority through the main
 * process. `preview` sources serve fixture data with simulated results; the
 * screen labels them on every view and they are only reachable from a
 * development build (see `ResourcesPreviewWindow`).
 */
export type ResourceCheckoutsOrigin = "live" | "preview";

export interface ResourceCheckoutsSource {
  readonly origin: ResourceCheckoutsOrigin;
  /** The current snapshot. Rejects when the authority view can't be read. */
  read(): Promise<ResourceCheckoutsSnapshot>;
  /** Marker events; the screen re-reads. Returns an unsubscribe. */
  subscribe(onChanged: (event: ResourceCheckoutsChangedEvent) => void): () => void;
  perform(request: ResourceCheckoutActionRequest): Promise<ResourceCheckoutActionResult>;
}

/**
 * The production source, or `null` when this build's main process does not
 * serve resource checkouts. A `null` source hides every entry point: the
 * shell never shows the screen without a real authority behind it.
 */
export function createDesktopResourceCheckoutsSource(
  api: DesktopApi | undefined,
): ResourceCheckoutsSource | null {
  const read = api?.readResourceCheckouts;
  const subscribe = api?.onResourceCheckoutsChanged;
  const perform = api?.performResourceCheckoutAction;
  if (!read || !subscribe || !perform) return null;
  return {
    origin: "live",
    read: () => read(),
    subscribe: (onChanged) => subscribe(onChanged),
    perform: (request) => perform(request),
  };
}

/** One key per operator intent; a resend after an unknown outcome reuses it. */
export function newResourceActionIdempotencyKey(): string {
  return `rco-${globalThis.crypto.randomUUID()}`;
}
