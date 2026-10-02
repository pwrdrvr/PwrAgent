import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
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

const FederationDisplayLabels = createContext<ReadonlyMap<string, string> | undefined>(undefined);

/** Reuses the window's live health read for chips on thread and search rows. */
export function FederationDisplayLabelsProvider(props: {
  health?: FederationHealthStatus;
  children: ReactNode;
}) {
  const labels = useMemo(() => {
    const health = props.health;
    if (!health) return undefined;
    const peers = [
      ...health.peers,
      ...(health.localLabel ? [{ label: health.localLabel, profileName: health.localProfileName }] : []),
    ];
    return new Map(health.peers.map((peer) => [peer.id, federationDisplayLabel(peer, peers)]));
  }, [props.health]);
  return <FederationDisplayLabels.Provider value={labels}>{props.children}</FederationDisplayLabels.Provider>;
}

export function useFederationDisplayLabel(instanceId: string, fallback: string): string {
  return useContext(FederationDisplayLabels)?.get(instanceId) ?? fallback;
}
