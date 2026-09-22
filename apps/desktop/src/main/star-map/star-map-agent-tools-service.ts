import type {
  FlyStarMapToToolArgs,
  PwrAgentStarMapRequest,
  PwrAgentStarMapResponse,
  ReadStarMapViewToolArgs,
  StarMapFlightTarget,
  StarMapViewSnapshot,
  StarMapViewThread,
} from "@pwragent/shared";
import {
  DEFAULT_STAR_MAP_VIEW_MAX_THREADS,
  isAppServerBackendKind,
} from "@pwragent/shared";
import type { PwrAgentStarMapHandler } from "../agent-tools/pwragent-star-map-agent-tools";
import { sendStarMapCommand } from "./star-map-command-bus";
import { readStarMapView } from "./star-map-view-registry";

const NOT_OPEN_MESSAGE =
  "No Star Map surface is open, so there is nothing on screen to read. Ask the operator to open the Star Map (View → Star Map, or the map button in the sidebar).";

export type StarMapAgentToolsDeps = {
  readView?: () => StarMapViewSnapshot | undefined;
  now?: () => number;
  sendCommand?: typeof sendStarMapCommand;
};

/**
 * Serves the Star Map tool from the view the renderer last published.
 *
 * Filtering happens here rather than in the renderer so the published
 * snapshot stays one shape: the publisher is on the drag path and should do
 * as little conditional work as possible.
 */
export function createStarMapAgentToolsHandler(
  deps: StarMapAgentToolsDeps = {},
): PwrAgentStarMapHandler {
  const readView = deps.readView ?? readStarMapView;
  const now = deps.now ?? (() => Date.now());
  const sendCommand = deps.sendCommand ?? sendStarMapCommand;
  return async (
    request: PwrAgentStarMapRequest,
  ): Promise<PwrAgentStarMapResponse> => {
    if (request.operation === "fly_star_map_to") {
      return await flyResponse(request.args, sendCommand);
    }
    return readViewResponse(readView(), request.args, now());
  };
}

async function flyResponse(
  args: FlyStarMapToToolArgs,
  sendCommand: typeof sendStarMapCommand,
): Promise<PwrAgentStarMapResponse<"fly_star_map_to">> {
  const target = flightTargetFor(args);
  if (typeof target === "string") {
    return { ok: false, error: { code: "invalid_arguments", message: target } };
  }
  const response = await sendCommand({ kind: "fly_to", target });
  return response ?? {
    ok: false,
    error: { code: "star_map_not_open", message: NOT_OPEN_MESSAGE },
  };
}

/** The one destination the arguments name, or why they name none. */
function flightTargetFor(
  args: FlyStarMapToToolArgs,
): StarMapFlightTarget | string {
  if (args.threadId !== undefined && args.cloudKey !== undefined) {
    return "fly_star_map_to takes a threadId or a cloudKey, not both.";
  }
  if (args.threadId !== undefined) {
    if (!args.backend || !isAppServerBackendKind(args.backend)) {
      return "fly_star_map_to needs the thread's backend beside threadId.";
    }
    return {
      kind: "thread",
      backend: args.backend,
      threadId: args.threadId,
      ...(args.instanceId ? { instanceId: args.instanceId } : {}),
    };
  }
  if (args.backend !== undefined) {
    return "fly_star_map_to backend only goes with threadId.";
  }
  if (args.cloudKey !== undefined) {
    return {
      kind: "cloud",
      cloudKey: args.cloudKey,
      ...(args.instanceId ? { instanceId: args.instanceId } : {}),
    };
  }
  if (args.instanceId !== undefined) {
    return { kind: "instance", instanceId: args.instanceId };
  }
  return "fly_star_map_to needs a threadId, a cloudKey, or an instanceId.";
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

  // A projects-lens cloud pools threads from the whole fleet, so it carries
  // no instanceId. Filtering it out by instance would strand the `cloudKey`
  // its own members still point at, which is the one reference the tool
  // exists to resolve; keep it, with its membership narrowed instead.
  const clouds = snapshot.clouds
    .filter((cloud) => cloud.instanceId === undefined
      || matchesInstance(cloud.instanceId))
    .map((cloud) => {
      const threadKeys = narrowToInstance(cloud.threadKeys);
      // The cap bounds the payload, never the counts: a cloud that reports
      // a shorter membership than it has is how "the others in this cloud"
      // acts on the wrong set. `threadCount` stays whole and the omission
      // is stated outright.
      const listed = threadKeys.slice(0, maxThreads);
      // The snapshot may already withhold keys the map has not loaded, so
      // the cap adds to that count instead of replacing it.
      const omitted =
        (cloud.omittedThreadKeyCount ?? 0)
        + (threadKeys.length - listed.length);
      return {
        ...cloud,
        threadKeys: listed,
        ...(omitted > 0 ? { omittedThreadKeyCount: omitted } : {}),
      };
    });

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
        clouds,
        threads,
        // Selection and open cards are reported as the operator holds them,
        // narrowed only by an explicit instance filter.
        selectedThreadKeys: narrowToInstance(snapshot.selectedThreadKeys),
        openChatCardThreadKeys: narrowToInstance(
          snapshot.openChatCardThreadKeys,
        ),
        // Fleet-wide by construction, so an instance-scoped answer has to
        // recount rather than pass them through: reporting "40 threads match"
        // beside five listed and no truncation notice reads as a stale map.
        ...(args.instanceId
          ? {
              matchedThreadCount: eligible.length,
              hiddenInstanceCount: 0,
            }
          : {}),
      },
    },
  };
}
