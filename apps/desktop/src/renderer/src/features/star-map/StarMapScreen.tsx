import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  buildThreadIdentityKey,
  formatFederationPeerDisplayLabel,
  formatFederationPeerDisplayLabelParts,
  isRemoteFederationTarget,
  STAR_MAP_LOAD_CARD_KEY,
  STAR_MAP_LOAD_CARD_POSITION_KEY,
  type FederationPeerSummary,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { CloseIcon } from "../../icons";
import type { DesktopApi } from "../../lib/desktop-api";
import { useCelestialIcons } from "../../lib/useCelestialIcons";
import { useFederationHealth } from "../../lib/useFederationHealth";
import {
  type StarMapSessionKeys,
} from "./attention";
import {
  cloudDetentRadius,
  computeCardSlots,
  computeStarMapLayout,
  generateStarField,
  STAR_MAP_CARD_GAP,
  STAR_MAP_CLOUD_TOP,
  STAR_MAP_ESTIMATED_CARD_HEIGHT,
  visibleCardCount,
  type StarMapCardSlot,
} from "./star-map-layout";
import {
  cardRingSlots,
  computeOrbitPlacement,
  galaxyArmPath,
  shouldStartCanvasPan,
} from "./star-map-orbit";
import {
  addFilterMatchCounts,
  countFilterMatches,
  cycleFilterState,
  filterState,
  readStoredFilterSelection,
  selectFilteredThreads,
  STAR_MAP_FILTERS,
  writeStoredFilterSelection,
  type StarMapFilterKey,
  type StarMapFilterSelection,
} from "./star-map-filters";
import {
  marqueeRect,
  rectIntersects,
  resolveSnap,
  type AlignmentGuide,
  type SnapRect,
} from "./star-map-snapping";
import { buildFederationTopology } from "./star-map-topology";
import {
  groupThreadsByProject,
  instanceIdByThreadKey,
} from "./star-map-projects";
import { computeProjectLayout } from "./star-map-project-layout";
import { StarMapProjectBody } from "./StarMapProjectBody";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { StarMapChatCard } from "./StarMapChatCard";
import type { StarMapCardMenuAction } from "./StarMapCardMenu";
import { useStarMapChatCards } from "./useStarMapChatCards";
import { IntakeDialog, type IntakeDialogTarget } from "./IntakeDialog";
import {
  readStoredPreferences,
  writeStoredPreferences,
  type StarMapViewPreferences,
} from "./star-map-preferences";
import {
  clampStarMapView,
  MAX_ZOOM,
  MIN_ZOOM,
  placeStarMapView,
  type StarMapView,
} from "./star-map-view-geometry";
import { StarMapViewOptions } from "./StarMapViewOptions";
import { StarMapKeyHint } from "./StarMapKeyHint";
import { useStarMapCameraKeys } from "./useStarMapCameraKeys";
import { StarMapInstanceCard } from "./StarMapInstanceCard";
import {
  StarMapLoadCard,
  STAR_MAP_LOAD_CARD_HEIGHT,
} from "./StarMapLoadCard";
import { StarMapThreadCard } from "./StarMapThreadCard";
import { useStarMapArrangement } from "./useStarMapArrangement";
import { useStarMapInstanceLoad } from "./useStarMapInstanceLoad";
import { useStarMapThreads } from "./useStarMapThreads";

/**
 * DOM-size backstop for a lane column, not a design limit: lanes pan and
 * zoom, so a column is free to run past the fold. A fleet of five instances
 * at this ceiling is already 200 mounted cards, which is the real reason to
 * stop somewhere; past it the `+N more` badge tells the truth.
 */
const LANE_MAX_CARDS_PER_INSTANCE = 40;
const STAR_COUNT = 130;
/** Orbit rings use a fixed card width; lanes narrow theirs to fit. */
const ORBIT_CARD_WIDTH = 200;
/** A ring crowds geometrically, so orbit stays shallower than a column. */
const ORBIT_MAX_CARDS_PER_INSTANCE = 16;
/** Breathing room past the longest column / widest lane when panning. */
const LANE_CANVAS_PADDING = 120;
/**
 * Where an orbit load card parks: above the body, clear of the largest
 * body's keepout. Fixed rather than ring-derived so it cannot depend on how
 * many thread cards the rings hold.
 */
const ORBIT_LOAD_CARD_DY = -150;
/**
 * The load card paints above every thread card in its cloud. Thread cards
 * take z 0..n by stack position, so a load card left at 0 ends up UNDER the
 * cards it sits among — and an operator-summoned readout hiding behind a
 * thread card reads as a broken button.
 */
const STAR_MAP_LOAD_CARD_Z = LANE_MAX_CARDS_PER_INSTANCE + 10;
/**
 * Chat cards float above the map chrome (close button, filters, view
 * options) so a card being read is never underneath a control strip.
 */
const STAR_MAP_CHAT_CARD_BASE_Z = 40;
/**
 * How close an edge has to come before it latches, in SCREEN pixels so the
 * pull feels identical at every zoom. Wide enough to catch a deliberate
 * near-miss, tight enough that a card never latches to something the
 * operator was not aiming at.
 */
const SNAP_THRESHOLD_PX = 6;
/**
 * How far a press on empty canvas may travel and still count as a click
 * that clears the selection, rather than a pan the operator abandoned.
 */
const CANVAS_CLICK_SLOP_PX = 4;

const STAR_FIELD = generateStarField(STAR_COUNT);

/**
 * Static sky behind the live map.
 *
 * The map re-renders whenever active-thread state advances. Keeping the 130
 * circles behind a memo boundary means React does not reconcile a decorative
 * subtree on every streamed update. The stars intentionally stay still: 130
 * independent SVG opacity animations kept Chromium painting continuously even
 * when the operator was not touching the map.
 */
const StarMapSky = memo(function StarMapSky() {
  return (
    <svg
      className="star-map__sky"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {STAR_FIELD.map((star, index) => (
        <circle
          key={index}
          className="star-map__star"
          cx={star.x}
          cy={star.y}
          r={star.radius * 0.08}
          fillOpacity={star.opacity}
        />
      ))}
    </svg>
  );
});

/**
 * One card a menu action is about. The thread alone is not enough: the
 * same thread can be shown under more than one instance's cloud, and the
 * owning instance is what says which cloud has to refresh afterwards.
 */
type StarMapCardTarget = {
  instanceId: string;
  thread: NavigationThreadSummary;
};

/**
 * What one card's menu acts on: every target, and the subset an unread
 * action applies to. Resolved together because both are answers to the
 * same question — which cards is this menu about — and splitting them
 * put a per-card `filter` back in the render path.
 */
type StarMapCardTargets = {
  all: readonly StarMapCardTarget[];
  unseen: readonly StarMapCardTarget[];
};

const NO_CARD_TARGETS: readonly StarMapCardTarget[] = [];

type StarMapScreenProps = {
  desktopApi?: DesktopApi;
  /** Local navigation snapshot threads (already live in the App shell). */
  localThreads: readonly NavigationThreadSummary[];
  sessionKeys: StarMapSessionKeys;
  /** Fallback label for the local instance card (instanceLabel setting). */
  localInstanceLabel?: string;
  /** A thread is floating over the map; the map shoves left behind it. */
  floating: boolean;
  onClose: () => void;
  /** Open a local thread floating over the map. */
  onOpenLocalThread: (thread: NavigationThreadSummary) => void;
  /** The local instance card's open action: back to the thread shell. */
  onFocusLocalInstance: () => void;
  /** Refresh the App's navigation snapshot (after intake creates locally). */
  onRefreshLocalThreads?: () => void;
};

/**
 * The Star Map mission-control surface: every federation instance as a
 * celestial body on a star field, hub-and-spoke health links arcing
 * between them, and each instance's attention threads flowing down its
 * own lane. The antithesis of the left-bar thread list - pick a machine,
 * see what needs review.
 */
export function StarMapScreen(props: StarMapScreenProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const { health } = useFederationHealth({ desktopApi: props.desktopApi });
  const celestialIcons = useCelestialIcons({ desktopApi: props.desktopApi });
  const [filterSelection, setFilterSelection] =
    useState<StarMapFilterSelection>(() => readStoredFilterSelection());
  const [viewportSize, setViewportSize] = useState<{
    width: number;
    height: number;
  }>({ width: 1280, height: 800 });
  const [intakeTarget, setIntakeTarget] = useState<IntakeDialogTarget>();
  // Which instance the operator is focused on. Selection is deliberately
  // view-local and unsynced: it is a "where am I looking" gesture, not a
  // property of the fleet the way card placement is.
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>();
  // Thread keys that just bubbled in via intake — they wear the entrance
  // animation until the timer clears them.
  const [enteringThreadKeys, setEnteringThreadKeys] = useState<Set<string>>(
    new Set(),
  );
  const [remoteRefreshNonce, setRemoteRefreshNonce] = useState(0);
  // Cards vary in height with their chip rows, so lanes stack from real
  // measurements - a fixed pitch clipped tall cards mid-glyph.
  const [cardHeights, setCardHeights] = useState<Map<string, number>>(
    new Map(),
  );
  const cardResizeObserverRef = useRef<ResizeObserver | null>(null);
  const observedCardElementsRef = useRef(new Map<HTMLElement, string>());
  const [preferences, setPreferences] = useState<StarMapViewPreferences>(
    readStoredPreferences,
  );
  // Orbit places bodies on a canvas larger than the window, so the surface
  // pans and zooms rather than compressing the map to fit.
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  /**
   * Where the view is *right now*, which is not always what React state
   * says.
   *
   * Both direct-manipulation gestures — the pointer drag and the keyboard
   * camera — write the canvas transform by hand on an animation frame and
   * only commit to state when the gesture ends, because a `setView` per
   * frame re-renders every card on the map to move one transform. That
   * leaves a window where `view` is stale, and every writer has to agree on
   * a single live value or they fight: the keyboard camera used to keep a
   * private copy, so a pinch mid-flight was computed from the pre-flight
   * base and then thrown away on landing, and `0` (reset view) mid-flight
   * did nothing at all.
   *
   * So this ref is the one source of truth for "where is the view", and
   * `paintView` / `commitView` below are the only ways to move it.
   */
  const viewRef = useRef(view);
  /**
   * Set once the operator pans or zooms. From then on the view is theirs:
   * nothing that merely changes the map's contents may move it.
   */
  const operatorMovedViewRef = useRef(false);

  /**
   * Move the view without telling React. For gesture frames: writes the
   * live ref and the transform, so the next frame of any writer composes
   * on top of it rather than on a stale base.
   */
  const paintView = useCallback((next: StarMapView) => {
    viewRef.current = next;
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.style.transform =
        `translate(${next.x}px, ${next.y}px) scale(${next.scale})`;
    }
  }, []);

  /**
   * Move the view and tell React. For anything that ends a gesture or
   * happens outside one — `view.scale` feeds the card-drag detent and the
   * overlay stroke widths, so it cannot stay stale indefinitely.
   *
   * Paints as well as commits: React skips the style write when its own
   * last-rendered transform already equals the new one, which is exactly
   * the case after a run of hand-written frames. Committing alone would
   * leave the DOM showing the gesture's last frame.
   */
  const commitView = useCallback(
    (next: StarMapView) => {
      paintView(next);
      setView(next);
    },
    [paintView],
  );
  const orbitMode = preferences.layout === "orbit";
  /** Projects as suns: threads pooled across instances, one body per repo. */
  const projectsMode = preferences.layout === "projects";
  /**
   * Lanes hang from the top: bodies sit at a fixed y and their columns grow
   * downward, so a tall canvas has to open at the top edge. Centring it — as
   * the radial lenses want — would open the map already scrolled past the
   * stars and the instance bodies.
   */
  const topAnchoredView = !orbitMode && !projectsMode;

  // Focus the layer on open AND whenever the floating thread closes -
  // "Back to map" leaves focus inside <main>, and without a refocus the
  // layer's Escape-to-close handler would never hear the key again.
  useEffect(() => {
    if (!props.floating) {
      layerRef.current?.focus();
    }
  }, [props.floating]);

  // The constellation lays out in pixels of the real viewport, not
  // percentages - lanes need true widths to guarantee cards never overlap.
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setViewportSize((current) =>
          current.width === rect.width && current.height === rect.height
            ? current
            : { width: rect.width, height: rect.height },
        );
      }
    };
    measure();
    // jsdom has no ResizeObserver; the initial measure still runs there.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Card height changes are driven by the browser's layout observer rather
  // than a synchronous offsetHeight sweep after every render. Active threads
  // can update many times a second; forcing layout for every visible card on
  // each update was enough to keep the renderer hot while the map sat idle.
  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observedCardElements = observedCardElementsRef.current;
    const observer = new ResizeObserver((entries) => {
      const measured = new Map<string, number>();
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        // Ignore a notification queued before this card was unobserved.
        const key = observedCardElements.get(element);
        const height = entry.borderBoxSize[0]?.blockSize
          ?? entry.contentRect.height;
        if (key && height > 0) measured.set(key, height);
      }
      if (measured.size === 0) return;
      setCardHeights((current) => {
        if (
          [...measured].every(([key, height]) => current.get(key) === height)
        ) {
          return current;
        }
        const next = new Map(current);
        for (const [key, height] of measured) next.set(key, height);
        return next;
      });
    });
    cardResizeObserverRef.current = observer;
    return () => {
      observer.disconnect();
      cardResizeObserverRef.current = null;
      observedCardElements.clear();
    };
  }, []);

  // Reconcile observer membership after React adds or removes cards. This
  // queries the small mounted card set but deliberately reads no geometry;
  // ResizeObserver delivers the initial and subsequent border-box sizes after
  // layout without turning each live-state render into a forced reflow.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const root = viewportRef.current;
    const observer = cardResizeObserverRef.current;
    if (!root || !observer) return;
    const present = new Set<HTMLElement>();
    const presentKeys = new Set<string>();
    for (const element of root.querySelectorAll<HTMLElement>(
      "[data-thread-key]",
    )) {
      const key = element.dataset.threadKey;
      if (!key) continue;
      present.add(element);
      presentKeys.add(key);
      if (observedCardElementsRef.current.get(element) === key) continue;
      observer.unobserve(element);
      observedCardElementsRef.current.set(element, key);
      observer.observe(element);
    }

    const removedKeys = new Set<string>();
    for (const [element, key] of observedCardElementsRef.current) {
      if (present.has(element)) continue;
      observer.unobserve(element);
      observedCardElementsRef.current.delete(element);
      if (!presentKeys.has(key)) removedKeys.add(key);
    }
    if (removedKeys.size > 0) {
      setCardHeights((current) => {
        if (![...removedKeys].some((key) => current.has(key))) return current;
        const next = new Map(current);
        for (const key of removedKeys) next.delete(key);
        return next;
      });
    }
  });

  const startCanvasPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (!shouldStartCanvasPan(event.target)) return;
    // Shift sweeps a fresh selection, Cmd/Ctrl extends the one already
    // there; everything else pans.
    if (event.shiftKey) {
      startMarquee(event, "replace");
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      startMarquee(event, "add");
      return;
    }
    // A press on empty space that never travels is a click, and a click on
    // nothing drops the selection. Watched separately from the pan below so
    // the two gestures stay independent.
    watchForCanvasClick(event);
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas) return;
    event.preventDefault();
    viewport?.classList.add("is-panning");
    const startX = event.clientX;
    const startY = event.clientY;
    // Scale is captured for the whole gesture. A pinch mid-drag moves the
    // live transform out of step with it until pointerup re-reads the real
    // scale from state; the drag has always worked this way.
    // Read from the live ref, not React state: a keyboard flight may have
    // moved the view since the last commit.
    const base = viewRef.current;
    /** Latest raw pointer position, unclamped. Both writers clamp it. */
    let pointerX = base.x;
    let pointerY = base.y;
    let frame = 0;
    const bounds = { canvas: panZoomCanvas, viewport: viewportSize };
    const move = (pointerEvent: globalThis.PointerEvent) => {
      pointerX = base.x + pointerEvent.clientX - startX;
      pointerY = base.y + pointerEvent.clientY - startY;
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          // Clamped per frame, not only on release: the drag writes the
          // transform straight onto the canvas, so an unclamped live path
          // would let the map leave the window and then jump back on
          // pointerup when the clamped state landed.
          paintView(
            clampStarMapView({
              view: { x: pointerX, y: pointerY, scale: base.scale },
              ...bounds,
            }),
          );
        });
      }
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      viewport?.classList.remove("is-panning");
      operatorMovedViewRef.current = true;
      // Clamps the raw pointer position independently of the frame above,
      // rather than committing whatever that frame happened to compute.
      // The committed value is what every later gesture builds on, so it
      // has to be in bounds on its own account — and a flick released
      // before any frame ran still commits where the pointer actually
      // ended up.
      commitView(
        clampStarMapView({
          view: { ...viewRef.current, x: pointerX, y: pointerY },
          ...bounds,
        }),
      );
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const cycleFilter = useCallback((key: StarMapFilterKey) => {
    setFilterSelection((current) => {
      const next: StarMapFilterSelection = { ...current };
      const state = cycleFilterState(current[key]);
      if (state === "neutral") delete next[key];
      else next[key] = state;
      writeStoredFilterSelection(next);
      return next;
    });
  }, []);

  const localInstanceId = health?.instanceId ?? "local";
  const peers = useMemo(() => {
    const visible = (health?.peers ?? []).filter(
      (peer) => peer.status !== "revoked",
    );
    // Hiding offline instances is about the operator's own fleet noise (an
    // unused dev profile), so it only ever drops peers - the local body
    // stays on the map regardless of its own connection state.
    return preferences.hideOfflineInstances
      ? visible.filter((peer) => peer.status === "connected")
      : visible;
  }, [health, preferences.hideOfflineInstances]);
  const eventSubscriptionsJson = JSON.stringify(
    peers
      .filter(
        (peer) =>
          peer.status === "connected"
          && peer.capabilities.includes("event_subscriptions"),
      )
      .map((peer) => ({
        sourceInstanceId: peer.id,
        eventClasses: [
          ...(peer.capabilities.includes("thread_navigation")
            ? ["navigation" as const, "star_map" as const]
            : []),
          ...(peer.capabilities.includes("scheduled_actions")
            ? ["scheduled_actions" as const]
            : []),
        ],
      })),
  );
  useEffect(() => {
    if (!props.desktopApi?.setFederationEventSubscriptions) return;
    const subscriptions = JSON.parse(eventSubscriptionsJson) as Array<{
      sourceInstanceId: string;
      eventClasses: Array<"navigation" | "scheduled_actions" | "star_map">;
    }>;
    void props.desktopApi.setFederationEventSubscriptions({
      consumer: "star_map",
      subscriptions,
    });
    return () => {
      void props.desktopApi?.setFederationEventSubscriptions?.({
        consumer: "star_map",
        subscriptions: [],
      });
    };
  }, [eventSubscriptionsJson, props.desktopApi]);
  /**
   * Instances the view option is suppressing. Their threads are never
   * fetched — `useStarMapThreads` only sees the filtered peer list — so
   * an empty map caused by this setting cannot be detected by counting
   * threads. The count of hidden bodies is what we can honestly report.
   */
  const hiddenInstanceCount = useMemo(() => {
    if (!preferences.hideOfflineInstances) return 0;
    return (health?.peers ?? []).filter(
      (peer) => peer.status !== "revoked" && peer.status !== "connected",
    ).length;
  }, [health, preferences.hideOfflineInstances]);

  const remote = useStarMapThreads({
    desktopApi: props.desktopApi,
    peers,
    enabled: true,
    refreshNonce: remoteRefreshNonce,
  });
  const arrangement = useStarMapArrangement({ desktopApi: props.desktopApi });
  // Load-card membership lives in the synced arrangement, so a card opened
  // on one machine is on the map from every machine in the fleet.
  const loadCardInstanceIds = useMemo(
    () => arrangement.instancesWithCard(STAR_MAP_LOAD_CARD_KEY),
    [arrangement],
  );
  const loadCardInstances = useMemo(
    () => new Set(loadCardInstanceIds),
    [loadCardInstanceIds],
  );
  const instanceLoads = useStarMapInstanceLoad({
    desktopApi: props.desktopApi,
    instanceIds: loadCardInstanceIds,
  });
  const toggleLoadCard = useCallback(
    (instanceId: string) => {
      arrangement.setCardPosition(
        instanceId,
        STAR_MAP_LOAD_CARD_KEY,
        arrangement.isCardPlaced(instanceId, STAR_MAP_LOAD_CARD_KEY)
          ? null
          : { dx: 0, dy: 0 },
      );
    },
    [arrangement],
  );

  // The hub is the local instance unless this instance is a pure client -
  // then its enrolled gateway anchors the constellation and the local node
  // rides a lane with its siblings.
  const hubInstanceId = useMemo(() => {
    if (!health || health.role !== "client") return localInstanceId;
    const gatewayId =
      health.clientEnrollment?.gatewayInstanceId
      ?? peers.find((peer) => peer.role === "gateway")?.id;
    return gatewayId ?? localInstanceId;
  }, [health, localInstanceId, peers]);

  const laneLayout = useMemo(
    () =>
      computeStarMapLayout(
        [
          {
            instanceId: localInstanceId,
            isHub: hubInstanceId === localInstanceId,
          },
          ...peers.map((peer) => ({
            instanceId: peer.id,
            isHub: peer.id === hubInstanceId,
          })),
        ],
        viewportSize.width,
      ),
    [hubInstanceId, localInstanceId, peers, viewportSize.width],
  );

  const attentionByInstance = useMemo(() => {
    const result = new Map<string, NavigationThreadSummary[]>();
    // The main-window snapshot also carries viewer-side pinned REMOTE
    // threads (Cmd+K unification). Those render under their owning
    // instance's cloud via the per-peer fetch - the local cloud takes
    // locally-owned threads only, or pinned remote cards would double up.
    result.set(
      localInstanceId,
      selectFilteredThreads({
        threads: props.localThreads.filter(
          (thread) =>
            !thread.federation
            || !isRemoteFederationTarget(thread.federation.ref.target),
        ),
        selection: filterSelection,
        sessionKeys: props.sessionKeys,
      }),
    );
    for (const [instanceId, threads] of remote.threadsByInstance) {
      result.set(
        instanceId,
        selectFilteredThreads({ threads, selection: filterSelection }),
      );
    }
    return result;
  }, [
    filterSelection,
    localInstanceId,
    props.localThreads,
    props.sessionKeys,
    remote,
  ]);

  const projects = useMemo(
    () => groupThreadsByProject(attentionByInstance),
    [attentionByInstance],
  );

  const projectThreadOwners = useMemo(
    () => instanceIdByThreadKey(attentionByInstance),
    [attentionByInstance],
  );

  const projectLayout = useMemo(
    () =>
      computeProjectLayout({
        cardWidth: ORBIT_CARD_WIDTH,
        projects: projects.map((project) => ({
          key: project.key,
          cardCount: Math.min(
            project.threads.length,
            ORBIT_MAX_CARDS_PER_INSTANCE,
          ),
          mass: project.mass,
        })),
      }),
    [projects],
  );

  /**
   * A filtered-to-nothing map is otherwise indistinguishable from a
   * broken or still-loading one: the star field renders, and every card
   * is simply absent. The operator needs to be told it was their filter.
   */
  const matchedThreadCount = useMemo(
    () =>
      [...attentionByInstance.values()].reduce(
        (total, threads) => total + threads.length,
        0,
      ),
    [attentionByInstance],
  );
  const hasFilterSelection = Object.keys(filterSelection).length > 0;

  const clearFilters = useCallback(() => {
    setFilterSelection({});
    writeStoredFilterSelection({});
  }, []);

  const showOfflineInstances = useCallback(() => {
    setPreferences((current) => {
      const next = { ...current, hideOfflineInstances: false };
      writeStoredPreferences(next);
      return next;
    });
  }, []);

  // Chip counts answer "how many cards is this chip about", measured
  // against whatever the other facets already allow.
  const filterCounts = useMemo(() => {
    let counts = countFilterMatches({
      selection: filterSelection,
      sessionKeys: props.sessionKeys,
      threads: props.localThreads.filter(
        (thread) =>
          !thread.federation
          || !isRemoteFederationTarget(thread.federation.ref.target),
      ),
    });
    for (const threads of remote.threadsByInstance.values()) {
      counts = addFilterMatchCounts(
        counts,
        countFilterMatches({ selection: filterSelection, threads }),
      );
    }
    return counts;
  }, [filterSelection, props.localThreads, props.sessionKeys, remote]);

  const lanes = useMemo(() => {
    const result = new Map<
      string,
      { threads: NavigationThreadSummary[]; heights: number[]; count: number }
    >();
    for (const [instanceId, threads] of attentionByInstance) {
      const heights = threads.map(
        (thread) =>
          cardHeights.get(buildThreadIdentityKey(thread.source, thread.id))
          ?? STAR_MAP_ESTIMATED_CARD_HEIGHT,
      );
      // A lane is no longer bounded by the window: the column grows as long
      // as it needs and the operator pans and zooms into it, the way the
      // orbit lens already worked. Truncating at the fold hid curated
      // threads that were never coming back into view — the cap that
      // remains is a DOM-size backstop, not a design limit.
      const count = orbitMode
        ? Math.min(threads.length, ORBIT_MAX_CARDS_PER_INSTANCE)
        : visibleCardCount({
            heights,
            availableHeight: Number.POSITIVE_INFINITY,
            max: LANE_MAX_CARDS_PER_INSTANCE,
          });
      result.set(instanceId, { threads, heights, count });
    }
    return result;
  }, [attentionByInstance, cardHeights, orbitMode]);

  const topology = useMemo(
    () =>
      buildFederationTopology({
        localInstanceId,
        localRole: health?.role ?? "gateway",
        peers,
        gatewayInstanceId: health?.clientEnrollment?.gatewayInstanceId,
      }),
    [health, localInstanceId, peers],
  );

  const orbit = useMemo(
    () =>
      computeOrbitPlacement({
        nodes: topology,
        cardCounts: new Map(
          // Deliberately NOT counting the load card: ring radius is derived
          // from card count, so including it would move every thread card
          // on the ring the moment the load card opened.
          [...lanes].map(([instanceId, lane]) => [instanceId, lane.count]),
        ),
        cardWidth: ORBIT_CARD_WIDTH,
      }),
    [lanes, topology],
  );

  /** Bodies plus their card slots, in whichever space the layout uses. */
  const bodies = useMemo(() => {
    if (orbitMode) {
      return orbit.instances.map((instance) => ({
        instanceId: instance.instanceId,
        isHub: instance.isHub,
        x: instance.x,
        y: instance.y,
        slots: instance.cardSlots,
        cardWidth: ORBIT_CARD_WIDTH,
        // Above the body, at a radius that does not depend on how many
        // cards the rings hold — so opening it disturbs nothing. Gated on
        // membership like the lanes branch: without the check the card
        // rendered forever in this lens, and dismissing it only flipped the
        // toggle that reads the same membership.
        loadSlot: loadCardInstances.has(instance.instanceId)
          ? { dx: 0, dy: ORBIT_LOAD_CARD_DY }
          : undefined,
        // Rings grow their radius, so orbit's canvas is already sized by
        // `computeOrbitPlacement`; only lanes derive theirs from content.
        contentBottom: 0,
      }));
    }
    return laneLayout.positions.map((position) => {
      const lane = lanes.get(position.instanceId);
      const threadHeights = lane?.heights.slice(0, lane.count) ?? [];
      const hasLoad = loadCardInstances.has(position.instanceId);
      // Thread slots are computed as if the load card did not exist, so
      // opening it moves nothing — not the stack, and not the hand-placed
      // cards whose offsets are relative to a slot. The card lands at the
      // top of the cloud (painted above, see STAR_MAP_LOAD_CARD_Z) and the
      // operator drags it wherever they want it; that position is synced,
      // so it is a one-time move rather than a standing annoyance.
      // Appending below the column was the other collision-free option and
      // was worse: on a long column the card opened off-screen, which reads
      // as a button that does nothing.
      const slots = computeCardSlots(threadHeights);
      const lastSlot = slots[slots.length - 1];
      return {
        instanceId: position.instanceId,
        isHub: position.isHub,
        x: position.x,
        y: position.y,
        slots,
        cardWidth: laneLayout.cardWidth,
        loadSlot: hasLoad ? { dx: 0, dy: STAR_MAP_CLOUD_TOP } : undefined,
        contentBottom: lastSlot
          ? lastSlot.dy + (threadHeights[threadHeights.length - 1] ?? 0)
          : hasLoad
            ? STAR_MAP_CLOUD_TOP + STAR_MAP_LOAD_CARD_HEIGHT
            : 0,
      };
    });
  }, [laneLayout, lanes, loadCardInstances, orbit, orbitMode]);

  /**
   * Lanes canvas: as wide as the instance row and as tall as the longest
   * column, never smaller than the window so a short map still fills it.
   *
   * Lanes used to have no canvas at all — the lens rendered straight into
   * the viewport and truncated each column at the fold. Sizing it to content
   * is what lets the shared pan/zoom reach a column that runs past the
   * bottom of the screen.
   */
  const lanesCanvas = useMemo(() => {
    let right = viewportSize.width;
    let bottom = viewportSize.height;
    for (const body of bodies) {
      right = Math.max(right, body.x + body.cardWidth / 2 + LANE_CANVAS_PADDING);
      bottom = Math.max(
        bottom,
        body.y + body.contentBottom + LANE_CANVAS_PADDING,
      );
    }
    return { width: right, height: bottom };
  }, [bodies, viewportSize.height, viewportSize.width]);

  const panZoomCanvas = orbitMode
    ? { width: orbit.canvasWidth, height: orbit.canvasHeight }
    : projectsMode
      ? { width: projectLayout.canvasWidth, height: projectLayout.canvasHeight }
      : lanesCanvas;

  // Trackpad: two-finger drag pans, pinch (ctrl+wheel) zooms about the
  // pointer. Registered natively because the listener must not be passive.
  // Sits below panZoomCanvas because the clamp needs the canvas size.
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const bounds = {
      canvas: { width: panZoomCanvas.width, height: panZoomCanvas.height },
      viewport: { width: viewportSize.width, height: viewportSize.height },
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      // Both branches read the LIVE view rather than a `setView` updater's
      // `current`. During a keyboard flight the committed state is frozen at
      // the last landing, so an updater would compute this pinch from a base
      // several hundred pixels stale and then have it overwritten on the next
      // animation frame. Reading and writing the same ref lets the two
      // gestures compose: fly with WASD and pinch to zoom at the same time.
      operatorMovedViewRef.current = true;
      const current = viewRef.current;
      if (event.ctrlKey) {
        const rect = element.getBoundingClientRect();
        const pointerX = event.clientX - rect.left;
        const pointerY = event.clientY - rect.top;
        const scale = Math.min(
          MAX_ZOOM,
          Math.max(MIN_ZOOM, current.scale * (1 - event.deltaY / 240)),
        );
        const ratio = scale / current.scale;
        commitView(
          clampStarMapView({
            view: {
              scale,
              // Keep the point under the cursor pinned while scaling.
              x: pointerX - (pointerX - current.x) * ratio,
              y: pointerY - (pointerY - current.y) * ratio,
            },
            ...bounds,
          }),
        );
        return;
      }
      commitView(
        clampStarMapView({
          view: {
            ...current,
            x: current.x - event.deltaX,
            y: current.y - event.deltaY,
          },
          ...bounds,
        }),
      );
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [
    commitView,
    topAnchoredView,
    panZoomCanvas.width,
    panZoomCanvas.height,
    viewportSize.width,
    viewportSize.height,
  ]);

  // A lens switch is a different map, so the view starts centred again.
  useEffect(() => {
    operatorMovedViewRef.current = false;
  }, [preferences.layout]);

  /**
   * Centre the canvas so the operator does not open onto empty space —
   * but only while the view is still ours to place.
   *
   * The canvas size is an input here, and it changes whenever a cloud's
   * card count changes: archiving a card can drop a ring and resize the
   * whole canvas. Before the ownership check, that meant tidying up a
   * thread in one corner of the map threw away the operator's pan and
   * zoom and snapped them back to centre — the map moving under the
   * person using it.
   */
  useEffect(() => {
    if (operatorMovedViewRef.current) return;
    commitView(
      placeStarMapView({
        canvas: { width: panZoomCanvas.width, height: panZoomCanvas.height },
        viewport: { width: viewportSize.width, height: viewportSize.height },
        topAnchored: topAnchoredView,
      }),
    );
  }, [
    commitView,
    topAnchoredView,
    panZoomCanvas.width,
    panZoomCanvas.height,
    viewportSize.width,
    viewportSize.height,
  ]);

  /**
   * "Reset view": put the map back where it opens and hand ownership of the
   * view back to the app.
   *
   * Needed because the ownership rule is sticky for the life of the mounted
   * map — once the operator has moved the view, nothing else may place it.
   * That is right while they are working, but it leaves no way back from a
   * view that has drifted off the interesting part of the map, and the
   * clamp deliberately does not re-run when a cloud resizes. Clearing the
   * ref as well as re-centring means auto-centring resumes afterwards.
   */
  const resetView = useCallback(() => {
    operatorMovedViewRef.current = false;
    // commitView, not setView: `0` can be pressed mid-flight, and the
    // keyboard camera's next frame reads the live ref. Committing to state
    // alone would be silently overwritten by that frame — and, because
    // React's last-rendered transform still matched, would not even repaint.
    commitView(
      placeStarMapView({
        canvas: { width: panZoomCanvas.width, height: panZoomCanvas.height },
        viewport: { width: viewportSize.width, height: viewportSize.height },
        topAnchored: topAnchoredView,
      }),
    );
  }, [
    commitView,
    topAnchoredView,
    panZoomCanvas.width,
    panZoomCanvas.height,
    viewportSize.width,
    viewportSize.height,
  ]);

  const claimView = useCallback(() => {
    operatorMovedViewRef.current = true;
  }, []);

  /**
   * WASD / arrows fly the camera, `-` and `=` work the zoom, `0` resets.
   *
   * A map you fly over should move the way every other map you fly over
   * moves, and the pointer gestures alone leave the operator's other hand
   * with nothing to do. Disabled while a thread floats over the map: the
   * map has shoved aside and `w` belongs to the composer.
   */
  const heldCameraKeys = useStarMapCameraKeys({
    enabled: !props.floating,
    layerRef,
    liveViewRef: viewRef,
    canvas: panZoomCanvas,
    viewport: viewportSize,
    onPaint: paintView,
    onCommit: commitView,
    onMoveStart: claimView,
    onResetView: resetView,
  });

  const peerById = useMemo(
    () => new Map(peers.map((peer) => [peer.id, peer])),
    [peers],
  );

  /**
   * Display labels for every body on the map, local included. Two profiles
   * on one machine share a hostname label, so the shared formatter appends
   * "/ <profile>" whenever a label is ambiguous - the local instance has to
   * be part of that set or it cannot be told apart from its own sibling.
   */
  const displayLabelById = useMemo(() => {
    const localSummary = {
      id: localInstanceId,
      label: health?.localLabel?.trim()
        || props.localInstanceLabel?.trim()
        || "This instance",
      profileName: health?.localProfileName,
    };
    const all = [
      localSummary,
      ...peers.map((peer) => ({
        id: peer.id,
        label: peer.label,
        profileName: peer.profileName,
        revokedAt: peer.revokedAt,
      })),
    ];
    return new Map(
      all.map((entry) => [
        entry.id,
        formatFederationPeerDisplayLabel(entry, all),
      ]),
    );
  }, [health, localInstanceId, peers, props.localInstanceLabel]);

  // The instance card stacks machine and profile on separate lines to stay
  // narrow, so it needs the parts rather than the joined string.
  const displayLabelPartsById = useMemo(() => {
    const localSummary = {
      id: localInstanceId,
      label: health?.localLabel?.trim()
        || props.localInstanceLabel?.trim()
        || "This instance",
      profileName: health?.localProfileName,
    };
    const all = [
      localSummary,
      ...peers.map((peer) => ({
        id: peer.id,
        label: peer.label,
        profileName: peer.profileName,
        revokedAt: peer.revokedAt,
      })),
    ];
    return new Map(
      all.map((entry) => [
        entry.id,
        formatFederationPeerDisplayLabelParts(entry, all),
      ]),
    );
  }, [health, localInstanceId, peers, props.localInstanceLabel]);

  /**
   * Instance id → label of another instance on the same physical machine.
   * Two profiles of one box report identical load, and two cards showing
   * the same numbers reads as a bug unless the card says why.
   *
   * Peer-to-peer only: `machineId` arrives on the peer host block, and the
   * local instance does not advertise a host block to itself, so a
   * local/peer pair sharing one machine is not detected yet.
   */
  const sharedMachineLabels = useMemo(() => {
    const byMachine = new Map<string, string[]>();
    for (const peer of peers) {
      const machineId = peer.host?.machineId;
      if (!machineId || peer.revokedAt) continue;
      byMachine.set(machineId, [...(byMachine.get(machineId) ?? []), peer.id]);
    }
    const labels = new Map<string, string>();
    for (const ids of byMachine.values()) {
      if (ids.length < 2) continue;
      for (const id of ids) {
        const others = ids
          .filter((candidate) => candidate !== id)
          .map((candidate) => {
            const parts = displayLabelPartsById.get(candidate);
            return parts?.profileName ?? parts?.label ?? candidate;
          });
        labels.set(id, others.join(", "));
      }
    }
    return labels;
  }, [displayLabelPartsById, peers]);

  const chatCards = useStarMapChatCards();
  const { desktopApi, onFocusLocalInstance, onOpenLocalThread } = props;
  const openInstance = useCallback(
    (instanceId: string) => {
      if (instanceId === localInstanceId) {
        onFocusLocalInstance();
        return;
      }
      void desktopApi?.openFederationWindow?.({
        target: { scope: "remote", instanceId },
      });
    },
    [desktopApi, localInstanceId, onFocusLocalInstance],
  );

  // Thread cards float a chat card over the map rather than navigating
  // away from it: the whole point of the surface is to work across
  // instances without leaving. Cards carry their own session, so a remote
  // thread needs no pin and no snapshot merge.
  const openThread = useCallback(
    (thread: NavigationThreadSummary) => {
      chatCards.open(thread);
    },
    [chatCards],
  );

  /**
   * Escape hatch off the card and into the full thread surface, for when
   * triage turns into real work. Local threads land in this window; remote
   * ones open their owning instance's viewer, which is what the card click
   * itself used to do.
   */
  const openThreadFully = useCallback(
    (thread: NavigationThreadSummary) => {
      if (
        thread.federation
        && isRemoteFederationTarget(thread.federation.ref.target)
      ) {
        void desktopApi?.openFederationWindow?.({
          target: thread.federation.ref.target,
          initialThread: thread.federation.ref,
        });
        return;
      }
      onOpenLocalThread(thread);
    },
    [desktopApi, onOpenLocalThread],
  );

  const [cardError, setCardError] = useState<string | undefined>(undefined);

  /** Cards the operator has gathered, by card key. */
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  /** The live sweep rect, while a marquee drag is in flight. */
  const [marquee, setMarquee] = useState<SnapRect | undefined>(undefined);

  /**
   * A card key names its owning instance, and the local instance's durable
   * id only arrives with federation health — until then the local cloud is
   * keyed "local". A selection swept in that window points at a cloud that
   * no longer exists the moment health lands: the counter keeps counting,
   * no card paints as selected, and the kebab finds nothing of it to act
   * on. Drop it, the same way a card withholds dragging until the durable
   * id is known rather than persisting against the placeholder.
   */
  useEffect(() => {
    setSelection((current) => (current.size > 0 ? new Set() : current));
  }, [localInstanceId]);

  /**
   * Refresh whichever cloud owns a thread. Archive removes it from the
   * owning instance, so the map has to re-fetch rather than guess.
   */
  const refreshOwner = useCallback(
    (instanceId: string) => {
      if (instanceId === localInstanceId) {
        props.onRefreshLocalThreads?.();
      } else {
        setRemoteRefreshNonce((nonce) => nonce + 1);
      }
    },
    [localInstanceId, props],
  );

  /**
   * Every card on the map by selection key, so a set of keys can be turned
   * back into the threads it stands for. Built from the slice each lane
   * actually renders, which is the same slice a marquee can sweep.
   */
  const targetsByCardKey = useMemo(() => {
    const result = new Map<string, StarMapCardTarget>();
    for (const [instanceId, lane] of lanes) {
      for (const thread of lane.threads.slice(0, lane.count)) {
        result.set(
          `${instanceId}::${buildThreadIdentityKey(thread.source, thread.id)}`,
          { instanceId, thread },
        );
      }
    }
    return result;
  }, [lanes]);

  /**
   * The selection resolved to cards, once per render rather than once per
   * card. Every card's kebab asks this same question, so resolving it in
   * `cardMenuTargets` made the render quadratic in a selection an operator
   * can sweep to forty cards a cloud.
   */
  const selectedTargets = useMemo((): StarMapCardTargets => {
    const all: StarMapCardTarget[] = [];
    for (const key of selection) {
      // Keys that resolve to nothing are the load card, which is not a
      // thread, and cards no longer on the map — filtered out, or on an
      // instance that dropped. Both fall out of the action rather than
      // failing it; the same reasoning as `commitSelectionMove`.
      const target = targetsByCardKey.get(key);
      if (target) all.push(target);
    }
    return {
      all,
      unseen: all.filter((target) => target.thread.inbox.inInbox),
    };
  }, [selection, targetsByCardKey]);

  /**
   * The cards a kebab action applies to. A menu opened on a card that is
   * part of the selection acts on the whole selection — the same rule the
   * thread list's context menu follows — because the gesture that visibly
   * gathered five cards must not be silently discarded by the menu that
   * comes next. A menu opened on a card outside the selection acts on that
   * card alone, and leaves the selection where it was.
   */
  const cardMenuTargets = useCallback(
    (
      thread: NavigationThreadSummary,
      instanceId: string,
    ): StarMapCardTargets => {
      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
      if (
        selection.has(`${instanceId}::${threadKey}`)
        && selectedTargets.all.length > 0
      ) {
        return selectedTargets;
      }
      const self = [{ instanceId, thread }];
      return {
        all: self,
        unseen: thread.inbox.inInbox ? self : NO_CARD_TARGETS,
      };
    },
    [selectedTargets, selection],
  );

  /** Take one card out of the selection, for when it leaves for good. */
  const dropFromSelection = useCallback((target: StarMapCardTarget) => {
    const key = `${target.instanceId}::${buildThreadIdentityKey(
      target.thread.source,
      target.thread.id,
    )}`;
    setSelection((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, []);

  /**
   * Run one per-thread mutation across a menu's targets. Settles as a
   * group so a single failing card cannot cancel the rest, reports what
   * failed rather than swallowing it, and refreshes each owning cloud
   * once — including after a partial failure, where the map is now out of
   * date for whichever cards did land.
   */
  const runOnCardTargets = useCallback(
    (options: {
      /**
       * The sentence before the reason, unpunctuated. It takes the counts
       * because "could not archive" across four cards has to say how many
       * of them are still sitting there.
       */
      describeFailure: (failed: number, total: number) => string;
      run: (target: StarMapCardTarget) => Promise<unknown> | undefined;
      targets: readonly StarMapCardTarget[];
    }) => {
      const targets = [...options.targets];
      void Promise.allSettled(
        targets.map((target) => options.run(target) ?? Promise.resolve()),
      ).then((results) => {
        const failures = results.filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (failures.length > 0) {
          const summary = options.describeFailure(
            failures.length,
            targets.length,
          );
          // Only the first reason: several cards failing the same way is
          // the common case, and a stack of near-identical sentences buries
          // the count that says how much of the action survived.
          const detail =
            failures[0].reason instanceof Error
              ? failures[0].reason.message
              : undefined;
          setCardError(detail ? `${summary}: ${detail}` : `${summary}.`);
        }
        for (const instanceId of new Set(
          targets.map((target) => target.instanceId),
        )) {
          refreshOwner(instanceId);
        }
      });
    },
    [refreshOwner],
  );

  const cardMenuActions = useCallback(
    (
      thread: NavigationThreadSummary,
      instanceId: string,
    ): StarMapCardMenuAction[] => {
      const targets = cardMenuTargets(thread, instanceId);
      const actions: StarMapCardMenuAction[] = [
        {
          key: "open-full",
          // Single-target on purpose: a selection is a set of things to act
          // on, not a set of windows to open.
          label: "Open in full view",
          onSelect: () => openThreadFully(thread),
        },
      ];
      // The unread subset, not the whole selection: an already-seen card
      // has nothing to mark, and the count says so. Same shape as the
      // thread list's `bulkArchivableThreads`.
      const unseenTargets = targets.unseen;
      if (desktopApi?.markThreadSeen && unseenTargets.length > 0) {
        actions.push({
          key: "mark-seen",
          label:
            unseenTargets.length > 1
              ? `Mark ${unseenTargets.length} threads as seen`
              : "Mark as seen",
          onSelect: () => {
            runOnCardTargets({
              describeFailure: (failed, total) =>
                total === 1
                  ? "Could not mark that thread seen"
                  : `Could not mark ${failed} of ${total} threads seen`,
              run: (target) =>
                desktopApi.markThreadSeen?.({
                  backend: target.thread.source,
                  federationTarget:
                    target.thread.federation?.ref.target
                    ?? readRendererFederationTarget(),
                  threadId: target.thread.id,
                }),
              targets: unseenTargets,
            });
          },
        });
      }
      // Cards may be dragged out past the detent on purpose — an island of
      // threads off to one side — and a lane does not pan, so a card pulled
      // beyond the window has no other way back to its cloud.
      if (
        desktopApi?.setStarMapCardPosition
        && arrangement.offsetFor(
          instanceId,
          buildThreadIdentityKey(thread.source, thread.id),
        )
      ) {
        actions.push({
          key: "reset-position",
          label: "Reset position",
          onSelect: () =>
            arrangement.setCardPosition(
              instanceId,
              buildThreadIdentityKey(thread.source, thread.id),
              null,
            ),
        });
      }
      if (desktopApi?.archiveThread) {
        actions.push({
          danger: true,
          key: "archive",
          // The count is the operator's confirmation that the menu is about
          // the cards they gathered, before they commit to the one action
          // here they cannot undo from this surface.
          label:
            targets.all.length > 1
              ? `Archive ${targets.all.length} threads`
              : "Archive thread",
          onSelect: () => {
            runOnCardTargets({
              describeFailure: (failed, total) =>
                total === 1
                  ? "Could not archive that thread"
                  : `Could not archive ${failed} of ${total} threads`,
              run: (target) =>
                desktopApi
                  .archiveThread?.({
                    backend: target.thread.source,
                    federationTarget:
                      target.thread.federation?.ref.target
                      ?? readRendererFederationTarget(),
                    threadId: target.thread.id,
                  })
                  .then(() => {
                    chatCards.close(
                      buildThreadIdentityKey(
                        target.thread.source,
                        target.thread.id,
                      ),
                    );
                    // An archived card is gone for good, unlike one a
                    // filter or a flapping instance takes off the map, so
                    // the selection drops it rather than counting it
                    // forever. Per card and on success only: a card whose
                    // archive was refused is still sitting there, and
                    // still selected.
                    dropFromSelection(target);
                  }),
              targets: targets.all,
            });
          },
        });
      }
      return actions;
    },
    [
      arrangement,
      cardMenuTargets,
      chatCards,
      desktopApi,
      dropFromSelection,
      openThreadFully,
      runOnCardTargets,
    ],
  );

  const linkState = (peerId: string) => {
    const status = peerById.get(peerId)?.status
      ?? (peerId === localInstanceId ? "connected" : "disconnected");
    return status;
  };

  const [activeGuides, setActiveGuides] = useState<AlignmentGuide[]>([]);

  /**
   * Every visible card as an absolute canvas rect, keyed so a dragging
   * card can exclude itself. Absolute rather than cloud-local so cards
   * belonging to different instances can still align with each other —
   * the operator sees one map, not several coordinate systems.
   *
   * Empty under the projects lens, which draws none of these bodies: its
   * cards sit on project arms instead, and `bodies` still reports the lane
   * geometry they are NOT at. Measuring a sweep against rects nothing is
   * painted at selects cards the operator cannot see — harmless while the
   * selection only moved cards (the lens has no drag), and not harmless at
   * all now that the kebab acts on it.
   */
  const cardRects = useMemo(() => {
    const rects = new Map<string, SnapRect>();
    for (const position of projectsMode ? [] : bodies) {
      // The load card is placed by hand like any other, so it belongs in the
      // same geometry: cards align to it, guides draw against it, and a
      // marquee sweeps it up. Keyed by its POSITION entry so the shared
      // group-move commit writes to the right arrangement row.
      if (position.loadSlot) {
        const loadOffset = arrangement.offsetFor(
          position.instanceId,
          STAR_MAP_LOAD_CARD_POSITION_KEY,
        );
        rects.set(
          `${position.instanceId}::${STAR_MAP_LOAD_CARD_POSITION_KEY}`,
          {
            x:
              position.x
              + position.loadSlot.dx
              + (loadOffset?.dx ?? 0)
              - position.cardWidth / 2,
            y: position.loadSlot.dy + (loadOffset?.dy ?? 0) + position.y,
            width: position.cardWidth,
            height: STAR_MAP_LOAD_CARD_HEIGHT,
          },
        );
      }
      const lane = lanes.get(position.instanceId);
      if (!lane) continue;
      const visible = lane.threads.slice(0, lane.count);
      visible.forEach((thread, index) => {
        const slot = position.slots[index];
        if (!slot) return;
        const threadKey = buildThreadIdentityKey(thread.source, thread.id);
        const offset = arrangement.offsetFor(position.instanceId, threadKey);
        // `||`, not `??`: an unmeasured card reports 0, and a zero-height
        // rect is invisible to both snapping and selection.
        const height = lane.heights[index] || STAR_MAP_ESTIMATED_CARD_HEIGHT;
        rects.set(`${position.instanceId}::${threadKey}`, {
          // Cards are centred on their slot horizontally (marginLeft is
          // -width/2), so the rect's left edge is half a card back.
          x: position.x + slot.dx + (offset?.dx ?? 0) - position.cardWidth / 2,
          y: position.y + slot.dy + (offset?.dy ?? 0),
          width: position.cardWidth,
          height,
        });
      });
    }
    return rects;
  }, [arrangement, bodies, lanes, projectsMode]);

  /**
   * Canvas scale for the overlays drawn inside the transform. Every lens
   * scales now, lanes included, so the live value always applies.
   */
  const overlayScale = view.scale > 0 ? view.scale : 1;

  /**
   * A press on empty space that ends without travelling is a click, and a
   * click on nothing clears the selection. The slop is what separates it
   * from a pan the operator started and thought better of.
   */
  const watchForCanvasClick = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const startX = event.clientX;
      const startY = event.clientY;
      const stop = (pointerEvent: globalThis.PointerEvent) => {
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
        const travelled = Math.hypot(
          pointerEvent.clientX - startX,
          pointerEvent.clientY - startY,
        );
        if (travelled <= CANVAS_CLICK_SLOP_PX) setSelection(new Set());
      };
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    },
    [],
  );

  /**
   * Shift-drag draws a marquee; a plain drag still pans. Both are
   * click-drag on empty space, so one of them had to take a modifier, and
   * panning is the far more frequent gesture. Cmd/Ctrl-drag runs the same
   * sweep in `add` mode, so a selection can be built out of several.
   */
  const startMarquee = useCallback(
    (
      event: ReactPointerEvent<HTMLDivElement>,
      mode: "replace" | "add",
    ) => {
      const canvas = canvasRef.current;
      if (!canvas || event.button !== 0) return false;
      const rect = canvas.getBoundingClientRect();
      const scale = view.scale > 0 ? view.scale : 1;
      const toCanvas = (clientX: number, clientY: number) => ({
        x: (clientX - rect.left) / scale,
        y: (clientY - rect.top) / scale,
      });
      const origin = toCanvas(event.clientX, event.clientY);
      event.preventDefault();

      const move = (pointerEvent: globalThis.PointerEvent) => {
        setMarquee(
          marqueeRect(origin, toCanvas(pointerEvent.clientX, pointerEvent.clientY)),
        );
      };
      const stop = (pointerEvent: globalThis.PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
        const box = marqueeRect(
          origin,
          toCanvas(pointerEvent.clientX, pointerEvent.clientY),
        );
        setSelection((current) => {
          const hits = mode === "add" ? new Set(current) : new Set<string>();
          for (const [key, cardRect] of cardRects) {
            if (rectIntersects(cardRect, box)) hits.add(key);
          }
          return hits;
        });
        setMarquee(undefined);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
      return true;
    },
    [cardRects, view.scale],
  );

  /**
   * Card shells by key. Read from the DOM rather than a selector string:
   * keys contain `:` and `::`, and escaping them for an attribute selector
   * is the kind of detail that silently matches nothing.
   */
  const shellsByKey = useCallback((): Map<string, HTMLElement> => {
    const shells = new Map<string, HTMLElement>();
    for (const node of document.querySelectorAll("[data-card-key]")) {
      if (!(node instanceof HTMLElement)) continue;
      const key = node.dataset.cardKey;
      if (key) shells.set(key, node);
    }
    return shells;
  }, []);

  /**
   * Carry the rest of the selection along with the card under the pointer.
   * The DOM is written directly, the same way the dragged card moves
   * itself — a React state update per frame across N cards is exactly the
   * cost this surface cannot pay mid-drag.
   */
  const moveSelectionBy = useCallback(
    (draggedKey: string, delta: { dx: number; dy: number }) => {
      if (!selection.has(draggedKey)) return;
      const shells = shellsByKey();
      for (const key of selection) {
        if (key === draggedKey) continue;
        const shell = shells.get(key);
        if (!shell) continue;
        const origin = shell.dataset.dragOriginLeft
          ? {
              left: Number(shell.dataset.dragOriginLeft),
              top: Number(shell.dataset.dragOriginTop),
            }
          : {
              left: Number.parseFloat(shell.style.left),
              top: Number.parseFloat(shell.style.top),
            };
        shell.dataset.dragOriginLeft = String(origin.left);
        shell.dataset.dragOriginTop = String(origin.top);
        shell.style.left = `${origin.left + delta.dx}px`;
        shell.style.top = `${origin.top + delta.dy}px`;
      }
    },
    [selection, shellsByKey],
  );

  /** Modifier-click on a card: in if it was out, out if it was in. */
  const toggleSelected = useCallback((key: string) => {
    setSelection((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  const commitSelectionMove = useCallback(
    (draggedKey: string, delta: { dx: number; dy: number }) => {
      if (!selection.has(draggedKey)) return;
      const shells = shellsByKey();
      for (const key of selection) {
        if (key === draggedKey) continue;
        const shell = shells.get(key);
        // No shell means the card is not on the map right now — filtered
        // out, or on an instance that dropped. It keeps its place in the
        // selection, because an instance that flaps for twenty seconds
        // should not silently cost the operator every card it owns; but a
        // card that is not there does not move, because the offset would
        // land invisibly and only surface later.
        if (!shell) continue;
        delete shell.dataset.dragOriginLeft;
        delete shell.dataset.dragOriginTop;
        const separator = key.indexOf("::");
        if (separator < 0) continue;
        const instanceId = key.slice(0, separator);
        const threadKey = key.slice(separator + 2);
        const current = arrangement.offsetFor(instanceId, threadKey) ?? {
          dx: 0,
          dy: 0,
        };
        arrangement.setCardPosition(instanceId, threadKey, {
          dx: current.dx + delta.dx,
          dy: current.dy + delta.dy,
        });
      }
    },
    [arrangement, selection, shellsByKey],
  );

  /**
   * Build the snap for one card. Threshold is screen-space so the pull
   * feels the same at every zoom, then converted into the canvas units the
   * geometry works in — the same reasoning as the drag threshold.
   */
  const snapFor = useCallback(
    (
      instanceId: string,
      threadKey: string,
      cardWidth: number,
      // Cards outside the thread stack (the load card) know their own slot
      // and height; the lane lookup below cannot find them.
      override?: { baseSlot: StarMapCardSlot; height: number },
    ) => {
      const selfKey = `${instanceId}::${threadKey}`;
      if (!cardRects.has(selfKey)) return undefined;
      // A card carrying a selection must not snap to the rest of it. Those
      // cards travel rigidly with this one, so their relative offset never
      // changes and every "alignment" against them is a false latch at
      // whatever spacing the group already had.
      const passengers = selection.has(selfKey) ? selection : undefined;
      const others = [...cardRects.entries()]
        .filter(([key]) => key !== selfKey && !passengers?.has(key))
        .map(([, rect]) => rect);
      if (others.length === 0) return undefined;

      const body = bodies.find((entry) => entry.instanceId === instanceId);
      const lane = lanes.get(instanceId);
      const index =
        lane?.threads.findIndex(
          (thread) =>
            buildThreadIdentityKey(thread.source, thread.id) === threadKey,
        ) ?? -1;
      const baseSlot =
        override?.baseSlot ?? (index >= 0 ? body?.slots[index] : undefined);
      if (!body || !baseSlot) return undefined;

      // See the note in `cardRects`: unmeasured cards report 0, not undefined.
      const height =
        override?.height ?? (lane?.heights[index] || STAR_MAP_ESTIMATED_CARD_HEIGHT);
      const scale = view.scale > 0 ? view.scale : 1;

      return (offset: { dx: number; dy: number }) => {
        const snap = resolveSnap({
          defaultGap: STAR_MAP_CARD_GAP,
          moving: {
            // Cards are centred on their slot (marginLeft is -width/2), so
            // the rect's left edge sits half a card back.
            x: body.x + baseSlot.dx + offset.dx - cardWidth / 2,
            y: body.y + baseSlot.dy + offset.dy,
            width: cardWidth,
            height,
          },
          others,
          threshold: SNAP_THRESHOLD_PX / scale,
        });
        return {
          dx: offset.dx + snap.dx,
          dy: offset.dy + snap.dy,
          guides: snap.guides,
        };
      };
    },
    [bodies, cardRects, lanes, selection, view.scale],
  );

  const renderCloud = (position: {
    instanceId: string;
    x: number;
    y: number;
    slots: StarMapCardSlot[];
    cardWidth: number;
    /** Set when this instance shows a load card; never a thread slot. */
    loadSlot?: StarMapCardSlot;
  }) => {
    const lane = lanes.get(position.instanceId);
    const threads = lane?.threads ?? [];
    const heights = lane?.heights ?? [];
    const visible = threads.slice(0, lane?.count ?? 0);
    // Thread slots never account for the load card, so its presence cannot
    // move a thread — hand-placed or otherwise.
    const loadSlot = position.loadSlot;
    const loadCardKey = `${position.instanceId}::${STAR_MAP_LOAD_CARD_POSITION_KEY}`;
    const slots = position.slots;
    // One region for the whole cloud, sized to the slots this lens drew,
    // so every card in it can reach every other card's position. The load
    // card's slot joins the measurement without joining the thread stack.
    const detentRadius = cloudDetentRadius(
      loadSlot ? [...position.slots, loadSlot] : position.slots,
    );
    const overflow = threads.length - visible.length;
    return (
      <div
        key={`cloud:${position.instanceId}`}
        className={`star-map__cloud${
          remote.staleInstanceIds.has(position.instanceId)
            ? " star-map__cloud--stale"
            : ""
        }`}
        style={{ left: position.x, top: position.y }}
      >
        {visible.length > 0 && !orbitMode ? (
          <span
            className="star-map__cloud-halo"
            aria-hidden="true"
            style={{
              width: position.cardWidth + 56,
              height:
                (slots[slots.length - 1]?.dy ?? 0)
                + (heights[visible.length - 1] ?? 0)
                + 40,
            }}
          />
        ) : null}
        {loadSlot ? (
          <StarMapLoadCard
            key={`load:${position.instanceId}`}
            instanceId={position.instanceId}
            instanceLabel={instanceEntry(position.instanceId).label}
            load={instanceLoads.get(position.instanceId)}
            baseSlot={loadSlot}
            offset={arrangement.offsetFor(
              position.instanceId,
              STAR_MAP_LOAD_CARD_POSITION_KEY,
            )}
            width={position.cardWidth}
            centered={orbitMode}
            stackIndex={STAR_MAP_LOAD_CARD_Z}
            sharedWith={sharedMachineLabels.get(position.instanceId)}
            cardKey={loadCardKey}
            selected={selection.has(loadCardKey)}
            onToggleSelect={() => toggleSelected(loadCardKey)}
            drag={
              health?.instanceId
                ? {
                    detentRadius,
                    scale: view.scale,
                    snap: snapFor(
                      position.instanceId,
                      STAR_MAP_LOAD_CARD_POSITION_KEY,
                      position.cardWidth,
                      {
                        baseSlot: loadSlot,
                        height: STAR_MAP_LOAD_CARD_HEIGHT,
                      },
                    ),
                    onGuidesChange: setActiveGuides,
                    onGroupDelta: (delta) => moveSelectionBy(loadCardKey, delta),
                    onGroupCommit: (delta) =>
                      commitSelectionMove(loadCardKey, delta),
                    onCommitOffset: (offset) =>
                      arrangement.setCardPosition(
                        position.instanceId,
                        STAR_MAP_LOAD_CARD_POSITION_KEY,
                        offset,
                      ),
                  }
                : undefined
            }
            onDismiss={() => toggleLoadCard(position.instanceId)}
          />
        ) : null}
        {visible.map((thread, index) => {
          const slot = slots[index];
          const threadKey = buildThreadIdentityKey(thread.source, thread.id);
          return (
            <StarMapThreadCard
              key={threadKey}
              thread={thread}
              sessionKeys={
                position.instanceId === localInstanceId
                  ? props.sessionKeys
                  : undefined
              }
              riseDelayMs={index * 45}
              entering={enteringThreadKeys.has(threadKey)}
              instanceIcon={celestialIcons.iconFor(
                position.instanceId === localInstanceId
                  ? undefined
                  : position.instanceId,
              )}
              baseSlot={slot}
              offset={arrangement.offsetFor(position.instanceId, threadKey)}
              width={position.cardWidth}
              centered={orbitMode}
              stackIndex={index}
              cardKey={`${position.instanceId}::${threadKey}`}
              selected={selection.has(`${position.instanceId}::${threadKey}`)}
              onToggleSelect={() =>
                toggleSelected(`${position.instanceId}::${threadKey}`)
              }
              cardFields={preferences.cardFields}
              menuActions={cardMenuActions(thread, position.instanceId)}
              drag={
                // Drags persist + sync only once the durable instance id is
                // known; before that, cards stay in their default slots.
                health?.instanceId
                  ? {
                      detentRadius,
                      // Every lens zooms now, lanes included, so the live
                      // scale always applies.
                      scale: view.scale,
                      snap: snapFor(
                        position.instanceId,
                        threadKey,
                        position.cardWidth,
                      ),
                      onGuidesChange: setActiveGuides,
                      onGroupDelta: (delta) =>
                        moveSelectionBy(
                          `${position.instanceId}::${threadKey}`,
                          delta,
                        ),
                      onGroupCommit: (delta) =>
                        commitSelectionMove(
                          `${position.instanceId}::${threadKey}`,
                          delta,
                        ),
                      onCommitOffset: (offset) =>
                        arrangement.setCardPosition(
                          position.instanceId,
                          threadKey,
                          offset,
                        ),
                    }
                  : undefined
              }
              onOpen={openThread}
            />
          );
        })}
        {overflow > 0 && !orbitMode ? (
          <span
            className="star-map__cloud-overflow"
            style={{
              transform: `translate(-50%, ${
                (slots[slots.length - 1]?.dy ?? 0)
                + (heights[visible.length - 1] ?? 0)
                + 14
              }px)`,
            }}
          >
            +{overflow} more
          </span>
        ) : null}
      </div>
    );
  };

  const instanceEntry = (
    instanceId: string,
  ): { label: string; peer?: FederationPeerSummary } => {
    if (instanceId === localInstanceId) {
      return { label: displayLabelById.get(instanceId) ?? "This instance" };
    }
    const peer = peerById.get(instanceId);
    return {
      label: displayLabelById.get(instanceId) ?? peer?.label ?? instanceId,
      peer,
    };
  };

  return (
    <div
      ref={layerRef}
      className={`star-map${props.floating ? " star-map--floating" : ""}`}
      role="region"
      aria-label="Star Map"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          // Escape unwinds one layer at a time: drop the selection first,
          // and only close the map once there is nothing left to drop.
          if (selection.size > 0) {
            setSelection(new Set());
            return;
          }
          props.onClose();
        }
      }}
    >
      <div
        ref={viewportRef}
        className="star-map__viewport"
        onPointerDown={startCanvasPan}
      >
        <StarMapSky />
        <div
          ref={canvasRef}
          // Every lens is now a transformed canvas sized to its content —
          // lanes included, which is what makes a column longer than the
          // window reachable.
          className="star-map__canvas is-transformed"
          style={{
            width: panZoomCanvas.width,
            height: panZoomCanvas.height,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }}
        >
        {projectsMode ? null : (
        <svg
          className="star-map__links"
          viewBox={
            orbitMode
              ? `0 0 ${orbit.canvasWidth} ${orbit.canvasHeight}`
              : `0 0 ${viewportSize.width} ${viewportSize.height}`
          }
          aria-hidden="true"
        >
          {(orbitMode
            ? orbit.links.map((link) => {
                const from = orbit.instances.find(
                  (instance) => instance.instanceId === link.fromInstanceId,
                );
                const to = orbit.instances.find(
                  (instance) => instance.instanceId === link.toInstanceId,
                );
                // Orbit links sweep in as spiral arms rather than running
                // straight. Links are emitted parent -> child, so the arm
                // starts at the CHILD body and falls into `from`, its
                // parent hub — not the other way round.
                return from && to
                  ? { ...link, d: galaxyArmPath(to, from) }
                  : undefined;
              })
            : laneLayout.links.map((link) => ({
                ...link,
                d: `M ${link.path.x1} ${link.path.y1} Q ${link.path.cx} ${link.path.cy} ${link.path.x2} ${link.path.y2}`,
              }))
          ).map((link) => {
            if (!link) return null;
            const state = linkState(
              link.toInstanceId === localInstanceId
                ? link.fromInstanceId
                : link.toInstanceId,
            );
            const healthy = state === "connected";
            const pending = state === "connecting" || state === "handshaking";
            const d = link.d;
            return (
              <g key={`${link.fromInstanceId}->${link.toInstanceId}`}>
                <path
                  className={`star-map__link${
                    healthy
                      ? " star-map__link--healthy"
                      : pending
                        ? " star-map__link--pending"
                        : " star-map__link--dead"
                  }`}
                  d={d}
                />
              </g>
            );
          })}
        </svg>
        )}
        {(projectsMode ? [] : bodies).map((position) => {
          const entry = instanceEntry(position.instanceId);
          return (
            <div
              key={position.instanceId}
              className="star-map__anchor"
              style={{ left: position.x, top: position.y }}
            >
              <StarMapInstanceCard
                instanceId={position.instanceId}
                label={
                  displayLabelPartsById.get(position.instanceId)?.label
                  ?? entry.label
                }
                profileName={
                  displayLabelPartsById.get(position.instanceId)?.profileName
                }
                icon={celestialIcons.iconFor(
                  position.instanceId === localInstanceId
                    ? undefined
                    : position.instanceId,
                )}
                status={
                  position.instanceId === localInstanceId
                    ? health?.status === "disabled"
                      ? "listening"
                      : health?.status ?? "listening"
                    : entry.peer?.status ?? "disconnected"
                }
                isLocal={position.instanceId === localInstanceId}
                isHub={position.isHub}
                unreachable={remote.unreachableInstanceIds.has(
                  position.instanceId,
                )}
                selected={selectedInstanceId === position.instanceId}
                onSelect={() =>
                  setSelectedInstanceId((current) =>
                    current === position.instanceId
                      ? undefined
                      : position.instanceId,
                  )
                }
                onOpen={() => openInstance(position.instanceId)}
                onToggleLoad={
                  props.desktopApi?.readFederationInstanceLoad
                  && (position.instanceId === localInstanceId
                    || entry.peer?.status === "connected")
                    ? () => toggleLoadCard(position.instanceId)
                    : undefined
                }
                loadShown={loadCardInstances.has(position.instanceId)}
                onIntake={
                  props.desktopApi?.dispatchStarMapIntake
                  && (position.instanceId === localInstanceId
                    || entry.peer?.status === "connected")
                    ? () =>
                        setIntakeTarget({
                          instanceId: position.instanceId,
                          label: entry.label,
                          icon: celestialIcons.iconFor(
                            position.instanceId === localInstanceId
                              ? undefined
                              : position.instanceId,
                          ),
                          federationTarget:
                            position.instanceId === localInstanceId
                              ? undefined
                              : {
                                  scope: "remote",
                                  instanceId: position.instanceId,
                                },
                        })
                    : undefined
                }
              />
            </div>
          );
        })}
        {(projectsMode ? [] : bodies).map((position) => renderCloud(position))}
        {marquee ? (
          <div
            className="star-map__marquee"
            style={{
              left: marquee.x,
              top: marquee.y,
              width: marquee.width,
              height: marquee.height,
              // Drawn inside the zoomed canvas, so its edge is sized in
              // canvas units to land at a constant thickness on screen.
              borderWidth: 1 / overlayScale,
              borderRadius: 4 / overlayScale,
            }}
          />
        ) : null}
        {activeGuides.length > 0 ? (
          <svg
            className="star-map__guides"
            width={panZoomCanvas.width || viewportSize.width}
            height={panZoomCanvas.height || viewportSize.height}
            aria-hidden="true"
          >
            {activeGuides.map((guide, index) => (
              <line
                className="star-map__guide"
                key={index}
                // Same reason as the marquee's border: the canvas scale is
                // a CSS transform on an ancestor, so the stroke has to be
                // divided by it by hand.
                strokeWidth={1 / overlayScale}
                strokeDasharray={`${3 / overlayScale} ${3 / overlayScale}`}
                x1={guide.axis === "x" ? guide.at : guide.start}
                x2={guide.axis === "x" ? guide.at : guide.end}
                y1={guide.axis === "x" ? guide.start : guide.at}
                y2={guide.axis === "x" ? guide.end : guide.at}
              />
            ))}
          </svg>
        ) : null}
        {projectsMode && projectLayout.arms.length > 0 ? (
          <svg
            className="star-map__arms"
            width={projectLayout.canvasWidth}
            height={projectLayout.canvasHeight}
            aria-hidden="true"
          >
            {projectLayout.arms.map((d, index) => (
              <path className="star-map__arm" d={d} key={index} />
            ))}
          </svg>
        ) : null}
        {projectsMode
          ? projectLayout.projects.map((placement) => {
              const project = projects.find(
                (entry) => entry.key === placement.key,
              );
              if (!project) return null;
              const visible = project.threads.slice(
                0,
                ORBIT_MAX_CARDS_PER_INSTANCE,
              );
              const slots = cardRingSlots(visible.length, ORBIT_CARD_WIDTH);
              return (
                <div
                  key={`project:${placement.key}`}
                  className="star-map__project-cloud"
                  style={{ left: placement.x, top: placement.y }}
                >
                  <StarMapProjectBody
                    label={project.label}
                    projectKey={project.key}
                    threadCount={project.threads.length}
                  />
                  {visible.map((thread, index) => {
                    const threadKey = buildThreadIdentityKey(
                      thread.source,
                      thread.id,
                    );
                    // Every card here came out of `attentionByInstance`, so
                    // the owner is always present; fall back to the local
                    // instance rather than inventing an empty id.
                    const owner =
                      projectThreadOwners.get(threadKey) ?? localInstanceId;
                    return (
                      <StarMapThreadCard
                        key={threadKey}
                        thread={thread}
                        sessionKeys={
                          owner === localInstanceId
                            ? props.sessionKeys
                            : undefined
                        }
                        instanceIcon={celestialIcons.iconFor(
                          owner === localInstanceId ? undefined : owner,
                        )}
                        cardKey={`${owner ?? "project"}::${buildThreadIdentityKey(
                          thread.source,
                          thread.id,
                        )}`}
                        baseSlot={slots[index]}
                        // No drag here on purpose: arrangements are keyed
                        // and synced per federation instance, and a project
                        // is not an instance. Giving projects their own
                        // arrangement space is protocol work, so cards in
                        // this lens simply do not move rather than moving
                        // and failing to persist.
                        width={ORBIT_CARD_WIDTH}
                        centered
                        stackIndex={index}
                        // The project IS the sun here, so the project chip
                        // is redundant; the machine is what you cannot
                        // otherwise tell, so the instance chip earns its
                        // place instead.
                        cardFields={{
                          ...preferences.cardFields,
                          primaryDirectory: false,
                          secondaryDirectories: false,
                        }}
                        showInstanceChip
                        menuActions={cardMenuActions(thread, owner)}
                        onOpen={openThread}
                      />
                    );
                  })}
                </div>
              );
            })
          : null}
        </div>
      </div>
      {intakeTarget ? (
        <IntakeDialog
          desktopApi={props.desktopApi}
          target={intakeTarget}
          onClose={() => setIntakeTarget(undefined)}
          onCreated={(created) => {
            const threadKey = buildThreadIdentityKey(
              created.backend as NavigationThreadSummary["source"],
              created.threadId,
            );
            setEnteringThreadKeys((current) => new Set(current).add(threadKey));
            window.setTimeout(() => {
              setEnteringThreadKeys((current) => {
                const next = new Set(current);
                next.delete(threadKey);
                return next;
              });
            }, 2_000);
            if (created.instanceId === localInstanceId) {
              props.onRefreshLocalThreads?.();
            } else {
              setRemoteRefreshNonce((nonce) => nonce + 1);
            }
          }}
        />
      ) : null}
      {/* Chat cards sit outside `.star-map__canvas` on purpose: they are
          windows over the star field, not objects in it, so panning and
          zooming the map must not move or scale them. */}
      {chatCards.cards.map((card) => {
        const target = card.thread.federation?.ref.target;
        const cardInstanceId =
          target && isRemoteFederationTarget(target)
            ? target.instanceId
            : undefined;
        return (
          <StarMapChatCard
            key={card.key}
            cardKey={card.key}
            desktopApi={props.desktopApi}
            instanceIcon={celestialIcons.iconFor(cardInstanceId)}
            instanceLabel={
              cardInstanceId
                ? displayLabelById.get(cardInstanceId)
                : displayLabelById.get(localInstanceId ?? "")
            }
            onClose={chatCards.close}
            onOpenFull={openThreadFully}
            onRaise={chatCards.raise}
            onRectChange={chatCards.setRect}
            rect={card.rect}
            thread={card.thread}
            zIndex={STAR_MAP_CHAT_CARD_BASE_Z + chatCards.depthOf(card.key)}
          />
        );
      })}
      {cardError ? (
        <p className="star-map__card-error" role="alert">
          {cardError}
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={() => setCardError(undefined)}
          >
            ×
          </button>
        </p>
      ) : null}
      {/* The map layer covers the app chrome, including the header toggle
          that opened it, so it must carry its own way out. */}
      <button
        type="button"
        className="star-map__close"
        aria-label="Close Star Map"
        onClick={props.onClose}
      >
        <CloseIcon size={14} />
        <span>Close map</span>
      </button>
      <div className="star-map__chrome">
        {/* Same wordmark primitive as the sidebar/Settings nav so the brand
            reads identically across every window (theme-contract test). */}
        <p className="sidebar__brand">
          Pwr<span className="sidebar__brand-accent">Agent</span>
        </p>
        <StarMapViewOptions
          preferences={preferences}
          onChange={(next) => {
            // A lens change re-places every card, and one lens (projects)
            // paints no selected state at all. Carrying a selection across
            // that boundary leaves the operator holding cards they can no
            // longer point at — which the kebab would then act on.
            if (next.layout !== preferences.layout) setSelection(new Set());
            setPreferences(next);
            writeStoredPreferences(next);
          }}
          onResetView={resetView}
        />
      </div>
      {/* Two different settings can empty the map, and a blank star field
          looks identical either way. Name whichever one is responsible —
          and say nothing at all when the fleet is simply idle, because
          blaming a setting the operator did not touch is worse than
          silence. */}
      {matchedThreadCount === 0 && (hasFilterSelection || hiddenInstanceCount > 0) ? (
        <div className="star-map__empty" role="status">
          <p className="star-map__empty-title">
            {hasFilterSelection
              ? "No threads match these filters"
              : "No threads on the visible instances"}
          </p>
          {hiddenInstanceCount > 0 ? (
            <p className="star-map__empty-detail">
              {hiddenInstanceCount === 1
                ? "1 offline instance is hidden"
                : `${hiddenInstanceCount} offline instances are hidden`}
            </p>
          ) : null}
          <span className="star-map__empty-actions">
            {hasFilterSelection ? (
              <button
                type="button"
                className="star-map__empty-action"
                onClick={clearFilters}
              >
                Clear filters
              </button>
            ) : null}
            {hiddenInstanceCount > 0 ? (
              <button
                type="button"
                className="star-map__empty-action"
                onClick={showOfflineInstances}
              >
                Show offline instances
              </button>
            ) : null}
          </span>
        </div>
      ) : null}
      {/* Bottom-left: the keys the map flies with. Hidden while a thread
          floats over the map, because the camera is off then. */}
      {props.floating ? null : <StarMapKeyHint held={heldCameraKeys} />}
      {/* The only thing on the surface that admits a selection exists.
          `role="status"` so the count is heard, not just seen — the cards
          themselves carry no selected state to a screen reader. */}
      {selection.size > 0 ? (
        <div className="star-map__selection" role="status" aria-live="polite">
          <span>
            {selection.size === 1 ? "1 card selected" : `${selection.size} cards selected`}
          </span>
          <span className="star-map__selection-hint" aria-hidden="true">
            drag to move · ⇧-click to amend
          </span>
          <button
            type="button"
            className="star-map__selection-clear"
            onClick={() => setSelection(new Set())}
          >
            Clear
          </button>
        </div>
      ) : null}
      <div className="star-map__filters" role="group" aria-label="Thread filters">
        {STAR_MAP_FILTERS.map((definition) => {
          const state = filterState(filterSelection, definition.key);
          const next =
            state === "neutral"
              ? "show only these"
              : state === "include"
                ? "hide these instead"
                : "stop filtering on this";
          return (
            <button
              key={definition.key}
              type="button"
              className={`star-map__filter-chip star-map__filter-chip--${state}`}
              // Tri-state, so `aria-pressed` cannot describe it: exclude is
              // neither pressed nor unpressed. The label carries the state
              // and what the next click does.
              aria-label={`${definition.label}: ${
                state === "neutral"
                  ? "not filtered"
                  : state === "include"
                    ? "showing only these"
                    : "hidden"
              } — click to ${next}`}
              onClick={() => cycleFilter(definition.key)}
            >
              {state === "exclude" ? (
                <span className="star-map__filter-mark" aria-hidden="true">
                  −
                </span>
              ) : null}
              <span>{definition.label}</span>
              <span className="star-map__filter-count">
                {filterCounts[definition.key]}
              </span>
            </button>
          );
        })}
        {hasFilterSelection ? (
          <button
            type="button"
            className="star-map__filter-clear"
            onClick={clearFilters}
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}
