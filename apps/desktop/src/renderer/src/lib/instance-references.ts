import type { CelestialIconId, FederationHealthStatus } from "@pwragent/shared";
import { filterDirectoryReferenceCandidates, type ReferenceDirectory } from "./directory-references";
import { federationDisplayLabel } from "./federation-display-label";

export type InstanceReference = {
  kind: "instance";
  key: string;
  instanceId: string;
  /** Full machine and profile; the inserted mention, so what the agent reads. */
  label: string;
  /** The federation short name, with any distinguishing profile, for the picker row. */
  shortLabel?: string;
  path: string;
  profileName?: string;
  hostname?: string;
  icon?: CelestialIconId;
  status: string;
};

export type AtReference = ReferenceDirectory | InstanceReference;

export function buildInstanceReferenceUrl(instanceId: string): string {
  const encoded = encodeURIComponent(instanceId).replace(/[()]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `pwragent://instance/${encoded}`;
}

export function parseInstanceReferenceUrl(url: string): string | undefined {
  const match = /^pwragent:\/\/instance\/([^/?#\s]+)$/.exec(url);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]) || undefined;
  } catch {
    return undefined;
  }
}

export function buildInstanceReferenceMarkdown(reference: { label: string; path: string }): string {
  const label = reference.label.replace(/[\\[\]]/g, "\\$&").replace(/[\r\n]/g, " ");
  return `[@${label}](${reference.path})`;
}

/** Keep profiles distinct even when they share a machine label. */
export function listInstanceReferences(health?: FederationHealthStatus): InstanceReference[] {
  if (!health?.enabled) return [];
  const instances: InstanceReference[] = [];
  const seen = new Set<string>();
  // The local instance counts, so a peer on this machine keeps its profile.
  const visible = [
    ...health.peers,
    ...(health.localLabel ? [{ label: health.localLabel, profileName: health.localProfileName }] : []),
  ];
  const add = (id: string, label: string, profileName: string | undefined,
    status: string, icon?: CelestialIconId, hostname?: string, shortLabel?: string): void => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    instances.push({
      kind: "instance",
      key: `instance:${id}`,
      instanceId: id,
      label: profileName ? `${label} / ${profileName}` : label,
      ...(shortLabel
        ? { shortLabel: federationDisplayLabel({ label, profileName, shortLabel }, visible) }
        : {}),
      path: buildInstanceReferenceUrl(id),
      profileName,
      hostname,
      icon,
      status,
    });
  };
  if (health.instanceId) {
    add(health.instanceId, health.localLabel ?? health.instanceId,
      health.localProfileName, "This instance", health.localCelestialIcon, undefined,
      health.localShortLabel);
  }
  for (const peer of health.peers) {
    if (peer.revokedAt || peer.status === "revoked") continue;
    add(peer.id, peer.label, peer.profileName, peer.status, peer.celestialIcon,
      peer.host?.hostname, peer.shortLabel);
  }
  return instances;
}

/** Each population gets its own bounded slots so projects cannot hide machines. */
export function filterAtReferenceCandidates(
  directories: readonly ReferenceDirectory[],
  instances: readonly InstanceReference[],
  query: string,
): AtReference[] {
  const normalized = query.trim().toLowerCase();
  const names = (instance: InstanceReference): string[] =>
    [instance.label, instance.shortLabel ?? ""].filter(Boolean);
  const startsWith = (instance: InstanceReference): number =>
    Number(names(instance).some((name) => name.toLowerCase().startsWith(normalized)));
  const shown = (instance: InstanceReference): string => instance.shortLabel ?? instance.label;
  const matches = instances.filter((instance) =>
    [
      ...names(instance).flatMap((name) => [name, name.replace(/\s*\/\s*/g, "/")]),
      instance.instanceId,
      instance.hostname ?? "",
    ].some((value) => value.toLowerCase().includes(normalized)),
  ).sort((left, right) =>
    startsWith(right) - startsWith(left)
    || shown(left).localeCompare(shown(right))
    || left.instanceId.localeCompare(right.instanceId),
  ).slice(0, 10);
  return [...filterDirectoryReferenceCandidates([...directories], query), ...matches];
}
