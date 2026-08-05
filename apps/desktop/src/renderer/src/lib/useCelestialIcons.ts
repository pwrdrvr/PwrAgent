import { useEffect, useMemo, useState } from "react";
import {
  isCelestialIconAssignment,
  type CelestialIconAssignment,
  type CelestialIconId,
} from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";

export type CelestialIcons = {
  /** Icon for a federation instance; undefined until the map is known. */
  iconFor: (instanceId: string | undefined) => CelestialIconId | undefined;
  /** The local instance's own icon (watermarks, the local instance card). */
  localIcon?: CelestialIconId;
  assignments: CelestialIconAssignment[];
};

/**
 * The federation-wide celestial icon assignment map. Seeds from
 * readFederationHealth (local icon + per-peer icons), then follows the
 * `federation/celestialIcons/changed` agent events the runtime publishes
 * whenever an assignment snapshot merges.
 */
export function useCelestialIcons(params: {
  desktopApi?: DesktopApi;
}): CelestialIcons {
  const desktopApi = params.desktopApi;
  const [assignments, setAssignments] = useState<CelestialIconAssignment[]>([]);
  const [localIcon, setLocalIcon] = useState<CelestialIconId | undefined>();
  const [localInstanceId, setLocalInstanceId] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void desktopApi
      ?.readFederationHealth?.({})
      .then((response) => {
        if (cancelled) return;
        setLocalIcon((current) => current ?? response.health.localCelestialIcon);
        setLocalInstanceId(response.health.instanceId);
        setAssignments((current) =>
          current.length > 0
            ? current
            : response.health.peers.flatMap((peer) =>
                peer.celestialIcon
                  ? [
                      {
                        instanceId: peer.id,
                        icon: peer.celestialIcon,
                        source: "auto" as const,
                        updatedAt: 0,
                      },
                    ]
                  : [],
              ),
        );
      })
      .catch(() => {
        // Health is a seed; the event stream below is the live source.
      });
    const unsubscribe = desktopApi?.onAgentEvent?.((event) => {
      if (event.notification.method !== "federation/celestialIcons/changed") {
        return;
      }
      const params = event.notification.params as {
        assignments?: unknown[];
      };
      if (!Array.isArray(params.assignments)) return;
      const next = params.assignments.filter(isCelestialIconAssignment);
      setAssignments(next);
      setLocalInstanceId((currentId) => {
        if (currentId) {
          const local = next.find(
            (assignment) => assignment.instanceId === currentId,
          );
          if (local) setLocalIcon(local.icon);
        }
        return currentId;
      });
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [desktopApi]);

  return useMemo(() => {
    const byInstance = new Map(
      assignments.map((assignment) => [assignment.instanceId, assignment.icon]),
    );
    if (localInstanceId && localIcon && !byInstance.has(localInstanceId)) {
      byInstance.set(localInstanceId, localIcon);
    }
    return {
      iconFor: (instanceId: string | undefined) =>
        instanceId ? byInstance.get(instanceId) : localIcon,
      localIcon,
      assignments,
    };
  }, [assignments, localIcon, localInstanceId]);
}
