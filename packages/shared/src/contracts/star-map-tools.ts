import type {
  AppServerBackendKind,
  ThreadIdentifier,
} from "./normalized-app-server";
import type { FederationInstanceId } from "./federation";

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
  "capture_star_map",
] as const;

export type PwrAgentStarMapOperationName =
  (typeof PWRAGENT_STAR_MAP_OPERATION_NAMES)[number];

export const PWRAGENT_STAR_MAP_ERROR_CODES = [
  "invalid_arguments",
  "star_map_not_open",
  "capture_failed",
  "unsupported_operation",
  "internal_error",
] as const;

export type PwrAgentStarMapErrorCode =
  (typeof PWRAGENT_STAR_MAP_ERROR_CODES)[number];

/** Mirrors the renderer's `StarMapLayoutMode`; the publisher assigns across. */
export type StarMapViewLayout = "lanes" | "orbit" | "projects";

/** Which surface published the snapshot, since both can be open at once. */
export type StarMapViewSurface = "window" | "in-app";

export type StarMapViewRect = {
  /** Map-space, not screen-space: the camera below converts. */
  x: number;
  y: number;
  width: number;
  height: number;
};

export type StarMapViewCamera = {
  x: number;
  y: number;
  /** 1 is unzoomed. Screen = (map + camera) * scale. */
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
  threadCount: number;
  visibleCount: number;
  /** Folded behind the cloud's `+N more` chip. */
  hiddenCount: number;
  /** Every member in the cloud's own order, drawn and folded alike. */
  threadKeys: string[];
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
  /** A floating chat card on the map is open on this thread. */
  chatCardOpen: boolean;
  /** Map-space card rect; absent while the card is folded away. */
  rect?: StarMapViewRect;
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
  /** Threads surviving the current filters, across every instance. */
  matchedThreadCount: number;
};

export const DEFAULT_STAR_MAP_VIEW_MAX_THREADS = 200;
export const MAX_STAR_MAP_VIEW_MAX_THREADS = 1_000;
/** Capture cost is quadratic in the long edge; 1600 keeps titles legible. */
export const DEFAULT_STAR_MAP_CAPTURE_MAX_WIDTH = 1_600;
export const MAX_STAR_MAP_CAPTURE_MAX_WIDTH = 3_000;
/**
 * Ceiling on the encoded PNG. Base64 adds about a third on top of this
 * before the image reaches the model, so a wide capture of a dense map is
 * capable of dwarfing the turn it was meant to inform.
 */
export const MAX_STAR_MAP_CAPTURE_BYTES = 4 * 1_024 * 1_024;

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

export type CaptureStarMapToolArgs = {
  /**
   * Downscale the capture to this width in pixels. The structured view is
   * cheaper and more precise for anything but genuinely spatial questions.
   */
  maxWidth?: number;
};

export type PwrAgentStarMapToolArgsByOperation = {
  read_star_map_view: ReadStarMapViewToolArgs;
  capture_star_map: CaptureStarMapToolArgs;
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

export type CaptureStarMapToolData = {
  surface: StarMapViewSurface;
  width: number;
  height: number;
  /** PNG bytes; delivered as an image content item where the transport allows. */
  byteLength: number;
  /** Set when the transport can only carry text back to the model. */
  imageUnavailableReason?: string;
};

export type PwrAgentStarMapDataByOperation = {
  read_star_map_view: ReadStarMapViewToolData;
  capture_star_map: CaptureStarMapToolData;
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
      /** Base64 PNG for `capture_star_map`, kept out of `data` so a text-only
       * transport can drop it without reshaping the payload. */
      imageBase64?: string;
      imageMimeType?: string;
    }
  | {
      ok: false;
      error: {
        code: PwrAgentStarMapErrorCode;
        message: string;
      };
    };

export function isStarMapViewSnapshot(
  value: unknown,
): value is StarMapViewSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StarMapViewSnapshot>;
  return (
    typeof candidate.capturedAt === "number"
    && Number.isFinite(candidate.capturedAt)
    && (candidate.surface === "window" || candidate.surface === "in-app")
    && typeof candidate.layout === "string"
    && Array.isArray(candidate.instances)
    && Array.isArray(candidate.clouds)
    && Array.isArray(candidate.threads)
  );
}
