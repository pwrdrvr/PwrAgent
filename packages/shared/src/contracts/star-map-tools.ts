import type {
  AppServerBackendKind,
  ThreadIdentifier,
} from "./normalized-app-server";
import type { FederationInstanceId } from "./federation";
import type { StarMapWorkspaceLayout } from "./star-map";

/**
 * The Star Map's on-screen state, exposed to Agent turns.
 *
 * The map is drawn entirely in the renderer: cloud membership, which cards
 * are folded into a `+N more` chip, the camera, the marquee selection and
 * the active filters exist nowhere else. An Agent asked to "rename that
 * thread like the others in its cloud" cannot resolve either deictic from
 * the navigation snapshot alone, so the renderer publishes this view
 * snapshot to the main process and the `read_star_map_view` tool serves it.
 *
 * The vocabulary here is deliberately the operator's, not the layout
 * engine's: a `StarMapClusterPlacement` is a "cloud", because that is the
 * word on the screen and in the request the operator types.
 */
export const PWRAGENT_STAR_MAP_OPERATION_NAMES = [
  "read_star_map_view",
  "fly_star_map_to",
  "highlight_star_map_threads",
  "set_star_map_view",
] as const;

export type PwrAgentStarMapOperationName =
  (typeof PWRAGENT_STAR_MAP_OPERATION_NAMES)[number];

export const PWRAGENT_STAR_MAP_ERROR_CODES = [
  "invalid_arguments",
  "star_map_not_open",
  "not_found",
  "unsupported_operation",
  "internal_error",
] as const;

export type PwrAgentStarMapErrorCode =
  (typeof PWRAGENT_STAR_MAP_ERROR_CODES)[number];

/** Mirrors the renderer's `StarMapLayoutMode`; the publisher assigns across. */
/** Mirrors `StarMapWorkspaceLayout`; kept as a value so the guard can check it. */
export const STAR_MAP_VIEW_LAYOUTS = [
  "lanes",
  "orbit",
  "projects",
] as const satisfies readonly StarMapWorkspaceLayout[];

export type StarMapViewLayout = (typeof STAR_MAP_VIEW_LAYOUTS)[number];

/** Which surface published the snapshot, since both can be open at once. */
export type StarMapViewSurface = "window" | "in-app";

export type StarMapViewRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type StarMapViewCamera = {
  x: number;
  y: number;
  /**
   * 1 is unzoomed. The canvas is transformed `translate(x, y) scale(scale)`,
   * which applies right to left, so `screen = map * scale + camera` — not
   * `(map + camera) * scale`. Each thread carries a derived `screenRect` so
   * nothing downstream has to get this order right.
   */
  scale: number;
};

export type StarMapViewFilter = {
  key: string;
  label: string;
  state: "include" | "exclude";
};

export type StarMapViewInstance = {
  instanceId: FederationInstanceId | string;
  label: string;
  isLocal: boolean;
  /** Celestial identity mark drawn as the body, when assigned. */
  icon?: string;
  /** Threads this instance contributes to the map after filtering. */
  threadCount: number;
  /** How many of those are drawn rather than folded into an overflow chip. */
  visibleThreadCount: number;
};

export type StarMapViewCloud = {
  /** Stable cloud identity: project key, or `${projectKey}::pc:${parentKey}`. */
  key: string;
  /** Project name for catch-all clouds; the parent thread's title otherwise. */
  label: string;
  /** Absent in the projects lens, where a cloud pools threads from every
   * instance rather than belonging to one. */
  instanceId?: FederationInstanceId | string;
  instanceLabel?: string;
  /** False only for the pooled no-project cloud. */
  isProject: boolean;
  /** This cloud is one parent thread and its descendants. */
  isParentGroup: boolean;
  expanded: boolean;
  /**
   * Complete membership, including members the map has not loaded yet. This
   * is the number on the cloud's own chip, so it is the number the operator
   * is reading when they say "that cloud with forty in it".
   */
  threadCount: number;
  visibleCount: number;
  /** In the cloud and not drawn: folded, paged away, or off screen. */
  hiddenCount: number;
  /**
   * Members in the cloud's own order, drawn and folded alike. Shorter than
   * `threadCount` when the map has not loaded the rest or the call's
   * `maxThreads` capped it; `threadCount` is always whole, and
   * `omittedThreadKeyCount` says how many keys are missing.
   */
  threadKeys: string[];
  /** Set when `threadKeys` lists fewer members than `threadCount`. */
  omittedThreadKeyCount?: number;
};

export type StarMapViewThread = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  /** `buildThreadIdentityKey(backend, threadId)`; the key clouds refer to. */
  threadKey: string;
  title?: string;
  /** Pass to `mutate_thread` / orchestration tools as `instanceId`. */
  instanceId: FederationInstanceId | string;
  instanceLabel: string;
  isLocal: boolean;
  /** The cloud this card sits in, when the lens draws clouds. */
  cloudKey?: string;
  /** Drawn now, versus folded into its cloud's overflow chip. */
  visible: boolean;
  /** Gathered by the operator's marquee or shift-click. */
  selected: boolean;
  /** Ringed by an Agent's `highlight_star_map_threads`, not by the operator. */
  highlighted?: boolean;
  /** A floating chat card on the map is open on this thread. */
  chatCardOpen: boolean;
  /** Map-space card rect; absent while the card is folded away. */
  rect?: StarMapViewRect;
  /**
   * The same card in the viewport's own coordinates, origin top-left, so a
   * question about where a card sits on screen needs no arithmetic.
   *
   * Derived rather than left to the caller because the camera transform is
   * easy to apply subtly wrong, and a spatial reference resolved off a wrong
   * transform names the wrong card without ever looking uncertain. Present
   * whenever `rect` is; may fall outside the viewport when the operator has
   * panned the card off screen, which `onScreen` reports.
   */
  screenRect?: StarMapViewRect;
  /** Whether `screenRect` overlaps the viewport at all. */
  onScreen?: boolean;
  pinned?: boolean;
  /**
   * The attention categories driving the map's own filter chips:
   * `unread`, `active`, `approval`, `pr`, `unpushed`.
   */
  attention: string[];
  /** Project the map groups this thread under; the cloud label it feeds. */
  projectLabel?: string;
};

export type StarMapViewSnapshot = {
  /** `Date.now()` in the publishing renderer, for the served `ageMs`. */
  capturedAt: number;
  surface: StarMapViewSurface;
  layout: StarMapViewLayout;
  camera: StarMapViewCamera;
  viewport: { width: number; height: number };
  /** Only the facets the operator actually set; neutral ones are omitted. */
  filters: StarMapViewFilter[];
  hideOfflineInstances: boolean;
  /** Offline instances dropped from the map by that preference. */
  hiddenInstanceCount: number;
  instances: StarMapViewInstance[];
  clouds: StarMapViewCloud[];
  threads: StarMapViewThread[];
  selectedThreadKeys: string[];
  openChatCardThreadKeys: string[];
  /** What an Agent last highlighted, drawn or not. */
  highlightedThreadKeys?: string[];
  /** Threads surviving the current filters, across every instance. */
  matchedThreadCount: number;
};

export const DEFAULT_STAR_MAP_VIEW_MAX_THREADS = 200;
export const MAX_STAR_MAP_VIEW_MAX_THREADS = 1_000;

export type ReadStarMapViewToolArgs = {
  /**
   * Cap on returned threads, newest-drawn first. Clouds always report their
   * full membership counts, so a truncated list is still honest about what
   * it left out.
   */
  maxThreads?: number;
  /** Restrict to one instance's cards. Omit for the whole fleet. */
  instanceId?: FederationInstanceId | string;
  /** Set false to drop threads folded behind a `+N more` chip. */
  includeHidden?: boolean;
};

/**
 * Where to fly the camera: a thread's card, a cloud, or - with `instanceId`
 * alone - that instance's own body.
 */
export type FlyStarMapToToolArgs = {
  /** A card. Pair with `backend`, and with `instanceId` for a peer's thread. */
  threadId?: ThreadIdentifier;
  backend?: AppServerBackendKind;
  /** A cloud, by the `key` read_star_map_view reports. */
  cloudKey?: string;
  /**
   * The instance that owns the thread or cloud. The same project draws one
   * cloud per instance in the lanes and orbit lenses, so a cloud key alone
   * can name more than one.
   */
  instanceId?: FederationInstanceId | string;
  /** With a thread only: open it once there. See `StarMapThreadOpenMode`. */
  open?: StarMapThreadOpenMode;
};

/**
 * How to open a thread an Agent flew to. `card` opens its chat card on the
 * map, beside the thread's own card. `full` opens the whole thread: in the
 * main window for this instance's thread, in its owner's viewer for a
 * peer's. A full open leaves the map, so it skips the flight.
 */
export const STAR_MAP_THREAD_OPEN_MODES = ["card", "full"] as const;

export type StarMapThreadOpenMode = (typeof STAR_MAP_THREAD_OPEN_MODES)[number];

/** A flight destination once the arguments have said which kind it is. */
export type StarMapFlightTarget =
  | {
      kind: "thread";
      backend: AppServerBackendKind;
      threadId: ThreadIdentifier;
      instanceId?: FederationInstanceId | string;
    }
  | {
      kind: "cloud";
      cloudKey: string;
      instanceId?: FederationInstanceId | string;
    }
  | {
      kind: "instance";
      instanceId: FederationInstanceId | string;
    };

export const STAR_MAP_FLIGHT_TARGET_KINDS = [
  "thread",
  "cloud",
  "instance",
] as const satisfies readonly StarMapFlightTarget["kind"][];

export type FlyStarMapToToolData = {
  target: StarMapFlightTarget["kind"];
  /** What the camera flew to, as the map labels it. */
  label?: string;
  /** The card was not drawn, so the flight brought it onto the map first. */
  summoned?: boolean;
  /** How the thread was opened, when the call asked for it. */
  opened?: StarMapThreadOpenMode;
};

/** A thread card, named the way every thread tool names a thread. */
export type StarMapThreadRef = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  /** The owning instance, for a peer's thread. */
  instanceId?: FederationInstanceId | string;
};

export const MAX_STAR_MAP_HIGHLIGHT_THREADS = 50;

/**
 * Ring a set of cards so the operator can see what an Agent means before it
 * acts on them. Replaces the previous highlight; `clear` drops it.
 */
export type HighlightStarMapThreadsToolArgs = {
  threads?: StarMapThreadRef[];
  clear?: boolean;
};

export type HighlightStarMapThreadsToolData = {
  /** Thread keys now ringed, in the order the call named them. */
  highlightedThreadKeys: string[];
  /** Named threads the map could not load, and so could not ring. */
  missingThreadKeys?: string[];
};

/** The map's filter chips, by the key `read_star_map_view` reports. */
export const STAR_MAP_VIEW_FILTER_KEYS = [
  "attention",
  "approval",
  "pr",
  "unpushed",
  "pinned",
  "agent",
] as const;

export type StarMapViewFilterKey = (typeof STAR_MAP_VIEW_FILTER_KEYS)[number];

/** A chip's state as an Agent sets it; `neutral` turns the chip off. */
export const STAR_MAP_VIEW_FILTER_SETTINGS = [
  "include",
  "exclude",
  "neutral",
] as const;

export type StarMapViewFilterSetting =
  (typeof STAR_MAP_VIEW_FILTER_SETTINGS)[number];

/** Change the lens and the chips, as the View menu and the chip strip do. */
export type SetStarMapViewToolArgs = {
  layout?: StarMapViewLayout;
  /** Chips to set. Chips not named keep their state. */
  filters?: Partial<Record<StarMapViewFilterKey, StarMapViewFilterSetting>>;
  /** Turn every chip off before applying `filters`. */
  clearFilters?: boolean;
  hideOfflineInstances?: boolean;
};

/** The view after the change, in the same terms `read_star_map_view` uses. */
export type SetStarMapViewToolData = {
  layout: StarMapViewLayout;
  filters: StarMapViewFilter[];
  hideOfflineInstances: boolean;
};

export type PwrAgentStarMapToolArgsByOperation = {
  read_star_map_view: ReadStarMapViewToolArgs;
  fly_star_map_to: FlyStarMapToToolArgs;
  highlight_star_map_threads: HighlightStarMapThreadsToolArgs;
  set_star_map_view: SetStarMapViewToolArgs;
};

export type PwrAgentStarMapToolArgs<
  TOperation extends PwrAgentStarMapOperationName = PwrAgentStarMapOperationName,
> = PwrAgentStarMapToolArgsByOperation[TOperation];

export type ReadStarMapViewToolData = {
  /** How stale the snapshot is; the renderer republishes as the map moves. */
  ageMs: number;
  /** Set when `maxThreads` dropped members the snapshot itself carried. */
  truncatedThreadCount?: number;
  snapshot: StarMapViewSnapshot;
};

export type PwrAgentStarMapDataByOperation = {
  read_star_map_view: ReadStarMapViewToolData;
  fly_star_map_to: FlyStarMapToToolData;
  highlight_star_map_threads: HighlightStarMapThreadsToolData;
  set_star_map_view: SetStarMapViewToolData;
};

export type PwrAgentStarMapContext = {
  now?: number;
};

export type PwrAgentStarMapRequest<
  TOperation extends PwrAgentStarMapOperationName = PwrAgentStarMapOperationName,
> = {
  [TOperationKey in TOperation]: {
    operation: TOperationKey;
    context: PwrAgentStarMapContext;
    args: PwrAgentStarMapToolArgs<TOperationKey>;
  };
}[TOperation];

export type PwrAgentStarMapResponse<
  TOperation extends PwrAgentStarMapOperationName = PwrAgentStarMapOperationName,
> =
  | {
      ok: true;
      data: PwrAgentStarMapDataByOperation[TOperation];
    }
  | {
      ok: false;
      error: {
        code: PwrAgentStarMapErrorCode;
        message: string;
      };
    };

/**
 * Main -> renderer: an Agent asked the map to do something. The map answers
 * every command exactly once, on the result channel, under the same
 * `requestId` and `kind`.
 */
export type StarMapCommand =
  | {
      requestId: string;
      kind: "fly_to";
      target: StarMapFlightTarget;
      open?: StarMapThreadOpenMode;
    }
  | {
      requestId: string;
      /** An empty list clears the highlight. */
      kind: "highlight";
      threads: StarMapThreadRef[];
    }
  | {
      requestId: string;
      kind: "set_view";
      changes: SetStarMapViewToolArgs;
    };

export type StarMapCommandKind = StarMapCommand["kind"];

/**
 * A command as a tool builds it, before the bus gives it a request id.
 * Distributes over the kinds, so the default is each command's own shape
 * rather than the few fields every command shares.
 */
export type StarMapCommandInput<
  TKind extends StarMapCommandKind = StarMapCommandKind,
> = TKind extends StarMapCommandKind
  ? Omit<Extract<StarMapCommand, { kind: TKind }>, "requestId">
  : never;

export const STAR_MAP_COMMAND_KINDS = [
  "fly_to",
  "highlight",
  "set_view",
] as const satisfies readonly StarMapCommandKind[];

/** The tool each command answers for, which fixes its answer's shape. */
export type StarMapCommandOperation = {
  fly_to: "fly_star_map_to";
  highlight: "highlight_star_map_threads";
  set_view: "set_star_map_view";
};

export type StarMapCommandResponse<
  TKind extends StarMapCommandKind = StarMapCommandKind,
> = PwrAgentStarMapResponse<StarMapCommandOperation[TKind]>;

export type StarMapCommandResult = {
  [TKind in StarMapCommandKind]: {
    requestId: string;
    kind: TKind;
    response: StarMapCommandResponse<TKind>;
  };
}[StarMapCommandKind];

/**
 * Gate on the renderer's answer. It becomes an Agent tool result verbatim,
 * so a malformed one must not reach the model as if the map had said it.
 */
export function isStarMapCommandResult(
  value: unknown,
): value is StarMapCommandResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StarMapCommandResult>;
  const response = candidate.response as
    | Partial<StarMapCommandResponse>
    | undefined;
  if (
    typeof candidate.requestId !== "string"
    || !STAR_MAP_COMMAND_KINDS.includes(candidate.kind as StarMapCommandKind)
    || typeof response !== "object"
    || response === null
  ) {
    return false;
  }
  if (response.ok === true) {
    const data = (response as { data?: unknown }).data;
    if (typeof data !== "object" || data === null) return false;
    switch (candidate.kind as StarMapCommandKind) {
      case "fly_to":
        return isFlightData(data as Partial<FlyStarMapToToolData>);
      case "highlight":
        return isHighlightData(data as Partial<HighlightStarMapThreadsToolData>);
      case "set_view":
        return isSetViewData(data as Partial<SetStarMapViewToolData>);
    }
  }
  if (response.ok === false) {
    const error = (response as { error?: { code?: unknown; message?: unknown } })
      .error;
    return (
      typeof error === "object"
      && error !== null
      && PWRAGENT_STAR_MAP_ERROR_CODES.includes(
        error.code as PwrAgentStarMapErrorCode,
      )
      && typeof error.message === "string"
    );
  }
  return false;
}

function isFlightData(data: Partial<FlyStarMapToToolData>): boolean {
  return (
    STAR_MAP_FLIGHT_TARGET_KINDS.includes(
      data.target as StarMapFlightTarget["kind"],
    )
    && (data.label === undefined || typeof data.label === "string")
    && (data.summoned === undefined || typeof data.summoned === "boolean")
    && (
      data.opened === undefined
      || STAR_MAP_THREAD_OPEN_MODES.includes(data.opened)
    )
  );
}

function isHighlightData(data: Partial<HighlightStarMapThreadsToolData>): boolean {
  return (
    isStringArray(data.highlightedThreadKeys)
    && (data.missingThreadKeys === undefined || isStringArray(data.missingThreadKeys))
  );
}

function isSetViewData(data: Partial<SetStarMapViewToolData>): boolean {
  return (
    STAR_MAP_VIEW_LAYOUTS.includes(data.layout as StarMapViewLayout)
    && typeof data.hideOfflineInstances === "boolean"
    && Array.isArray(data.filters)
    && data.filters.every(
      (filter: unknown) =>
        typeof filter === "object"
        && filter !== null
        && typeof (filter as StarMapViewFilter).key === "string"
        && typeof (filter as StarMapViewFilter).label === "string"
        && (
          (filter as StarMapViewFilter).state === "include"
          || (filter as StarMapViewFilter).state === "exclude"
        ),
    )
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value)
    && value.every((entry) => typeof entry === "string")
  );
}

function isObjectArray(value: unknown): boolean {
  return (
    Array.isArray(value)
    && value.every((entry) => typeof entry === "object" && entry !== null)
  );
}

/**
 * Gate on the IPC boundary: this lands in an Agent tool result described to
 * the model as the operator's screen, so every field the reader goes on to
 * touch is checked here rather than trusted.
 *
 * That includes the two key arrays and the element-is-an-object checks. The
 * reader filters `selectedThreadKeys` and dereferences `threads[].instanceId`
 * without a guard of its own, and the router does not wrap `dispatch`, so a
 * missing field became a TypeError escaping into the app-server request
 * handler rather than a tool error.
 */
export function isStarMapViewSnapshot(
  value: unknown,
): value is StarMapViewSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StarMapViewSnapshot>;
  return (
    typeof candidate.capturedAt === "number"
    && Number.isFinite(candidate.capturedAt)
    && (candidate.surface === "window" || candidate.surface === "in-app")
    && STAR_MAP_VIEW_LAYOUTS.includes(candidate.layout as StarMapViewLayout)
    && isObjectArray(candidate.instances)
    && isObjectArray(candidate.clouds)
    && isObjectArray(candidate.threads)
    && isStringArray(candidate.selectedThreadKeys)
    && isStringArray(candidate.openChatCardThreadKeys)
    && Array.isArray(candidate.filters)
    && typeof candidate.matchedThreadCount === "number"
    && Number.isFinite(candidate.matchedThreadCount)
    && typeof candidate.hiddenInstanceCount === "number"
    && Number.isFinite(candidate.hiddenInstanceCount)
  );
}
