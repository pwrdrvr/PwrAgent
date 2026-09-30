import { useMemo } from "react";
import {
  PWRGIT_MCP_CONNECTION_ID,
  withMcpConnection,
  type AppServerBackendKind,
  type PwrGitConnectionStatus,
} from "@pwragent/shared";
import pwrGitIcon from "../../assets/pwrgit/pwrgit-app-icon.png";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  PwrSuiteConnectionTile,
  type PwrSuiteConnectionApp,
} from "./PwrSuiteConnectionTile";

export function PwrGitConnectionPrompt(props: {
  backend: AppServerBackendKind;
  desktopApi?: DesktopApi;
  enabled: boolean;
  remoteOwnerLabel?: string;
  onEnabledChange: (enabled: boolean) => Promise<void>;
}) {
  const desktopApi = props.desktopApi;
  const config = useMemo<PwrSuiteConnectionApp<PwrGitConnectionStatus>>(() => ({
    app: "pwrgit",
    name: "PwrGit",
    icon: pwrGitIcon,
    pitch: "Repo, branch and PR state for agents",
    about: {
      title: "Your repositories, without the guessing",
      body:
        "PwrGit lets your agents find the right checkout, read branch and "
        + "worktree state, and follow pull-request and CI status — without "
        + "being told where anything lives.",
    },
    readStatus: desktopApi?.readPwrGitConnectionStatus,
    connect: desktopApi?.connectPwrGit
      ? async () => {
          const response = await desktopApi.connectPwrGit!();
          // A response without detail is one whose `status.detail` already
          // says what to do (the switch to turn on); repeating it would say
          // the same sentence twice.
          return {
            status: response.status,
            ...(response.outcome !== "connected" && response.detail
              ? { error: response.detail }
              : {}),
          };
        }
      : undefined,
    openApp: desktopApi?.openPwrGit,
    waitingLine: "Approve the connection in PwrGit",
    connectsWhileClosed: false,
    // PwrGit has no federation surface yet, so a remote tile only appears
    // once the owner reports the connection configured.
    remoteNeedsRunning: false,
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
export function pwrGitConnectionIds(
  current: readonly string[] | undefined,
  enabled: boolean,
): string[] {
  return withMcpConnection(current, PWRGIT_MCP_CONNECTION_ID, enabled);
}
