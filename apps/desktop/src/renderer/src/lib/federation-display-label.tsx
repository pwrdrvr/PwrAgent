import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import {
  formatFederationPeerDisplayLabel,
  formatFederationPeerShortDisplayLabel,
  type FederationHealthStatus,
} from "@pwragent/shared";

type DisplayPeer = { label: string; profileName?: string; shortLabel?: string; revokedAt?: number };

/** The machine name shown on UI controls, with its distinguishing profile. */
export function federationDisplayLabel(peer: DisplayPeer, peers: readonly DisplayPeer[]): string {
  return formatFederationPeerShortDisplayLabel(peer, peers);
}

export function federationLocalDisplayLabel(health: FederationHealthStatus | undefined): string {
  if (!health?.localLabel) return "This machine";
  const local = {
    label: health.localLabel,
    profileName: health.localProfileName,
    shortLabel: health.localShortLabel,
  };
  return federationDisplayLabel(local, [...health.peers, local]);
}

type FederationInstanceNames = { label: string; fullLabel: string };

const FederationDisplayLabels = createContext<
  ReadonlyMap<string, FederationInstanceNames> | undefined
>(undefined);

/**
 * Reuses the window's live health read for chips on thread and search rows,
 * and for `@` mentions in a transcript, which can name this instance too.
 */
export function FederationDisplayLabelsProvider(props: {
  health?: FederationHealthStatus;
  children: ReactNode;
}) {
  const labels = useMemo(() => {
    const health = props.health;
    if (!health) return undefined;
    const local = health.localLabel
      ? { label: health.localLabel, profileName: health.localProfileName, shortLabel: health.localShortLabel }
      : undefined;
    const peers = [...health.peers, ...(local ? [local] : [])];
    const names = (peer: DisplayPeer): FederationInstanceNames => ({
      label: federationDisplayLabel(peer, peers),
      fullLabel: formatFederationPeerDisplayLabel(peer, peers),
    });
    return new Map([
      ...(local && health.instanceId ? [[health.instanceId, names(local)] as const] : []),
      ...health.peers.map((peer) => [peer.id, names(peer)] as const),
    ]);
  }, [props.health]);
  return <FederationDisplayLabels.Provider value={labels}>{props.children}</FederationDisplayLabels.Provider>;
}

/** The short and full names for a chip, falling back to the text it was given. */
export function useFederationInstanceNames(
  instanceId: string,
  fallback: string,
): FederationInstanceNames {
  return useContext(FederationDisplayLabels)?.get(instanceId)
    ?? { label: fallback, fullLabel: fallback };
}

/**
 * The same names as {@link useFederationInstanceNames}, for a render callback
 * that draws many instances and cannot call a hook per row.
 */
export function useFederationInstanceNameLookup(): (
  instanceId: string,
  fallback: string,
) => FederationInstanceNames {
  const labels = useContext(FederationDisplayLabels);
  return useCallback(
    (instanceId: string, fallback: string) =>
      labels?.get(instanceId) ?? { label: fallback, fullLabel: fallback },
    [labels],
  );
}
