import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
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
  cardRingExtent,
  cardRingSlots,
  computeOrbitPlacement,
  galaxyArmPath,
  shouldPanOnWheel,
  shouldStartCanvasPan,
} from "./star-map-orbit";
import {
  buildInstanceClusters,
  computeClusterCloud,
  emptyCloudMemory,
  forgetCluster,
  resolveCloudDrop,
  type StarMapClusterPlacement,
  type StarMapCloudMemory,
} from "./star-map-clusters";
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
import {
  StarMapContextCard,
  StarMapTerminalCard,
  STAR_MAP_TERMINAL_CARD_HEIGHT,
} from "./StarMapSatelliteCards";
import {
  chatCardEdgeToward,
  dockContextRect,
  dockTerminalRect,
} from "./star-map-chat-card-geometry";
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
  isOverviewZoom,
  MAX_ZOOM,
  MIN_ZOOM,
  overviewChromeScale,
  placeStarMapView,
  starMapSkyOffset,
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
/** Orbit clouds use a fixed card width; lanes narrow theirs to fit. */
const ORBIT_CARD_WIDTH = 200;
/**
 * Projects-lens ring cap: a ring crowds geometrically, so a project body
 * stays shallower than a column. The orbit lens no longer rings — its caps
 * live in star-map-clusters (per-group plus a cloud backstop), each cloud
 * carrying its own "+N more" chip instead of truncating silently.
 */
const PROJECT_MAX_CARDS_PER_BODY = 16;
/** Breathing room past the longest column / widest lane when panning. */
const LANE_CANVAS_PADDING = 120;
/**
 * Where an orbit load card parks: above the body, clear of the largest
 * body's keepout. Fixed rather than ring-derived so it cannot depend on how
 * many thread cards the rings hold.
 */
const ORBIT_LOAD_CARD_DY = -150;
/**
 * Paint layers inside one cloud. `.star-map__cloud` is positioned with a
 * z-index, so it opens a stacking context and these values are local to
 * one instance's cards.
 *
 * Thread cards take 0..n by stack position, and n is NO LONGER BOUNDED —
 * a cloud expands as far as the operator asks — so everything that must
 * paint above the stack is pinned well clear of it rather than derived
 * from a card cap. Deriving the load card's layer from the lane cap is
 * exactly how it ended up underneath the 50th card, and the CSS hover
 * raise (which must also clear the stack) had the same bug: a hovered
 * card was pushed BELOW its neighbours instead of above them.
 *
 * `.star-map__cluster-label` / `-overflow` (chrome) and
 * `.star-map-card-shell:hover` live in app.css and are pinned to these
 * numbers by star-map-z-layers.test.ts.
 */
export const STAR_MAP_CARD_MAX_Z = 4000;
export const STAR_MAP_CLOUD_CHROME_Z = 5000;
export const STAR_MAP_CARD_HOVER_Z = 6000;
const STAR_MAP_LOAD_CARD_Z = 7000;
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
 * subtree on every streamed update. The stars intentionally do not twinkle:
 * 130 independent SVG opacity animations kept Chromium painting continuously
 * even when the operator was not touching the map.
 *
 * The field is one viewport-sized tile drawn four times, 2×2, and the whole
 * sky is what `paintView` slides for the parallax — the map moves, and the
 * stars follow it a fraction of the way. Tiling is what makes that safe:
 * wrapped to one tile (`starMapSkyOffset`), the sky covers the window at
 * every offset, so no pan can ever drag a bare edge into view. Only the
 * parent's `paintView` writes the offset, through the ref, so this subtree
 * still never re-renders for a view change.
 */
const StarMapSky = memo(function StarMapSky(props: {
  ref: RefObject<SVGSVGElement | null>;
}) {
  return (
    <svg
      ref={props.ref}
      className="star-map__sky"
      viewBox="0 0 200 200"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <g id="star-map-sky-tile">
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
        </g>
      </defs>
      <use href="#star-map-sky-tile" x={0} y={0} />
      <use href="#star-map-sky-tile" x={100} y={0} />
      <use href="#star-map-sky-tile" x={0} y={100} />
      <use href="#star-map-sky-tile" x={100} y={100} />
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
  /**
   * Threads with unsent composer text in THIS window, keyed by
   * `buildThreadIdentityKey`. Applies to remote cards too — unlike
   * `sessionKeys`, a draft is local state and needs no peer to confirm it.
   */
  draftThreadKeys?: Record<string, boolean>;
  /** Fallback label for the local instance card (instanceLabel setting). */
  localInstanceLabel?: string;
  /** Open a local thread in the main window's full thread view. */
  onOpenLocalThread: (thread: NavigationThreadSummary) => void;
  /** The local instance card's open action: focus the main window. */
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
  const skyRef = useRef<SVGSVGElement>(null);
  const { health } = useFederationHealth({ desktopApi: props.desktopApi });
  const celestialIcons = useCelestialIcons({ desktopApi: props.desktopApi });
  const [filterSelection, setFilterSelection] =
    useState<StarMapFilterSelection>(() => readStoredFilterSelection());
  const [viewportSize, setViewportSize] = useState<{
    width: number;
    height: number;
  }>({ width: 1280, height: 800 });
  /**
   * The viewport size as `paintView` sees it. The sky's parallax wraps to
   * the viewport, and `paintView` runs on gesture frames outside React, so
   * it reads the measurement from a ref rather than closing over state and
   * changing identity — and every gesture's captured copy of it — on resize.
   */
  const viewportSizeRef = useRef(viewportSize);
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
  /**
   * Threads the operator archived from a card whose snapshot has not
   * caught up yet. Hidden immediately — a remote instance's feed refreshes
   * on its own cadence, and an Archive click that visibly does nothing for
   * ten seconds reads as broken. Restored on failure; released once the
   * thread leaves its source feed for real.
   */
  const [archivedThreadKeys, setArchivedThreadKeys] = useState<Set<string>>(
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
  /**
   * Project clouds the operator expanded past the per-group cap, keyed
   * `instanceId::clusterKey`. View-local like the selection: how much of a
   * cloud is unfolded is a "what am I looking at" gesture, not fleet state.
   */
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(
    new Set(),
  );
  /**
   * Last cloud layout per instance. Held in a ref rather than state: it is
   * an output of the layout that the next layout reads back, so writing it
   * must not itself schedule a render. See `StarMapCloudMemory`.
   */
  const cloudMemory = useRef(new Map<string, StarMapCloudMemory>());
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
    // The sky follows a fraction of the way behind the canvas. Written as
    // custom properties rather than a transform so the stylesheet owns the
    // transform and reduced motion can pin the sky in CSS alone.
    const sky = skyRef.current;
    if (sky) {
      const offset = starMapSkyOffset({
        view: next,
        viewport: viewportSizeRef.current,
      });
      sky.style.setProperty("--star-map-sky-x", `${offset.x}px`);
      sky.style.setProperty("--star-map-sky-y", `${offset.y}px`);
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
  /**
   * Pulled far enough out that cards are unreadable. The map draws named
   * clouds instead — legible at a glance, and a few DOM nodes instead of
   * every card in the fleet.
   */
  const overview = isOverviewZoom(view.scale);
  const chromeScale = overviewChromeScale(view.scale);
  /** Projects as suns: threads pooled across instances, one body per repo. */
  const projectsMode = preferences.layout === "projects";
  /**
   * Lanes hang from the top: bodies sit at a fixed y and their columns grow
   * downward, so a tall canvas has to open at the top edge. Centring it — as
   * the radial lenses want — would open the map already scrolled past the
   * stars and the instance bodies.
   */
  const topAnchoredView = !orbitMode && !projectsMode;

  // Focus the layer on mount so the camera keys and the Escape
  // selection-unwind work without the operator clicking into the map
  // first.
  useEffect(() => {
    layerRef.current?.focus();
  }, []);

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

  // A resize changes the tile the sky's parallax wraps to. Re-painting the
  // live view re-wraps the offset against the new size before the frame
  // shows; a stale wrap from a wider window can leave the sky short of the
  // window's right or bottom edge.
  useLayoutEffect(() => {
    viewportSizeRef.current = viewportSize;
    paintView(viewRef.current);
  }, [paintView, viewportSize]);

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
    // A press on bare sky is also how the operator LEAVES a terminal or a
    // chat composer. The pan's preventDefault below suppresses the
    // browser's default focus change, so without this the shell kept
    // focus, the flight guard kept seeing keys aimed at text, and there
    // was no way to fly again short of Escape-ing the whole map. Focus
    // moves to the layer, which is where the map's own keys listen.
    layerRef.current?.focus();
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
        threadSelection: { kind: "all" as const },
      })),
  );
  useEffect(() => {
    if (!props.desktopApi?.setFederationEventSubscriptions) return;
    const subscriptions = JSON.parse(eventSubscriptionsJson) as Array<{
      sourceInstanceId: string;
      eventClasses: Array<"navigation" | "scheduled_actions" | "star_map">;
      threadSelection: { kind: "all" };
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
    const withoutArchived = (threads: NavigationThreadSummary[]) =>
      archivedThreadKeys.size === 0
        ? threads
        : threads.filter(
            (thread) =>
              !archivedThreadKeys.has(
                buildThreadIdentityKey(thread.source, thread.id),
              ),
          );
    const result = new Map<string, NavigationThreadSummary[]>();
    // The main-window snapshot also carries viewer-side pinned REMOTE
    // threads (Cmd+K unification). Those render under their owning
    // instance's cloud via the per-peer fetch - the local cloud takes
    // locally-owned threads only, or pinned remote cards would double up.
    result.set(
      localInstanceId,
      withoutArchived(
        selectFilteredThreads({
          threads: props.localThreads.filter(
            (thread) =>
              !thread.federation
              || !isRemoteFederationTarget(thread.federation.ref.target),
          ),
          selection: filterSelection,
          sessionKeys: props.sessionKeys,
        }),
      ),
    );
    for (const [instanceId, threads] of remote.threadsByInstance) {
      result.set(
        instanceId,
        withoutArchived(
          selectFilteredThreads({ threads, selection: filterSelection }),
        ),
      );
    }
    return result;
  }, [
    archivedThreadKeys,
    filterSelection,
    localInstanceId,
    props.localThreads,
    props.sessionKeys,
    remote,
  ]);

  // Release optimistic hides once the thread has left its feed for real,
  // so a future thread reusing the key is not silently invisible.
  useEffect(() => {
    if (archivedThreadKeys.size === 0) return;
    const present = new Set<string>();
    for (const thread of props.localThreads) {
      present.add(buildThreadIdentityKey(thread.source, thread.id));
    }
    for (const threads of remote.threadsByInstance.values()) {
      for (const thread of threads) {
        present.add(buildThreadIdentityKey(thread.source, thread.id));
      }
    }
    setArchivedThreadKeys((current) => {
      const kept = [...current].filter((key) => present.has(key));
      return kept.length === current.size ? current : new Set(kept);
    });
    // Keyed on `.size` rather than the set: the guard above returns the
    // same reference when nothing is released, so identity would be a
    // stable dep too — but size makes the "runs when the set grows or
    // shrinks" intent explicit and cannot loop through its own setState.
  }, [archivedThreadKeys.size, props.localThreads, remote]);

  /**
   * Orbit-lens project clouds: each instance's threads grouped by project,
   * capped per group, and seated around the body. Undefined outside orbit
   * so the other lenses pay nothing for it.
   */
  const clusterClouds = useMemo(() => {
    if (!orbitMode) return undefined;
    const clouds = new Map<
      string,
      ReturnType<typeof computeClusterCloud>
    >();
    for (const [instanceId, threads] of attentionByInstance) {
      const prefix = `${instanceId}::`;
      const expandedKeys = new Set<string>();
      for (const entry of expandedClusters) {
        if (entry.startsWith(prefix)) {
          expandedKeys.add(entry.slice(prefix.length));
        }
      }
      const cloud = computeClusterCloud({
        clusters: buildInstanceClusters({ threads, expandedKeys }),
        cardWidth: ORBIT_CARD_WIDTH,
        heightForThread: (threadKey) =>
          cardHeights.get(threadKey) ?? STAR_MAP_ESTIMATED_CARD_HEIGHT,
        memory: cloudMemory.current.get(instanceId),
      });
      // Carrying the layout forward is what keeps an archived thread from
      // moving everything else: seats, ring allocation and cloud centres
      // all persist across the snapshot that removed it. Re-running this
      // memo with the same input is idempotent — every thread and cloud
      // simply keeps what it was just given.
      cloudMemory.current.set(instanceId, cloud.memory);
      clouds.set(instanceId, cloud);
    }
    return clouds;
  }, [attentionByInstance, cardHeights, expandedClusters, orbitMode]);

  /**
   * The anchor a hand-placed card's stored offset is measured from in the
   * cluster lens: its cloud's centre. A placed card therefore rides with
   * its cloud when the cloud re-seats, and holds its spot in the cloud
   * when cloudmates come and go — the scatter slots reflow around it
   * without touching it. Undefined outside orbit (lanes keep slot-relative
   * offsets) and for non-thread cards like the load card.
   */
  const clusterAnchorFor = useCallback(
    (instanceId: string, threadKey: string) => {
      const cloud = clusterClouds?.get(instanceId);
      if (!cloud) return undefined;
      const index = cloud.threads.findIndex(
        (thread) =>
          buildThreadIdentityKey(thread.source, thread.id) === threadKey,
      );
      if (index < 0) return undefined;
      const cluster = cloud.clusters[cloud.clusterIndexByCard[index]];
      return { slot: cloud.slots[index], center: cluster.center };
    },
    [clusterClouds],
  );

  const toggleClusterExpanded = useCallback(
    (instanceId: string, clusterKey: string) => {
      // Unfolding or folding a cloud is a request to re-fit THAT cloud, so
      // it forgets its seats and centre. Everything else keeps its layout.
      cloudMemory.current.set(
        instanceId,
        forgetCluster(
          cloudMemory.current.get(instanceId) ?? emptyCloudMemory(),
          clusterKey,
        ),
      );
      setExpandedClusters((current) => {
        const next = new Set(current);
        const key = `${instanceId}::${clusterKey}`;
        if (!next.delete(key)) next.add(key);
        return next;
      });
    },
    [],
  );

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
            PROJECT_MAX_CARDS_PER_BODY,
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
      // Orbit reads its cloud layout: the flat list is already grouped,
      // capped per cluster, and slot-aligned, so the lane triple simply
      // mirrors it. Per-cloud "+N more" chips carry the overflow.
      if (orbitMode) {
        const cloud = clusterClouds?.get(instanceId);
        result.set(instanceId, {
          threads: cloud?.threads ?? [],
          heights: cloud?.heights ?? [],
          count: cloud?.threads.length ?? 0,
        });
        continue;
      }
      const heights = threads.map(
        (thread) =>
          cardHeights.get(buildThreadIdentityKey(thread.source, thread.id))
          ?? STAR_MAP_ESTIMATED_CARD_HEIGHT,
      );
      // A lane is no longer bounded by the window: the column grows as long
      // as it needs and the operator pans and zooms into it. Truncating at
      // the fold hid curated threads that were never coming back into
      // view — the cap that remains is a DOM-size backstop, not a design
      // limit.
      const count = visibleCardCount({
        heights,
        availableHeight: Number.POSITIVE_INFINITY,
        max: LANE_MAX_CARDS_PER_INSTANCE,
      });
      result.set(instanceId, { threads, heights, count });
    }
    return result;
  }, [attentionByInstance, cardHeights, clusterClouds, orbitMode]);

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
          // Deliberately NOT counting the load card: extent is derived
          // from the cards, so including it would move every thread card
          // in the cloud the moment the load card opened.
          [...lanes].map(([instanceId, lane]) => [instanceId, lane.count]),
        ),
        cardWidth: ORBIT_CARD_WIDTH,
        // Cloud extents measured from the seated clusters, so instance
        // spacing tracks what is actually drawn rather than a ring formula.
        extents: clusterClouds
          ? new Map(
              [...clusterClouds].map(([instanceId, cloud]) => [
                instanceId,
                cloud.extent,
              ]),
            )
          : undefined,
      }),
    [clusterClouds, lanes, topology],
  );

  /** Bodies plus their card slots, in whichever space the layout uses. */
  const bodies = useMemo(() => {
    if (orbitMode) {
      return orbit.instances.map((instance) => {
        const cloud = clusterClouds?.get(instance.instanceId);
        return {
          instanceId: instance.instanceId,
          isHub: instance.isHub,
          x: instance.x,
          y: instance.y,
          // Cloud slots when the instance has a thread feed; the ring
          // fallback only ever renders zero cards (no cloud, no lane).
          slots: cloud?.slots ?? instance.cardSlots,
          clusters: cloud?.clusters,
          clusterIndexByCard: cloud?.clusterIndexByCard,
          cardWidth: ORBIT_CARD_WIDTH,
          // Above the body, at a radius that does not depend on how many
          // cards the clouds hold — so opening it disturbs nothing. Gated
          // on membership like the lanes branch: without the check the card
          // rendered forever in this lens, and dismissing it only flipped
          // the toggle that reads the same membership.
          loadSlot: loadCardInstances.has(instance.instanceId)
            ? {
                dx: 0,
                // In overview the body counter-scales, and a fixed offset
                // would leave the readout buried under it. Scaling the
                // offset by the same factor reproduces the zoom-1 layout
                // in SCREEN pixels: offset * chromeScale * view.scale is
                // the offset itself, so the pair reads exactly as it does
                // close up.
                dy: overview ? ORBIT_LOAD_CARD_DY * chromeScale : ORBIT_LOAD_CARD_DY,
              }
            : undefined,
          // Clouds grow their extent, so orbit's canvas is already sized by
          // `computeOrbitPlacement`; only lanes derive theirs from content.
          contentBottom: 0,
        };
      });
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
        // Lanes have no clouds; present for a uniform body shape so the
        // shared consumers (cardRects, renderCloud) can branch on them.
        clusters: undefined,
        clusterIndexByCard: undefined,
        cardWidth: laneLayout.cardWidth,
        loadSlot: hasLoad ? { dx: 0, dy: STAR_MAP_CLOUD_TOP } : undefined,
        contentBottom: lastSlot
          ? lastSlot.dy + (threadHeights[threadHeights.length - 1] ?? 0)
          : hasLoad
            ? STAR_MAP_CLOUD_TOP + STAR_MAP_LOAD_CARD_HEIGHT
            : 0,
      };
    });
  }, [
    chromeScale,
    clusterClouds,
    laneLayout,
    lanes,
    loadCardInstances,
    orbit,
    orbitMode,
    overview,
  ]);

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

  /** Canvas extent for callbacks defined above it (see `cardRectsRef`). */
  const canvasBoundsRef = useRef(panZoomCanvas);
  canvasBoundsRef.current = panZoomCanvas;

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
      // Pinch (ctrl+wheel) is a map gesture wherever the pointer is; a
      // plain scroll over a chat card belongs to that card's transcript.
      if (!event.ctrlKey && !shouldPanOnWheel(event.target)) return;
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
   * with nothing to do.
   */
  const heldCameraKeys = useStarMapCameraKeys({
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
  /** Threads with a chat card open, so their card can say so. */
  const chattingThreadKeys = useMemo(
    () => new Set(chatCards.cards.map((card) => card.key)),
    [chatCards.cards],
  );
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
      // Open beside the thread's own card, in map coordinates. `cardRects`
      // is read through a ref because it is declared further down; the
      // callback only ever runs after a render has computed it.
      const threadKey = buildThreadIdentityKey(thread.source, thread.id);
      let anchor: SnapRect | undefined;
      // `cardRects` is built from the lane/orbit bodies, which is NOT where
      // the projects lens draws its cards — anchoring to it there would
      // open the chat at a position unrelated to anything on screen. That
      // lens falls back to the cascade until it publishes its own rects.
      if (!projectsModeRef.current) {
        for (const [key, rect] of cardRectsRef.current) {
          if (key.endsWith(`::${threadKey}`)) {
            anchor = rect;
            break;
          }
        }
      }
      chatCards.open(
        thread,
        anchor
          ? {
              anchor: {
                height: anchor.height,
                width: anchor.width,
                x: anchor.x,
                y: anchor.y,
              },
              bounds: canvasBoundsRef.current,
            }
          : undefined,
      );
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
            const keys = targets.all.map((target) =>
              buildThreadIdentityKey(target.thread.source, target.thread.id),
            );
            // Hide the cards NOW, all of them. A remote feed refreshes on
            // its own cadence, and an Archive that visibly does nothing
            // until the next tick reads as a broken button.
            setArchivedThreadKeys((current) => {
              const next = new Set(current);
              for (const key of keys) next.add(key);
              return next;
            });
            runOnCardTargets({
              describeFailure: (failed, total) =>
                total === 1
                  ? "Could not archive that thread"
                  : `Could not archive ${failed} of ${total} threads`,
              run: (target) => {
                const threadKey = buildThreadIdentityKey(
                  target.thread.source,
                  target.thread.id,
                );
                return desktopApi
                  .archiveThread?.({
                    backend: target.thread.source,
                    federationTarget:
                      target.thread.federation?.ref.target
                      ?? readRendererFederationTarget(),
                    threadId: target.thread.id,
                  })
                  .then(() => {
                    chatCards.close(threadKey);
                    // An archived card is gone for good, unlike one a
                    // filter or a flapping instance takes off the map, so
                    // the selection drops it rather than counting it
                    // forever. Per card and on success only: a card whose
                    // archive was refused is still sitting there, and
                    // still selected.
                    dropFromSelection(target);
                  })
                  .catch((error: unknown) => {
                    // This archive did not happen; that card comes back.
                    // Per card, so one refusal out of five does not undo
                    // the four that worked.
                    setArchivedThreadKeys((current) => {
                      const next = new Set(current);
                      next.delete(threadKey);
                      return next;
                    });
                    // Rethrown so the run still counts as a failure and
                    // reports through the summary above.
                    throw error;
                  });
              },
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
        // Placed cards anchor to their cloud centre in the cluster lens —
        // the same rule the render path applies — so their rects land
        // where the cards actually paint.
        const cardCluster =
          offset !== undefined && position.clusterIndexByCard !== undefined
            ? position.clusters?.[position.clusterIndexByCard[index]]
            : undefined;
        const anchor = cardCluster
          ? { dx: cardCluster.center.x, dy: cardCluster.center.y }
          : slot;
        // `||`, not `??`: an unmeasured card reports 0, and a zero-height
        // rect is invisible to both snapping and selection.
        const height = lane.heights[index] || STAR_MAP_ESTIMATED_CARD_HEIGHT;
        rects.set(`${position.instanceId}::${threadKey}`, {
          // Cards are centred on their slot horizontally (marginLeft is
          // -width/2), so the rect's left edge is half a card back.
          x:
            position.x + anchor.dx + (offset?.dx ?? 0) - position.cardWidth / 2,
          y: position.y + anchor.dy + (offset?.dy ?? 0),
          width: position.cardWidth,
          height,
        });
      });
    }
    return rects;
  }, [arrangement, bodies, lanes, projectsMode]);

  /**
   * Latest card geometry and canvas extent, for callbacks defined above
   * them (opening a chat card beside its thread). Refs rather than deps so
   * those callbacks stay stable across every snapshot.
   */
  const cardRectsRef = useRef(cardRects);
  cardRectsRef.current = cardRects;
  const projectsModeRef = useRef(projectsMode);
  projectsModeRef.current = projectsMode;

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

  /**
   * A cloud's label pill selects its visible cards as one group, so the
   * existing group drag moves the whole cloud. Only visible cards join —
   * a hidden card has no shell to move, and a selection entry that cannot
   * be seen would surface as a card teleporting on some later expand.
   */
  const toggleClusterSelection = useCallback(
    (instanceId: string, cluster: StarMapClusterPlacement) => {
      const keys = cluster.threads
        .slice(0, cluster.visibleCount)
        .map(
          (thread) =>
            `${instanceId}::${buildThreadIdentityKey(thread.source, thread.id)}`,
        );
      if (keys.length === 0) return;
      setSelection((current) => {
        const allSelected = keys.every((key) => current.has(key));
        const next = new Set(current);
        for (const key of keys) {
          if (allSelected) next.delete(key);
          else next.add(key);
        }
        return next;
      });
    },
    [],
  );

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
        const current = arrangement.offsetFor(instanceId, threadKey);
        // A passenger placed for the first time by this group move needs
        // the same cloud-centre anchoring a directly-dragged card gets:
        // its stored offset will be read against the cloud centre, so its
        // scatter position has to be folded in before the delta.
        const anchor =
          current === undefined
            ? clusterAnchorFor(instanceId, threadKey)
            : undefined;
        const base = current
          ?? (anchor
            ? {
                dx: anchor.slot.dx - anchor.center.x,
                dy: anchor.slot.dy - anchor.center.y,
              }
            : { dx: 0, dy: 0 });
        arrangement.setCardPosition(instanceId, threadKey, {
          dx: base.dx + delta.dx,
          dy: base.dy + delta.dy,
        });
      }
    },
    [arrangement, clusterAnchorFor, selection, shellsByKey],
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
      // Everything below runs INSIDE the returned closure, which only runs
      // while a card is actually being dragged. Doing it here instead cost
      // a full pass over every card's rect — plus a thread-key rebuild per
      // lane entry — once per card per render, so a map of n cards paid
      // O(n^2) on every snapshot while nothing was being dragged at all.
      return (offset: { dx: number; dy: number }) => {
        const unchanged = { dx: offset.dx, dy: offset.dy, guides: [] };
        const selfRect = cardRects.get(selfKey);
        if (!selfRect) return unchanged;
        // A card carrying a selection must not snap to the rest of it.
        // Those cards travel rigidly with this one, so their relative
        // offset never changes and every "alignment" against them is a
        // false latch at whatever spacing the group already had.
        const passengers = selection.has(selfKey) ? selection : undefined;
        const others: SnapRect[] = [];
        for (const [key, rect] of cardRects) {
          if (key === selfKey || passengers?.has(key)) continue;
          others.push(rect);
        }
        if (others.length === 0) return unchanged;

        const body = bodies.find((entry) => entry.instanceId === instanceId);
        const lane = lanes.get(instanceId);
        const index =
          lane?.threads.findIndex(
            (thread) =>
              buildThreadIdentityKey(thread.source, thread.id) === threadKey,
          ) ?? -1;
        const baseSlot =
          override?.baseSlot ?? (index >= 0 ? body?.slots[index] : undefined);
        if (!body || !baseSlot) return unchanged;

        // See the note in `cardRects`: unmeasured cards report 0, not
        // undefined.
        const height =
          override?.height
          ?? (lane?.heights[index] || STAR_MAP_ESTIMATED_CARD_HEIGHT);
        const scale = view.scale > 0 ? view.scale : 1;
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

  /**
   * A line from each open chat card to the thread card it belongs to.
   *
   * Opening beside the source does most of the work, but a card can be
   * dragged anywhere in the galaxy afterwards — and five open chats with
   * no visible owner is the thing to avoid. Drawn inside the canvas, so
   * it pans and zooms with both of its endpoints for free.
   *
   * A chat card whose thread has no card on the map (filtered out, or
   * folded into a cloud's overflow) simply gets no tether: a line to
   * nowhere is worse than no line.
   */
  const chatTethers = useMemo(() => {
    if (chatCards.cards.length === 0 || projectsMode) return [];
    return chatCards.cards.flatMap((card) => {
      let source: SnapRect | undefined;
      for (const [key, rect] of cardRects) {
        if (key.endsWith(`::${card.key}`)) {
          source = rect;
          break;
        }
      }
      if (!source) return [];
      const target = {
        x: source.x + source.width / 2,
        y: source.y + source.height / 2,
      };
      const from = chatCardEdgeToward(card.rect, target);
      const midX = (from.x + target.x) / 2;
      const midY = (from.y + target.y) / 2;
      // A shallow arc, so the tether reads as part of the same sky as the
      // instance links rather than as a UI connector.
      const lift = 0.12;
      return [
        {
          key: card.key,
          path:
            `M ${from.x.toFixed(2)} ${from.y.toFixed(2)}`
            + ` Q ${(midX + (target.y - from.y) * lift).toFixed(2)}`
            + ` ${(midY - (target.x - from.x) * lift).toFixed(2)}`
            + ` ${target.x.toFixed(2)} ${target.y.toFixed(2)}`,
          target,
        },
      ];
    });
  }, [cardRects, chatCards.cards, projectsMode]);

  const chatTetherPaths =
    chatTethers.length > 0 ? (
      <svg
        className="star-map__tethers"
        width={panZoomCanvas.width || viewportSize.width}
        height={panZoomCanvas.height || viewportSize.height}
        aria-hidden="true"
      >
        {chatTethers.map((tether) => (
          <g key={tether.key}>
            <path className="star-map__tether" d={tether.path} />
            <circle
              className="star-map__tether-anchor"
              cx={tether.target.x}
              cy={tether.target.y}
              r={3}
            />
          </g>
        ))}
      </svg>
    ) : null;

  /**
   * A card dropped inside another cloud joins it, where "joining" is a
   * thing the data can actually express — see `resolveCloudDrop`. Only
   * parent/child membership moves: a project cloud groups on the thread's
   * workspace, and a drag does not get to relink that.
   *
   * The hand-placed offset is cleared on the way, because it was measured
   * from the OLD cloud's centre; keeping it would fling the card back out
   * of the cloud it was just dropped into.
   */
  const applyCloudDrop = useCallback(
    (params: {
      instanceId: string;
      thread: NavigationThreadSummary;
      point: { x: number; y: number };
    }): boolean => {
      const cloud = clusterClouds?.get(params.instanceId);
      if (!cloud || !desktopApi?.setThreadParent) return false;
      const drop = resolveCloudDrop({
        clusters: cloud.clusters,
        point: params.point,
        thread: params.thread,
      });
      if (drop.kind === "none") return false;

      const threadKey = buildThreadIdentityKey(
        params.thread.source,
        params.thread.id,
      );
      arrangement.setCardPosition(params.instanceId, threadKey, null);
      // The target cloud is about to gain or lose a card, so it re-fits
      // rather than trying to seat the newcomer in a shape built without
      // it. Every other cloud keeps its layout.
      cloudMemory.current.set(
        params.instanceId,
        forgetCluster(
          cloudMemory.current.get(params.instanceId) ?? emptyCloudMemory(),
          drop.clusterKey,
        ),
      );
      void desktopApi
        .setThreadParent({
          backend: params.thread.source,
          threadId: params.thread.id,
          ...(drop.kind === "adopt"
            ? {
                parentThreadId: drop.parent.id,
                parentThreadBackend: drop.parent.source,
              }
            : { parentThreadId: null, parentThreadBackend: null }),
        })
        .then(() => refreshOwner(params.instanceId))
        .catch((error: unknown) => {
          setCardError(
            error instanceof Error
              ? error.message
              : "Could not regroup that thread.",
          );
        });
      return true;
    },
    [arrangement, clusterClouds, desktopApi, refreshOwner],
  );

  const renderCloud = (position: {
    instanceId: string;
    x: number;
    y: number;
    slots: StarMapCardSlot[];
    cardWidth: number;
    /** Set when this instance shows a load card; never a thread slot. */
    loadSlot?: StarMapCardSlot;
    /** Orbit lens: project clouds with outlines, pills and overflow chips. */
    clusters?: StarMapClusterPlacement[];
    /** Cluster index per flat card, aligned with `slots`. */
    clusterIndexByCard?: number[];
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
        {/* Nebula smudges paint under the cards: same layer, earlier in
            DOM. Sized past the card extent so the glow falls off around
            the cloud instead of stopping at it. */}
        {position.clusters?.map((cluster) =>
          cluster.chromeless ? null : (
            <span
              key={`cluster-halo:${cluster.key}`}
              className="star-map__cluster-halo"
              aria-hidden="true"
              style={{
                left: cluster.center.x,
                top: cluster.center.y,
                width: cluster.extent.rx * 2.6,
                height: cluster.extent.ry * 2.7,
              }}
            />
          ),
        )}
        {loadSlot ? (
          <StarMapLoadCard
            key={`load:${position.instanceId}`}
            instanceId={position.instanceId}
            instanceLabel={instanceEntry(position.instanceId).label}
            load={instanceLoads.get(position.instanceId)}
            baseSlot={loadSlot}
            // In orbit's overview the whole position scales — offset
            // included, or a hand-placed card would sit at
            // scaledBase + rawOffset, drifting out of the group whose
            // geometry just grew around it. Display-only: drags are
            // disabled below, so a scaled offset is never committed.
            offset={(() => {
              const stored = arrangement.offsetFor(
                position.instanceId,
                STAR_MAP_LOAD_CARD_POSITION_KEY,
              );
              return stored && orbitMode && overview
                ? {
                    dx: stored.dx * chromeScale,
                    dy: stored.dy * chromeScale,
                  }
                : stored;
            })()}
            width={position.cardWidth}
            centered={orbitMode}
            // Orbit-gated: lanes shares this render path and zooms through
            // the same clamp, but nothing else in a lane scales — a card
            // counter-scaling alone there ballooned over its own column.
            scale={orbitMode && overview ? chromeScale : 1}
            stackIndex={STAR_MAP_LOAD_CARD_Z}
            sharedWith={sharedMachineLabels.get(position.instanceId)}
            cardKey={loadCardKey}
            selected={selection.has(loadCardKey)}
            onToggleSelect={() => toggleSelected(loadCardKey)}
            drag={
              // No dragging while the card is counter-scaled: a commit in
              // that state stores an offset measured against the scaled
              // base, which re-reads as a different position at zoom 1 —
              // the card would jump when the operator came back in. The
              // overview is for orientation, not arranging.
              health?.instanceId && !(orbitMode && overview)
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
        {(overview && position.clusters ? [] : visible).map((thread, index) => {
          const slot = slots[index];
          const threadKey = buildThreadIdentityKey(thread.source, thread.id);
          const storedOffset = arrangement.offsetFor(
            position.instanceId,
            threadKey,
          );
          const cardCluster =
            position.clusterIndexByCard !== undefined
              ? position.clusters?.[position.clusterIndexByCard[index]]
              : undefined;
          // A placed card anchors to its cloud's centre instead of its
          // scatter slot: cloudmates arriving or archiving away reflow the
          // scatter, and an offset over a moving slot made every arranged
          // card jump. See `clusterAnchorFor`.
          const anchored =
            cardCluster !== undefined && storedOffset !== undefined;
          const anchorSlot = anchored
            ? { dx: cardCluster.center.x, dy: cardCluster.center.y }
            : slot;
          return (
            <StarMapThreadCard
              key={threadKey}
              thread={thread}
              sessionKeys={
                position.instanceId === localInstanceId
                  ? props.sessionKeys
                  : undefined
              }
              hasUnsentDraft={props.draftThreadKeys?.[threadKey] === true}
              riseDelayMs={index * 45}
              entering={enteringThreadKeys.has(threadKey)}
              instanceIcon={celestialIcons.iconFor(
                position.instanceId === localInstanceId
                  ? undefined
                  : position.instanceId,
              )}
              baseSlot={anchorSlot}
              offset={storedOffset}
              width={position.cardWidth}
              // Cloud slots hang cards from the top like lanes; only the
              // ring fallback (which renders no cards) centred on its slot.
              centered={orbitMode && !position.clusters}
              // Clamped so a deep cloud can never reach the layers above
              // the stack (chrome, hover raise, load card).
              stackIndex={Math.min(index, STAR_MAP_CARD_MAX_Z)}
              cardKey={`${position.instanceId}::${threadKey}`}
              selected={selection.has(`${position.instanceId}::${threadKey}`)}
              chatting={chattingThreadKeys.has(threadKey)}
              onToggleSelect={() =>
                toggleSelected(`${position.instanceId}::${threadKey}`)
              }
              // Cards keep their full chip anatomy inside a cloud — the
              // cloud label groups them, it does not replace what they say.
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
                        // Anchored cards drag from the cloud centre, which
                        // the lane-slot lookup inside snapFor cannot know.
                        anchored
                          ? {
                              baseSlot: anchorSlot,
                              height:
                                heights[index]
                                ?? STAR_MAP_ESTIMATED_CARD_HEIGHT,
                            }
                          : undefined,
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
                      onCommitOffset: (offset) => {
                        // Where the card actually landed, body-relative
                        // and by its centre — a drop is about the middle
                        // of the card, not its top-left corner.
                        if (
                          cardCluster
                          && applyCloudDrop({
                            instanceId: position.instanceId,
                            point: {
                              x: anchorSlot.dx + offset.dx,
                              y:
                                anchorSlot.dy
                                + offset.dy
                                + (heights[index]
                                  ?? STAR_MAP_ESTIMATED_CARD_HEIGHT) / 2,
                            },
                            thread,
                          })
                        ) {
                          // Regrouped: the card belongs to another cloud
                          // now and `applyCloudDrop` already cleared the
                          // offset this would otherwise write back.
                          return;
                        }
                        arrangement.setCardPosition(
                          position.instanceId,
                          threadKey,
                          // First placement: the drag ran against the
                          // scatter slot, so re-express the result from
                          // the cloud centre before it persists.
                          cardCluster && !anchored
                            ? {
                                dx:
                                  slot.dx + offset.dx - cardCluster.center.x,
                                dy:
                                  slot.dy + offset.dy - cardCluster.center.y,
                              }
                            : offset,
                        );
                      },
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
        {position.clusters?.map((cluster) => {
          if (cluster.chromeless) return null;
          const clusterCardKeys = cluster.threads
            .slice(0, cluster.visibleCount)
            .map(
              (thread) =>
                `${position.instanceId}::${buildThreadIdentityKey(
                  thread.source,
                  thread.id,
                )}`,
            );
          const allSelected =
            clusterCardKeys.length > 0
            && clusterCardKeys.every((key) => selection.has(key));
          return (
            <button
              key={`cluster-label:${cluster.key}`}
              type="button"
              className={`star-map__cluster-label${
                overview ? " star-map__cluster-label--overview" : ""
              }`}
              style={{
                left: cluster.labelSlot.dx,
                // In overview the label IS the cloud, so it sits on the
                // centre rather than above the cards it is captioning, and
                // counter-scales to stay readable as the canvas shrinks.
                top: overview ? cluster.center.y : cluster.labelSlot.dy,
                ...(overview
                  ? {
                      transform: `translate(-50%, -50%) scale(${chromeScale})`,
                    }
                  : {}),
              }}
              aria-pressed={allSelected}
              aria-label={`Select the ${cluster.label} cards (${cluster.threads.length} threads)`}
              onClick={() =>
                toggleClusterSelection(position.instanceId, cluster)
              }
            >
              <span className="star-map__cluster-name">{cluster.label}</span>
              <span className="star-map__cluster-count">
                {cluster.threads.length}
              </span>
            </button>
          );
        })}
        {position.clusters?.map((cluster) =>
          cluster.overflowSlot ? (
            <button
              key={`cluster-overflow:${cluster.key}`}
              type="button"
              className="star-map__cluster-overflow"
              style={{
                left: cluster.overflowSlot.dx,
                top: cluster.overflowSlot.dy,
              }}
              aria-label={
                cluster.overflow > 0
                  ? `Show ${cluster.overflow} more ${cluster.label} threads`
                  : `Show fewer ${cluster.label} threads`
              }
              onClick={() =>
                toggleClusterExpanded(position.instanceId, cluster.key)
              }
            >
              {cluster.overflow > 0 ? `+${cluster.overflow} more` : "Show fewer"}
            </button>
          ) : null,
        )}
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
      className="star-map"
      role="region"
      aria-label="Star Map"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          // Escape unwinds the selection; with nothing left to drop it
          // deliberately does nothing. The map lives in its own OS window
          // now, and closing a whole window is the OS chrome's job — an
          // Escape that tears the window down would punish the reflexive
          // "dismiss the popover" tap.
          if (selection.size > 0) {
            setSelection(new Set());
          }
        }
      }}
    >
      <div
        ref={viewportRef}
        className="star-map__viewport"
        onPointerDown={startCanvasPan}
      >
        <StarMapSky ref={skyRef} />
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
              className={`star-map__anchor${
                overview ? " star-map__anchor--overview" : ""
              }`}
              style={{
                left: position.x,
                top: position.y,
                // In overview the body is the only thing naming the
                // machine — its cards are gone — so it counter-scales with
                // the cloud labels rather than shrinking into the sky. The
                // translate keeps it centred on its anchor point; the
                // scale is applied about that same centre.
                ...(overview
                  ? {
                      transform: `translate(-50%, -50%) scale(${chromeScale})`,
                    }
                  : {}),
              }}
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
                PROJECT_MAX_CARDS_PER_BODY,
              );
              const slots = cardRingSlots(visible.length, ORBIT_CARD_WIDTH);
              const ringOverflow = project.threads.length - visible.length;
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
                        hasUnsentDraft={
                          props.draftThreadKeys?.[threadKey] === true
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
                  {/* The ring truncates silently otherwise — the same lie
                      the orbit lens used to tell. */}
                  {ringOverflow > 0 ? (
                    <span
                      className="star-map__cloud-overflow"
                      style={{
                        transform: `translate(-50%, ${
                          cardRingExtent(visible.length, ORBIT_CARD_WIDTH).ry
                          + 24
                        }px)`,
                      }}
                    >
                      +{ringOverflow} more
                    </span>
                  ) : null}
                </div>
              );
            })
          : null}
        {chatTetherPaths}
        {/* Chat cards live INSIDE `.star-map__canvas`: they are objects in
            the galaxy, not windows over it. Panning away and coming back
            finds the open chats exactly where they were left, which is the
            whole point of opening five of them and scooting off. */}
        {chatCards.cards.map((card) => {
          const target = card.thread.federation?.ref.target;
          const cardInstanceId =
            target && isRemoteFederationTarget(target)
              ? target.instanceId
              : undefined;
          const cardZ = STAR_MAP_CHAT_CARD_BASE_Z + chatCards.depthOf(card.key);
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
              scale={view.scale}
              bounds={panZoomCanvas}
              contextOpen={card.contextOpen}
              terminalOpen={card.terminalOpen}
              onToggleContext={chatCards.toggleContext}
              onToggleTerminal={chatCards.toggleTerminal}
              zIndex={cardZ}
            />
          );
        })}
        {/* Satellites, docked to their hosts. Rects derive from the host's
            on every render, so the group moves as one for free; they hide
            with the thread cards in overview, where nothing card-sized is
            readable anyway. */}
        {overview
          ? null
          : chatCards.cards.map((card) => {
              if (!card.contextOpen && !card.terminalOpen) return null;
              const cardZ =
                STAR_MAP_CHAT_CARD_BASE_Z + chatCards.depthOf(card.key);
              return (
                <div key={`satellites:${card.key}`}>
                  {card.contextOpen ? (
                    <StarMapContextCard
                      desktopApi={props.desktopApi}
                      thread={card.thread}
                      rect={dockContextRect(card.rect)}
                      zIndex={cardZ}
                      onClose={() => chatCards.toggleContext(card.key)}
                    />
                  ) : null}
                  {card.terminalOpen ? (
                    <StarMapTerminalCard
                      desktopApi={props.desktopApi}
                      thread={card.thread}
                      threadKey={card.key}
                      rect={dockTerminalRect(card.rect, {
                        contextOpen: card.contextOpen,
                        height:
                          card.terminalHeight ?? STAR_MAP_TERMINAL_CARD_HEIGHT,
                      })}
                      zIndex={cardZ}
                      onClose={() => chatCards.toggleTerminal(card.key)}
                      onHeightChange={(height) =>
                        chatCards.setTerminalHeight(card.key, height)
                      }
                    />
                  ) : null}
                </div>
              );
            })}
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
      {/* Bottom-left: the keys the map flies with. */}
      <StarMapKeyHint held={heldCameraKeys} />
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
