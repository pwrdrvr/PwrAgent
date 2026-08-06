import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildThreadIdentityKey,
  formatFederationPeerDisplayLabel,
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
  type StarMapInstancePosition,
} from "./star-map-layout";
import { IntakeDialog, type IntakeDialogTarget } from "./IntakeDialog";
import { StarMapInstanceCard } from "./StarMapInstanceCard";
import { StarMapThreadCard } from "./StarMapThreadCard";
import { useStarMapArrangement } from "./useStarMapArrangement";
import { useStarMapThreads } from "./useStarMapThreads";

const FILTERS_STORAGE_KEY = "pwragent.starMap.filters";
const MAX_CARDS_PER_INSTANCE = 8;
const STAR_COUNT = 130;

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
  const peers = useMemo(
    () =>
      (health?.peers ?? []).filter((peer) => peer.status !== "revoked"),
    [health],
  );
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

  const layout = useMemo(
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
      }),
    );
    for (const [instanceId, threads] of remote.threadsByInstance) {
      result.set(
        instanceId,
        selectAttentionThreads({ threads, enabled: filters }),
      );
    }
    return result;
  }, [filters, localInstanceId, props.localThreads, props.sessionKeys, remote]);

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

  const openThread = useCallback(
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

  const linkState = (peerId: string) => {
    const status = peerById.get(peerId)?.status
      ?? (peerId === localInstanceId ? "connected" : "disconnected");
    return status;
  };

  const renderCloud = (position: StarMapInstancePosition) => {
    const threads = attentionByInstance.get(position.instanceId) ?? [];
    const heights = threads.map(
      (thread) =>
        cardHeights.get(buildThreadIdentityKey(thread.source, thread.id))
        ?? STAR_MAP_ESTIMATED_CARD_HEIGHT,
    );
    // Only as many cards as actually fit between the body row and the
    // bottom of the window; the rest roll into "+N more".
    const count = visibleCardCount({
      heights,
      availableHeight: viewportSize.height - STAR_MAP_BODY_ROW_Y,
      max: MAX_CARDS_PER_INSTANCE,
    });
    const visible = threads.slice(0, count);
    const slots = computeCardSlots(heights.slice(0, count));
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
        {visible.length > 0 ? (
          <span
            className="star-map__cloud-halo"
            aria-hidden="true"
            style={{
              width: layout.cardWidth + 56,
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
              width={layout.cardWidth}
              stackIndex={index}
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
        {overflow > 0 ? (
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
      <div ref={viewportRef} className="star-map__viewport">
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
        <svg
          className="star-map__links"
          viewBox={`0 0 ${viewportSize.width} ${viewportSize.height}`}
          aria-hidden="true"
        >
          {layout.links.map((link) => {
            const state = linkState(
              link.toInstanceId === localInstanceId
                ? link.fromInstanceId
                : link.toInstanceId,
            );
            const healthy = state === "connected";
            const pending = state === "connecting" || state === "handshaking";
            const d = `M ${link.path.x1} ${link.path.y1} Q ${link.path.cx} ${link.path.cy} ${link.path.x2} ${link.path.y2}`;
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
        {layout.positions.map((position) => {
          const entry = instanceEntry(position.instanceId);
          return (
            <div
              key={position.instanceId}
              className="star-map__anchor"
              style={{ left: position.x, top: position.y }}
            >
              <StarMapInstanceCard
                instanceId={position.instanceId}
                label={entry.label}
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
        {layout.positions.map((position) => renderCloud(position))}
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
      </div>
    </div>
  );
}
