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
  const keptKeys = new Set(threads.map((thread) => thread.threadKey));

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
        // narrowed only by an explicit instance filter — a selected card the
        // thread cap dropped is still a card the operator is pointing at.
        selectedThreadKeys: snapshot.selectedThreadKeys.filter(
          (key) => keptKeys.has(key) || !args.instanceId,
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
  const result = await capture({
    maxWidth: args.maxWidth ?? DEFAULT_STAR_MAP_CAPTURE_MAX_WIDTH,
  });
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
