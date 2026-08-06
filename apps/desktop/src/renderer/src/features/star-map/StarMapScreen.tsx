import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildThreadIdentityKey,
  isRemoteFederationTarget,
  type FederationPeerSummary,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { useCelestialIcons } from "../../lib/useCelestialIcons";
import { useFederationHealth } from "../../lib/useFederationHealth";
import {
  selectAttentionThreads,
  STAR_MAP_ATTENTION_CATEGORIES,
  STAR_MAP_ATTENTION_LABELS,
  type StarMapAttentionCategory,
  type StarMapSessionKeys,
} from "./attention";
import {
  computeStarMapLayout,
  starMapCardSlot,
  type StarMapInstancePosition,
} from "./star-map-layout";
import { StarMapInstanceCard } from "./StarMapInstanceCard";
import { StarMapThreadCard } from "./StarMapThreadCard";
import { useStarMapThreads } from "./useStarMapThreads";

const FILTERS_STORAGE_KEY = "pwragent.starMap.filters";
const MAX_CARDS_PER_INSTANCE = 6;

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
};

/**
 * The Star Map mission-control surface: every federation instance as a
 * celestial body on a star field, hub-and-spoke health links between them,
 * and each instance's attention threads floating beneath it. The antithesis
 * of the left-bar thread list — pick a machine, see what needs review.
 */
export function StarMapScreen(props: StarMapScreenProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const { health } = useFederationHealth({ desktopApi: props.desktopApi });
  const celestialIcons = useCelestialIcons({ desktopApi: props.desktopApi });
  const [filters, setFilters] = useState<Set<StarMapAttentionCategory>>(
    readStoredFilters,
  );

  // Focus the layer on open AND whenever the floating thread closes —
  // "Back to map" leaves focus inside <main>, and without a refocus the
  // layer's Escape-to-close handler would never hear the key again.
  useEffect(() => {
    if (!props.floating) {
      layerRef.current?.focus();
    }
  }, [props.floating]);

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
  });

  // The hub is the local instance unless this instance is a pure client —
  // then its enrolled gateway anchors the map and the local node rides the
  // ring with its siblings.
  const hubInstanceId = useMemo(() => {
    if (!health || health.role !== "client") return localInstanceId;
    const gatewayId =
      health.clientEnrollment?.gatewayInstanceId
      ?? peers.find((peer) => peer.role === "gateway")?.id;
    return gatewayId ?? localInstanceId;
  }, [health, localInstanceId, peers]);

  const layout = useMemo(
    () =>
      computeStarMapLayout([
        {
          instanceId: localInstanceId,
          isHub: hubInstanceId === localInstanceId,
        },
        ...peers.map((peer) => ({
          instanceId: peer.id,
          isHub: peer.id === hubInstanceId,
        })),
      ]),
    [hubInstanceId, localInstanceId, peers],
  );
  const positionByInstance = useMemo(
    () =>
      new Map(layout.positions.map((position) => [position.instanceId, position])),
    [layout],
  );

  const attentionByInstance = useMemo(() => {
    const result = new Map<string, NavigationThreadSummary[]>();
    // The main-window snapshot also carries viewer-side pinned REMOTE
    // threads (Cmd+K unification). Those render under their owning
    // instance's cloud via the per-peer fetch — the local cloud takes
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

  const peerById = useMemo(
    () => new Map(peers.map((peer) => [peer.id, peer])),
    [peers],
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

  const renderCloud = (
    instanceId: string,
    position: StarMapInstancePosition,
  ) => {
    const threads = attentionByInstance.get(instanceId) ?? [];
    const visible = threads.slice(0, MAX_CARDS_PER_INSTANCE);
    const overflow = threads.length - visible.length;
    return (
      <div
        key={`cloud:${instanceId}`}
        className="star-map__cloud"
        style={{ left: `${position.x}%`, top: `${position.y}%` }}
      >
        {visible.map((thread, index) => {
          const slot = starMapCardSlot(index);
          return (
            <StarMapThreadCard
              key={buildThreadIdentityKey(thread.source, thread.id)}
              thread={thread}
              sessionKeys={
                instanceId === localInstanceId ? props.sessionKeys : undefined
              }
              style={{
                transform: `translate(calc(${slot.dx}px - 50%), ${slot.dy}px)`,
              }}
              onOpen={openThread}
            />
          );
        })}
        {overflow > 0 ? (
          <span
            className="star-map__cloud-overflow"
            style={{
              transform: `translate(-50%, ${
                starMapCardSlot(visible.length).dy + 8
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
      return {
        label: props.localInstanceLabel?.trim() || "This instance",
      };
    }
    const peer = peerById.get(instanceId);
    return { label: peer?.label ?? instanceId, peer };
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
      <div className="star-map__viewport">
        <svg
          className="star-map__links"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {layout.links.map((link) => {
            const from = positionByInstance.get(link.fromInstanceId);
            const to = positionByInstance.get(link.toInstanceId);
            if (!from || !to) return null;
            const peer =
              peerById.get(
                link.toInstanceId === localInstanceId
                  ? link.fromInstanceId
                  : link.toInstanceId,
              );
            const state =
              link.fromInstanceId === localInstanceId
              || link.toInstanceId === localInstanceId
                ? peer?.status ?? "connected"
                : peer?.status ?? "disconnected";
            const healthy = state === "connected";
            const pending = state === "connecting" || state === "handshaking";
            return (
              <g key={`${link.fromInstanceId}->${link.toInstanceId}`}>
                <line
                  className={`star-map__link${
                    healthy
                      ? " star-map__link--healthy"
                      : pending
                        ? " star-map__link--pending"
                        : " star-map__link--dead"
                  }`}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                />
                {healthy ? (
                  <line
                    className="star-map__link-flow"
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                  />
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
              style={{ left: `${position.x}%`, top: `${position.y}%` }}
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
                unreachable={remote.unreachableInstanceIds.has(
                  position.instanceId,
                )}
                onOpen={() => openInstance(position.instanceId)}
              />
            </div>
          );
        })}
        {layout.positions.map((position) =>
          renderCloud(position.instanceId, position),
        )}
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
            {STAR_MAP_ATTENTION_LABELS[category]}
          </button>
        ))}
      </div>
    </div>
  );
}
