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
  const forget = (): void => {
    if (peers.get(instanceId) === request) peers.delete(instanceId);
  };
  const request = read({ federationTarget: { scope: "remote", instanceId } }).then(
    ({ applications }) => {
      window.setTimeout(forget, APPLICATIONS_TTL_MS);
      return applications;
    },
    (error: unknown) => {
      forget();
      throw error;
    },
  );
  peers.set(instanceId, request);
  return request;
}

type CheckWorkspace = NonNullable<DesktopApi["applicationWorkspaceExists"]>;
const pendingWorkspaces = new WeakMap<CheckWorkspace, Map<string, Promise<boolean>>>();

/** Several rows can share a checkout. Each visit after the owner's check settles needs a fresh stat. */
export function checkPeerApplicationWorkspace(check: CheckWorkspace, instanceId: string, targetPath: string): Promise<boolean> {
  let pending = pendingWorkspaces.get(check);
  if (!pending) {
    pending = new Map();
    pendingWorkspaces.set(check, pending);
  }
  const key = JSON.stringify([instanceId, targetPath]);
  const existing = pending.get(key);
  if (existing) return existing;
  const request = check({ federationTarget: { scope: "remote", instanceId }, targetPath })
    .finally(() => { pending.delete(key); });
  pending.set(key, request);
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
    const read = params.desktopApi?.readApplications;
    const remoteInstanceId = params.remoteInstanceId;
    if (!remoteInstanceId || !read || params.suspended) {
      if (params.suspended && remoteInstanceId && read) {
        // In-flight and completed reads belong to the connection that authorized them.
        peerApplicationReads.get(read)?.delete(remoteInstanceId);
      }
      setRemoteApplications(undefined);
      return;
    }

    let cancelled = false;
    void readPeerApplications(read, remoteInstanceId).then((applications) => {
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
  return !params.suspended && remoteApplications?.instanceId === params.remoteInstanceId
    ? remoteApplications.applications
    : undefined;
}
