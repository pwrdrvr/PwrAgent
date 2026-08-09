import {
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
  type FederationPeerSummary,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { CloseIcon } from "../../icons";
import type { DesktopApi } from "../../lib/desktop-api";
import { useCelestialIcons } from "../../lib/useCelestialIcons";
import { useFederationHealth } from "../../lib/useFederationHealth";
import {
  STAR_MAP_ATTENTION_CATEGORIES,
  STAR_MAP_ATTENTION_LABELS,
  type StarMapAttentionCategory,
  type StarMapSessionKeys,
} from "./attention";
import {
  cloudDetentRadius,
  computeCardSlots,
  computeStarMapLayout,
  generateStarField,
  STAR_MAP_BODY_ROW_Y,
  STAR_MAP_CARD_GAP,
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
  centerStarMapView,
  clampStarMapView,
  MAX_ZOOM,
  MIN_ZOOM,
} from "./star-map-view-geometry";
import { StarMapViewOptions } from "./StarMapViewOptions";
import { StarMapInstanceCard } from "./StarMapInstanceCard";
import { StarMapThreadCard } from "./StarMapThreadCard";
import { useStarMapArrangement } from "./useStarMapArrangement";
import { useStarMapThreads } from "./useStarMapThreads";

const MAX_CARDS_PER_INSTANCE = 8;
const STAR_COUNT = 130;
/** Orbit rings use a fixed card width; lanes narrow theirs to fit. */
const ORBIT_CARD_WIDTH = 200;
/** Rings hold far more than a lane column, so orbit shows deeper. */
const ORBIT_MAX_CARDS_PER_INSTANCE = 16;
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
  const stars = useMemo(() => generateStarField(STAR_COUNT), []);
  const [intakeTarget, setIntakeTarget] = useState<IntakeDialogTarget>();
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
  const [preferences, setPreferences] = useState<StarMapViewPreferences>(
    readStoredPreferences,
  );
  // Orbit places bodies on a canvas larger than the window, so the surface
  // pans and zooms rather than compressing the map to fit.
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  /**
   * Set once the operator pans or zooms. From then on the view is theirs:
   * nothing that merely changes the map's contents may move it.
   */
  const operatorMovedViewRef = useRef(false);
  const orbitMode = preferences.layout === "orbit";
  /** Projects as suns: threads pooled across instances, one body per repo. */
  const projectsMode = preferences.layout === "projects";
  /**
   * Both big-canvas lenses pan and zoom; lanes fits the window and does
   * not. Projects previously failed every one of these gates, so its
   * oversized canvas could not be navigated at all, and the centring
   * effect pinned it to the origin instead of centring it.
   */
  const panZoomMode = orbitMode || projectsMode;

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

  // Deliberately dependency-free: a card's height changes whenever its chip
  // content does, and no prop reliably signals that. The identity check
  // below is the loop guard - an unchanged measurement returns the very
  // same Map, so the state never updates and the cycle stops.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const root = viewportRef.current;
    if (!root) return;
    const measured = new Map<string, number>();
    for (const element of root.querySelectorAll<HTMLElement>(
      "[data-thread-key]",
    )) {
      const key = element.dataset.threadKey;
      if (key) measured.set(key, element.offsetHeight);
    }
    setCardHeights((current) => {
      if (
        current.size === measured.size
        && [...measured].every(([key, height]) => current.get(key) === height)
      ) {
        return current;
      }
      return measured;
    });
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
    // nothing drops the selection. Watched separately from the pan below
    // because the lanes lens has no pan to hang it off.
    watchForCanvasClick(event);
    if (!panZoomMode) return;
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
    const base = view;
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
          const clamped = clampStarMapView({
            view: { x: pointerX, y: pointerY, scale: base.scale },
            ...bounds,
          });
          canvas.style.transform =
            `translate(${clamped.x}px, ${clamped.y}px) scale(${base.scale})`;
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
      setView((current) =>
        clampStarMapView({
          view: { ...current, x: pointerX, y: pointerY },
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
      // Lanes are bounded by the window; an orbit ring grows its radius
      // instead, so it only obeys the hard cap.
      const count = orbitMode
        ? Math.min(threads.length, ORBIT_MAX_CARDS_PER_INSTANCE)
        : visibleCardCount({
            heights,
            availableHeight: viewportSize.height - STAR_MAP_BODY_ROW_Y,
            max: MAX_CARDS_PER_INSTANCE,
          });
      result.set(instanceId, { threads, heights, count });
    }
    return result;
  }, [attentionByInstance, cardHeights, orbitMode, viewportSize.height]);

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
      }));
    }
    return laneLayout.positions.map((position) => {
      const lane = lanes.get(position.instanceId);
      return {
        instanceId: position.instanceId,
        isHub: position.isHub,
        x: position.x,
        y: position.y,
        slots: computeCardSlots(lane?.heights.slice(0, lane.count) ?? []),
        cardWidth: laneLayout.cardWidth,
      };
    });
  }, [laneLayout, lanes, orbit, orbitMode]);

  const panZoomCanvas = orbitMode
    ? { width: orbit.canvasWidth, height: orbit.canvasHeight }
    : { width: projectLayout.canvasWidth, height: projectLayout.canvasHeight };

  // Trackpad: two-finger drag pans, pinch (ctrl+wheel) zooms about the
  // pointer. Registered natively because the listener must not be passive.
  // Sits below panZoomCanvas because the clamp needs the canvas size.
  useEffect(() => {
    const element = viewportRef.current;
    if (!element || !panZoomMode) return;
    const bounds = {
      canvas: { width: panZoomCanvas.width, height: panZoomCanvas.height },
      viewport: { width: viewportSize.width, height: viewportSize.height },
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey) {
        operatorMovedViewRef.current = true;
        const rect = element.getBoundingClientRect();
        const pointerX = event.clientX - rect.left;
        const pointerY = event.clientY - rect.top;
        setView((current) => {
          const scale = Math.min(
            MAX_ZOOM,
            Math.max(MIN_ZOOM, current.scale * (1 - event.deltaY / 240)),
          );
          const ratio = scale / current.scale;
          return clampStarMapView({
            view: {
              scale,
              // Keep the point under the cursor pinned while scaling.
              x: pointerX - (pointerX - current.x) * ratio,
              y: pointerY - (pointerY - current.y) * ratio,
            },
            ...bounds,
          });
        });
        return;
      }
      operatorMovedViewRef.current = true;
      setView((current) =>
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
    panZoomMode,
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
    if (!panZoomMode) {
      setView({ x: 0, y: 0, scale: 1 });
      return;
    }
    setView(
      centerStarMapView({
        canvas: { width: panZoomCanvas.width, height: panZoomCanvas.height },
        viewport: { width: viewportSize.width, height: viewportSize.height },
      }),
    );
  }, [
    panZoomMode,
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
    if (!panZoomMode) {
      setView({ x: 0, y: 0, scale: 1 });
      return;
    }
    setView(
      centerStarMapView({
        canvas: { width: panZoomCanvas.width, height: panZoomCanvas.height },
        viewport: { width: viewportSize.width, height: viewportSize.height },
      }),
    );
  }, [
    panZoomMode,
    panZoomCanvas.width,
    panZoomCanvas.height,
    viewportSize.width,
    viewportSize.height,
  ]);

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

  const cardMenuActions = useCallback(
    (
      thread: NavigationThreadSummary,
      instanceId: string,
    ): StarMapCardMenuAction[] => {
      const federationTarget =
        thread.federation?.ref.target ?? readRendererFederationTarget();
      const actions: StarMapCardMenuAction[] = [
        {
          key: "open-full",
          label: "Open in full view",
          onSelect: () => openThreadFully(thread),
        },
      ];
      if (desktopApi?.markThreadSeen && thread.inbox.inInbox) {
        actions.push({
          key: "mark-seen",
          label: "Mark as seen",
          onSelect: () => {
            void desktopApi
              .markThreadSeen?.({
                backend: thread.source,
                federationTarget,
                threadId: thread.id,
              })
              .then(() => refreshOwner(instanceId))
              .catch((error: unknown) => {
                setCardError(
                  error instanceof Error
                    ? error.message
                    : "Could not mark that thread seen.",
                );
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
          label: "Archive thread",
          onSelect: () => {
            void desktopApi
              .archiveThread?.({
                backend: thread.source,
                federationTarget,
                threadId: thread.id,
              })
              .then(() => {
                chatCards.close(
                  buildThreadIdentityKey(thread.source, thread.id),
                );
                refreshOwner(instanceId);
              })
              .catch((error: unknown) => {
                setCardError(
                  error instanceof Error
                    ? error.message
                    : "Could not archive that thread.",
                );
              });
          },
        });
      }
      return actions;
    },
    [arrangement, chatCards, desktopApi, openThreadFully, refreshOwner],
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
   */
  const cardRects = useMemo(() => {
    const rects = new Map<string, SnapRect>();
    for (const position of bodies) {
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
  }, [arrangement, bodies, lanes]);

  /**
   * Build the snap for one card. Threshold is screen-space so the pull
   * feels the same at every zoom, then converted into the canvas units the
   * geometry works in — the same reasoning as the drag threshold.
   */
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [marquee, setMarquee] = useState<SnapRect | undefined>(undefined);
  /**
   * Canvas scale for the overlays drawn inside the transform. The lanes
   * lens never scales, so it is 1 there.
   */
  const overlayScale = panZoomMode && view.scale > 0 ? view.scale : 1;

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
      const scale = panZoomMode && view.scale > 0 ? view.scale : 1;
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
    [cardRects, panZoomMode, view.scale],
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

  const snapFor = useCallback(
    (instanceId: string, threadKey: string, cardWidth: number) => {
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
      const baseSlot = index >= 0 ? body?.slots[index] : undefined;
      if (!body || !baseSlot) return undefined;

      // See the note in `cardRects`: unmeasured cards report 0, not undefined.
      const height = lane?.heights[index] || STAR_MAP_ESTIMATED_CARD_HEIGHT;
      const scale = panZoomMode && view.scale > 0 ? view.scale : 1;

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
    [bodies, cardRects, lanes, panZoomMode, selection, view.scale],
  );

  const renderCloud = (position: {
    instanceId: string;
    x: number;
    y: number;
    slots: StarMapCardSlot[];
    cardWidth: number;
  }) => {
    const lane = lanes.get(position.instanceId);
    const threads = lane?.threads ?? [];
    const heights = lane?.heights ?? [];
    const visible = threads.slice(0, lane?.count ?? 0);
    const slots = position.slots;
    // One region for the whole cloud, sized to the slots this lens drew,
    // so every card in it can reach every other card's position.
    const detentRadius = cloudDetentRadius(slots);
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
                      // Lanes never scales, so this is 1 there.
                      scale: panZoomMode ? view.scale : 1,
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
        <svg
          className="star-map__sky"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {stars.map((star, index) => (
            <circle
              key={index}
              className="star-map__star"
              cx={star.x}
              cy={star.y}
              r={star.radius * 0.08}
              fillOpacity={star.opacity}
              style={{ animationDelay: `${star.twinkleDelay}s` }}
            />
          ))}
        </svg>
        <div
          ref={canvasRef}
          className={`star-map__canvas${
            orbitMode || projectsMode ? " is-orbit" : ""
          }`}
          style={
            orbitMode
              ? {
                  width: orbit.canvasWidth,
                  height: orbit.canvasHeight,
                  transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                }
              : projectsMode
                ? {
                    width: projectLayout.canvasWidth,
                    height: projectLayout.canvasHeight,
                    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                  }
                : undefined
          }
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
                {healthy ? (
                  <path className="star-map__link-flow" d={d} />
                ) : null}
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
                onOpen={() => openInstance(position.instanceId)}
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
            setPreferences(next);
            writeStoredPreferences(next);
          }}
          onResetView={panZoomMode ? resetView : undefined}
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
