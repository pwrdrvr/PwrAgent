import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  formatFederationPeerDisplayLabel,
  formatFederationPeerDisplayLabelParts,
  type FederationHealthStatus,
} from "@pwragent/shared";

type DisplayPeer = { label: string; profileName?: string; shortLabel?: string; revokedAt?: number };

/** The machine name shown on UI controls, with its distinguishing profile. */
export function federationDisplayLabel(peer: DisplayPeer, peers: readonly DisplayPeer[]): string {
  const parts = formatFederationPeerDisplayLabelParts(peer, peers);
  const machine = parts.shortLabel ?? parts.label;
  return parts.profileName ? `${machine} / ${parts.profileName}` : machine;
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
