import type {
  CaptureStarMapToolArgs,
  PwrAgentStarMapRequest,
  PwrAgentStarMapResponse,
  ReadStarMapViewToolArgs,
  StarMapViewSnapshot,
  StarMapViewThread,
} from "@pwragent/shared";
import {
  DEFAULT_STAR_MAP_CAPTURE_MAX_WIDTH,
  DEFAULT_STAR_MAP_VIEW_MAX_THREADS,
  MAX_STAR_MAP_CAPTURE_BYTES,
} from "@pwragent/shared";
import type { PwrAgentStarMapHandler } from "../agent-tools/pwragent-star-map-agent-tools";
import {
  captureStarMapView,
  readStarMapView,
  type StarMapCapture,
} from "./star-map-view-registry";

const NOT_OPEN_MESSAGE =
  "No Star Map surface is open, so there is nothing on screen to read. Ask the operator to open the Star Map (View → Star Map, or the map button in the sidebar).";

export type StarMapAgentToolsDeps = {
  readView?: () => StarMapViewSnapshot | undefined;
  capture?: (options: { maxWidth?: number }) => Promise<StarMapCapture | undefined>;
  now?: () => number;
};

/**
 * Serves the two Star Map tools from the view the renderer last published.
 *
 * Filtering happens here rather than in the renderer so the published
 * snapshot stays one shape: the publisher is on the drag path and should do
 * as little conditional work as possible.
 */
export function createStarMapAgentToolsHandler(
  deps: StarMapAgentToolsDeps = {},
): PwrAgentStarMapHandler {
  const readView = deps.readView ?? readStarMapView;
  const capture = deps.capture ?? captureStarMapView;
  const now = deps.now ?? (() => Date.now());
  return async (
    request: PwrAgentStarMapRequest,
  ): Promise<PwrAgentStarMapResponse> => {
    if (request.operation === "read_star_map_view") {
      return readViewResponse(readView(), request.args, now());
    }
    return await captureResponse(capture, request.args, readView());
  };
}

function readViewResponse(
  snapshot: StarMapViewSnapshot | undefined,
  args: ReadStarMapViewToolArgs,
  nowMs: number,
): PwrAgentStarMapResponse<"read_star_map_view"> {
  if (!snapshot) {
    return {
      ok: false,
      error: { code: "star_map_not_open", message: NOT_OPEN_MESSAGE },
    };
  }
  const includeHidden = args.includeHidden ?? true;
  const maxThreads = args.maxThreads ?? DEFAULT_STAR_MAP_VIEW_MAX_THREADS;
  const matchesInstance = (instanceId: string | undefined): boolean =>
    !args.instanceId || instanceId === args.instanceId;

  const eligible = snapshot.threads.filter(
    (thread: StarMapViewThread) =>
      matchesInstance(thread.instanceId) && (includeHidden || thread.visible),
  );
  // Drawn cards first: a truncated list should keep what the operator can
  // actually point at, not whatever the layout happened to order first.
  const ordered = [...eligible].sort((left, right) => {
    if (left.visible !== right.visible) return left.visible ? -1 : 1;
    if (left.selected !== right.selected) return left.selected ? -1 : 1;
    return 0;
  });
  const threads = ordered.slice(0, maxThreads);
  const truncatedThreadCount = ordered.length - threads.length;
  // Instance membership taken from the WHOLE snapshot, not from the capped
  // list: a selected card the cap dropped is still a card the operator is
  // pointing at, and reporting a shorter selection than they hold is how an
  // Agent ends up acting on five of forty gathered threads.
  const instanceKeys = args.instanceId
    ? new Set(
        snapshot.threads
          .filter((thread) => matchesInstance(thread.instanceId))
          .map((thread) => thread.threadKey),
      )
    : undefined;
  const narrowToInstance = (keys: string[]): string[] =>
    instanceKeys ? keys.filter((key) => instanceKeys.has(key)) : keys;

  return {
    ok: true,
    data: {
      ageMs: Math.max(0, nowMs - snapshot.capturedAt),
      truncatedThreadCount:
        truncatedThreadCount > 0 ? truncatedThreadCount : undefined,
      snapshot: {
        ...snapshot,
        instances: snapshot.instances.filter((instance) =>
          matchesInstance(instance.instanceId),
        ),
        clouds: snapshot.clouds.filter((cloud) =>
          matchesInstance(cloud.instanceId),
        ),
        threads,
        // Selection and open cards are reported as the operator holds them,
        // narrowed only by an explicit instance filter.
        selectedThreadKeys: narrowToInstance(snapshot.selectedThreadKeys),
        openChatCardThreadKeys: narrowToInstance(
          snapshot.openChatCardThreadKeys,
        ),
      },
    },
  };
}

async function captureResponse(
  capture: (options: { maxWidth?: number }) => Promise<StarMapCapture | undefined>,
  args: CaptureStarMapToolArgs,
  snapshot: StarMapViewSnapshot | undefined,
): Promise<PwrAgentStarMapResponse<"capture_star_map">> {
  if (!snapshot) {
    return {
      ok: false,
      error: { code: "star_map_not_open", message: NOT_OPEN_MESSAGE },
    };
  }
  let result = await capture({
    maxWidth: args.maxWidth ?? DEFAULT_STAR_MAP_CAPTURE_MAX_WIDTH,
  });
  if (result && result.png.byteLength > MAX_STAR_MAP_CAPTURE_BYTES) {
    // A wide capture of a dense map encodes to megabytes, and base64 adds a
    // third on top before it reaches the model. Halve the long edge once
    // rather than handing back a tool result that size.
    result =
      (await capture({ maxWidth: Math.max(320, Math.floor(result.width / 2)) }))
      ?? result;
  }
  if (result && result.png.byteLength > MAX_STAR_MAP_CAPTURE_BYTES) {
    return {
      ok: false,
      error: {
        code: "capture_failed",
        message: `The capture encoded to ${Math.round(result.png.byteLength / 1_024)} KB, over the ${Math.round(MAX_STAR_MAP_CAPTURE_BYTES / 1_024)} KB limit for a tool result. Call again with a smaller maxWidth, or use read_star_map_view.`,
      },
    };
  }
  if (!result) {
    return {
      ok: false,
      error: {
        code: "capture_failed",
        message:
          "The Star Map surface could not be captured. It may have just closed; read_star_map_view reports the same state without pixels.",
      },
    };
  }
  return {
    ok: true,
    data: {
      surface: result.surface,
      width: result.width,
      height: result.height,
      byteLength: result.png.byteLength,
    },
    imageBase64: result.png.toString("base64"),
    imageMimeType: "image/png",
  };
}
