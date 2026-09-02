import { useEffect, useState } from "react";
import type { DesktopApplicationsSnapshot } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";

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
    void params.desktopApi.readApplications({
      federationTarget: {
        scope: "remote",
        instanceId: remoteInstanceId,
      },
    }).then((response) => {
      if (!cancelled) {
        setRemoteApplications({
          applications: response.applications,
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
