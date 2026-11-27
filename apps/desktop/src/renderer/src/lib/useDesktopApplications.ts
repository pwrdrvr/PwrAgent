import { useEffect, useState } from "react";
import {
  isRemoteFederationTarget,
  type FederationTarget,
} from "@pwragent/shared/contracts/federation";
import type { DesktopApplicationsSnapshot } from "@pwragent/shared/contracts/settings";
import type { DesktopApi } from "./desktop-api";
import { readRendererFederationTarget } from "./federation-window";

/**
 * The machine whose apps the window offers: the first remote target among
 * `targets` (most specific first), else the window's own owner.
 */
export function remoteApplicationInstanceIdFor(
  targets: readonly (FederationTarget | undefined)[],
): string | undefined {
  for (const target of targets) {
    if (target && isRemoteFederationTarget(target)) return target.instanceId;
  }
  return readRendererFederationTarget()?.instanceId;
}

type ReadApplications = NonNullable<DesktopApi["readApplications"]>;
const peerApplicationReads = new WeakMap<ReadApplications, Map<string, Promise<DesktopApplicationsSnapshot>>>();
const APPLICATIONS_TTL_MS = 30_000;

/** The composer and open sidebar card share each owner's discovery, including an in-flight read. */
export function readPeerApplications(read: ReadApplications, instanceId: string): Promise<DesktopApplicationsSnapshot> {
  let peers = peerApplicationReads.get(read);
  if (!peers) {
    peers = new Map();
    peerApplicationReads.set(read, peers);
  }
  const cached = peers.get(instanceId);
  if (cached) return cached;
  const request = read({ federationTarget: { scope: "remote", instanceId } }).then(
    ({ applications }) => {
      window.setTimeout(() => peers.delete(instanceId), APPLICATIONS_TTL_MS);
      return applications;
    },
    (error: unknown) => {
      peers.delete(instanceId);
      throw error;
    },
  );
  peers.set(instanceId, request);
  return request;
}

export function useDesktopApplications(params: {
  desktopApi?: DesktopApi;
  localApplications?: DesktopApplicationsSnapshot;
  remoteInstanceId?: string;
  suspended?: boolean;
}): DesktopApplicationsSnapshot | undefined {
  const [remoteApplications, setRemoteApplications] = useState<{
    applications: DesktopApplicationsSnapshot;
    instanceId: string;
  }>();

  useEffect(() => {
    if (
      !params.remoteInstanceId
      || params.suspended
      || !params.desktopApi?.readApplications
    ) {
      setRemoteApplications(undefined);
      return;
    }

    const remoteInstanceId = params.remoteInstanceId;
    let cancelled = false;
    void readPeerApplications(params.desktopApi.readApplications, remoteInstanceId).then((applications) => {
      if (!cancelled) {
        setRemoteApplications({
          applications,
          instanceId: remoteInstanceId,
        });
      }
    }).catch(() => {
      if (!cancelled) {
        setRemoteApplications(undefined);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [params.desktopApi, params.remoteInstanceId, params.suspended]);

  if (!params.remoteInstanceId) {
    return params.localApplications;
  }
  return remoteApplications?.instanceId === params.remoteInstanceId
    ? remoteApplications.applications
    : undefined;
}
