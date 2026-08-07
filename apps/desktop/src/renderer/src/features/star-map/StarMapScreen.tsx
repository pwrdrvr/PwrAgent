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
  addFilterImpactCounts,
  countAgentFilterImpact,
  countFilterImpact,
  selectAttentionThreads,
  STAR_MAP_ATTENTION_CATEGORIES,
  STAR_MAP_ATTENTION_LABELS,
  type StarMapAttentionCategory,
  type StarMapSessionKeys,
} from "./attention";
import {
  computeCardSlots,
  computeStarMapLayout,
  generateStarField,
  STAR_MAP_BODY_ROW_Y,
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
  nextAgentFilter,
  readStoredPreferences,
  writeStoredPreferences,
  STAR_MAP_AGENT_FILTER_LABELS,
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

const FILTERS_STORAGE_KEY = "pwragent.starMap.filters";
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

function readStoredFilters(): Set<StarMapAttentionCategory> {
  if (typeof window === "undefined") {
    return new Set(STAR_MAP_ATTENTION_CATEGORIES);
  }
  try {
    const raw = window.localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return new Set(STAR_MAP_ATTENTION_CATEGORIES);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(STAR_MAP_ATTENTION_CATEGORIES);
    const valid = parsed.filter(
      (entry): entry is StarMapAttentionCategory =>
        typeof entry === "string"
        && (STAR_MAP_ATTENTION_CATEGORIES as readonly string[]).includes(entry),
    );
    return new Set(valid);
  } catch {
    return new Set(STAR_MAP_ATTENTION_CATEGORIES);
  }
}

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
  const [filters, setFilters] = useState<Set<StarMapAttentionCategory>>(
    readStoredFilters,
  );
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
    if (!panZoomMode || event.button !== 0) return;
    if (!shouldStartCanvasPan(event.target)) return;
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

  const toggleFilter = useCallback((category: StarMapAttentionCategory) => {
    setFilters((current) => {
      const next = new Set(current);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      try {
        window.localStorage.setItem(
          FILTERS_STORAGE_KEY,
          JSON.stringify([...next]),
        );
      } catch {
        // Filters are per-window viewing state; losing them is harmless.
      }
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
      selectAttentionThreads({
        threads: props.localThreads.filter(
          (thread) =>
            !thread.federation
            || !isRemoteFederationTarget(thread.federation.ref.target),
        ),
        enabled: filters,
        sessionKeys: props.sessionKeys,
        agentFilter: preferences.agentFilter,
      }),
    );
    for (const [instanceId, threads] of remote.threadsByInstance) {
      result.set(
        instanceId,
        selectAttentionThreads({
          threads,
          enabled: filters,
          agentFilter: preferences.agentFilter,
        }),
      );
    }
    return result;
  }, [
    filters,
    localInstanceId,
    preferences.agentFilter,
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
        })),
      }),
    [projects],
  );

  // What the agent chip is currently holding back: cards the attention
  // filters would show but this one excludes.
  const agentFilterCount = useMemo(() => {
    let count = countAgentFilterImpact({
      threads: props.localThreads.filter(
        (thread) =>
          !thread.federation
          || !isRemoteFederationTarget(thread.federation.ref.target),
      ),
      enabled: filters,
      sessionKeys: props.sessionKeys,
      agentFilter: preferences.agentFilter,
    });
    for (const threads of remote.threadsByInstance.values()) {
      count += countAgentFilterImpact({
        threads,
        enabled: filters,
        agentFilter: preferences.agentFilter,
      });
    }
    return count;
  }, [
    filters,
    preferences.agentFilter,
    props.localThreads,
    props.sessionKeys,
    remote,
  ]);

  // Chip counts answer "how many cards does flipping this change" across
  // every lane, local session state included.
  const filterCounts = useMemo(() => {
    let counts = countFilterImpact({
      threads: props.localThreads.filter(
        (thread) =>
          !thread.federation
          || !isRemoteFederationTarget(thread.federation.ref.target),
      ),
      enabled: filters,
      sessionKeys: props.sessionKeys,
    });
    for (const threads of remote.threadsByInstance.values()) {
      counts = addFilterImpactCounts(
        counts,
        countFilterImpact({ threads, enabled: filters }),
      );
    }
    return counts;
  }, [filters, props.localThreads, props.sessionKeys, remote]);

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
    [chatCards, desktopApi, openThreadFully, refreshOwner],
  );

  const linkState = (peerId: string) => {
    const status = peerById.get(peerId)?.status
      ?? (peerId === localInstanceId ? "connected" : "disconnected");
    return status;
  };

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
              cardFields={preferences.cardFields}
              menuActions={cardMenuActions(thread, position.instanceId)}
              onCommitOffset={
                // Drags persist + sync only once the durable instance id is
                // known; before that, cards stay in their default slots.
                health?.instanceId
                  ? (offset) =>
                      arrangement.setCardPosition(
                        position.instanceId,
                        threadKey,
                        offset,
                      )
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
      <div className="star-map__filters" role="group" aria-label="Attention filters">
        {STAR_MAP_ATTENTION_CATEGORIES.map((category) => (
          <button
            key={category}
            type="button"
            className={`star-map__filter-chip${
              filters.has(category) ? " is-on" : ""
            }`}
            aria-pressed={filters.has(category)}
            onClick={() => toggleFilter(category)}
          >
            <span>{STAR_MAP_ATTENTION_LABELS[category]}</span>
            <span className="star-map__filter-count">
              {filterCounts[category]}
            </span>
          </button>
        ))}
        {/* Separate from the attention chips because it behaves
            differently: those OR together to widen the set, this ANDs on
            top to narrow it. Hence a cycle, not a toggle. */}
        <button
          type="button"
          className={`star-map__filter-chip star-map__filter-chip--agent${
            preferences.agentFilter === "all" ? "" : " is-on"
          }`}
          aria-label={`${
            STAR_MAP_AGENT_FILTER_LABELS[preferences.agentFilter]
          } — click to change`}
          onClick={() => {
            const next = {
              ...preferences,
              agentFilter: nextAgentFilter(preferences.agentFilter),
            };
            setPreferences(next);
            writeStoredPreferences(next);
          }}
        >
          <span>{STAR_MAP_AGENT_FILTER_LABELS[preferences.agentFilter]}</span>
          {agentFilterCount > 0 ? (
            <span className="star-map__filter-count">{agentFilterCount}</span>
          ) : null}
        </button>
      </div>
    </div>
  );
}
