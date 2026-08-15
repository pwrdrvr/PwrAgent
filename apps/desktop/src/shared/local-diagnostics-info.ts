import {
  isRemoteFederationTarget,
  type AppServerBackendKind,
  type FederationHealthStatus,
  type FederationRemoteTarget,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import type { AppMetadata } from "./app-metadata";

export type LocalThreadDiagnosticsContext = {
  backend?: AppServerBackendKind;
  federation?: NavigationThreadSummary["federation"];
  federationHealth?: FederationHealthStatus;
  federationWindowTarget?: FederationRemoteTarget;
  projectPath?: string;
  threadId?: string;
  title?: string;
};

function available(value: string | undefined): string {
  return value?.trim() || "Unavailable";
}

function processIdLines(metadata: AppMetadata): string[] {
  return [
    `Main process PID: ${metadata.mainProcessId}`,
    ...(metadata.rendererProcessId === undefined
      ? []
      : [`Renderer process PID: ${metadata.rendererProcessId}`]),
  ];
}

function federationLines(context: LocalThreadDiagnosticsContext): string[] {
  const federation = context.federation;
  const target = federation?.ref.target;
  const remoteTarget = target && isRemoteFederationTarget(target)
    ? target
    : undefined;
  const owner = remoteTarget
    ? context.federationHealth?.peers.find(
        (peer) => peer.id === remoteTarget.instanceId,
      )
    : undefined;
  const remoteWindow = Boolean(remoteTarget && context.federationWindowTarget);

  return [
    `Thread location: ${remoteTarget ? "Remote" : "Local"}`,
    `Federation view: ${
      remoteTarget
        ? remoteWindow
          ? "Dedicated remote window"
          : "Mounted in local window"
        : "Local thread"
    }`,
    `Federation mount provenance: ${
      remoteTarget
        ? federation?.derivedFromMountedParent
          ? "Derived from mounted parent"
          : "Direct"
        : "Not mounted"
    }`,
    `Federation viewer instance ID: ${available(context.federationHealth?.instanceId)}`,
    `Federation owner instance ID: ${available(remoteTarget?.instanceId)}`,
    `Federation owner label: ${available(federation?.instanceLabel)}`,
    `Federation owner hostname: ${available(owner?.host?.hostname)}`,
    `Federation owner machine ID: ${available(owner?.host?.machineId)}`,
    `Federation owner profile: ${available(owner?.profileName)}`,
    `Federation peer status: ${available(federation?.peerStatus ?? owner?.status)}`,
    `Federation routing target: ${
      remoteTarget ? `remote:${remoteTarget.instanceId}` : "local"
    }`,
    `Federation source backend: ${available(federation?.ref.backend ?? context.backend)}`,
    `Federation source thread ID: ${available(federation?.ref.threadId ?? context.threadId)}`,
  ];
}

export function buildTroubleshootingDiagnosticsInfo(
  metadata: AppMetadata,
): string {
  return [
    `PwrAgent profile: ${metadata.activeProfileName}`,
    ...processIdLines(metadata),
    `PwrAgent log path: ${available(metadata.logFilePath)}`,
  ].join("\n");
}

export function buildLocalThreadDiagnosticsInfo(
  context: LocalThreadDiagnosticsContext,
  metadata: AppMetadata,
): string {
  return [
    `Thread ID: ${available(context.threadId)}`,
    `Project directory/worktree path: ${available(context.projectPath)}`,
    `Provider/backend: ${available(context.backend)}`,
    `Thread title: ${available(context.title)}`,
    ...federationLines(context),
    `PwrAgent profile: ${metadata.activeProfileName}`,
    ...processIdLines(metadata),
    `PwrAgent log path: ${available(metadata.logFilePath)}`,
    `Codex profile path: ${available(metadata.codexProfilePath)}`,
  ].join("\n");
}
