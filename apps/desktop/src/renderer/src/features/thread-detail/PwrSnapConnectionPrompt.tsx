import { useMemo } from "react";
import {
  PWRSNAP_MCP_CONNECTION_ID,
  withMcpConnection,
  type AppServerBackendKind,
  type PwrSnapConnectionStatus,
} from "@pwragent/shared";
import pwrSnapIcon from "../../assets/pwrsnap/pwrsnap-app-icon.png";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  PwrSuiteConnectionTile,
  type PwrSuiteConnectionApp,
} from "./PwrSuiteConnectionTile";

export function PwrSnapConnectionPrompt(props: {
  backend: AppServerBackendKind;
  desktopApi?: DesktopApi;
  enabled: boolean;
  remoteOwnerLabel?: string;
  onEnabledChange: (enabled: boolean) => Promise<void>;
}) {
  const desktopApi = props.desktopApi;
  const config = useMemo<PwrSuiteConnectionApp<PwrSnapConnectionStatus>>(() => ({
    app: "pwrsnap",
    name: "PwrSnap",
    icon: pwrSnapIcon,
    pitch: "Screenshots your agents can use",
    about: {
      title: "Screenshots your agents can actually use",
      body:
        "PwrSnap captures and organizes screenshots, then lets your agents "
        + "find, edit, and export the right image without digging through "
        + "folders.",
    },
    readStatus: desktopApi?.readPwrSnapConnectionStatus
      ? async () => await desktopApi.readPwrSnapConnectionStatus!()
      : undefined,
    connect: desktopApi?.connectPwrSnap
      ? async () => {
          const response = await desktopApi.connectPwrSnap!();
          return {
            status: response.status,
            ...(response.outcome === "needs_local_agent_access"
              ? { error: "Turn on Local Agent Access in PwrSnap, then Connect again" }
              : {}),
          };
        }
      : undefined,
    openApp: desktopApi?.openPwrSnap,
    waitingLine: "Connecting to PwrSnap…",
    connectsWhileClosed: true,
    // A remote tile needs the owner's PwrSnap running as well as paired:
    // the viewer's install state never stands in for the owner's.
    remoteNeedsRunning: true,
  }), [desktopApi]);

  return (
    <PwrSuiteConnectionTile
      config={config}
      backend={props.backend}
      desktopApi={desktopApi}
      enabled={props.enabled}
      remoteOwnerLabel={props.remoteOwnerLabel}
      onEnabledChange={props.onEnabledChange}
    />
  );
}

/**
 * Composes onto the thread's existing list rather than replacing it: PwrSnap
 * and PwrGit share one `mcpConnectionIds` array, so a replacing toggle would
 * silently disable the other card.
 */
export function pwrSnapConnectionIds(
  current: readonly string[] | undefined,
  enabled: boolean,
): string[] {
  return withMcpConnection(current, PWRSNAP_MCP_CONNECTION_ID, enabled);
}
