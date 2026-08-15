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
  federationWindowLabel?: string;
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

function federationLines(
  context: LocalThreadDiagnosticsContext,
  metadata: AppMetadata,
): string[] {
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
  const remoteViewerTarget = context.federationWindowTarget;
  const remoteViewer = remoteViewerTarget
    ? context.federationHealth?.peers.find(
        (peer) => peer.id === remoteViewerTarget.instanceId,
      )
    : undefined;
  const classification = remoteViewerTarget
    ? remoteTarget && remoteTarget.instanceId !== remoteViewerTarget.instanceId
      ? "Remote² Thread in Remote Viewer"
      : "Remote Thread in Remote Viewer"
    : remoteTarget
      ? "Remote Thread Mounted in Local Viewer"
      : "Local Thread in Local Viewer";
  const localThreadOwner = !remoteTarget;

  return [
    `Thread/view classification: ${classification}`,
    `Federation mount provenance: ${
      remoteTarget
        ? federation?.derivedFromMountedParent
          ? "Derived from mounted parent"
          : "Direct"
        : "Not mounted"
    }`,
    `Local viewer federation instance ID: ${available(context.federationHealth?.instanceId)}`,
    `Remote viewer target instance ID: ${available(remoteViewerTarget?.instanceId)}`,
    `Remote viewer target label: ${available(
      context.federationWindowLabel ?? remoteViewer?.label,
    )}`,
    `Remote viewer target hostname: ${available(remoteViewer?.host?.hostname)}`,
    `Remote viewer target machine ID: ${available(remoteViewer?.host?.machineId)}`,
    `Remote viewer target profile: ${available(remoteViewer?.profileName)}`,
    `Remote viewer target status: ${available(remoteViewer?.status)}`,
    `Thread owner federation instance ID: ${available(
      remoteTarget?.instanceId
      ?? (localThreadOwner ? context.federationHealth?.instanceId : undefined),
    )}`,
    `Thread owner label: ${available(
      remoteTarget
        ? federation?.instanceLabel ?? owner?.label
        : context.federationHealth?.localLabel,
    )}`,
    `Thread owner hostname: ${available(
      remoteTarget ? owner?.host?.hostname : metadata.hostname,
    )}`,
    `Thread owner machine ID: ${available(owner?.host?.machineId)}`,
    `Thread owner platform: ${available(
      remoteTarget ? owner?.host?.platform : metadata.platform,
    )}`,
    `Thread owner OS version: ${available(
      remoteTarget ? owner?.host?.osVersion : metadata.osVersion,
    )}`,
    `Thread owner architecture: ${available(
      remoteTarget ? owner?.host?.arch : metadata.architecture,
    )}`,
    `Thread owner profile: ${available(
      remoteTarget ? owner?.profileName : metadata.activeProfileName,
    )}`,
    `Thread owner status: ${available(
      remoteTarget
        ? federation?.peerStatus ?? owner?.status
        : context.federationHealth?.status,
    )}`,
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
    ...federationLines(context, metadata),
    `Viewer machine hostname: ${available(metadata.hostname)}`,
    `Viewer platform: ${available(metadata.platform)}`,
    `Viewer OS version: ${available(metadata.osVersion)}`,
    `Viewer architecture: ${available(metadata.architecture)}`,
    `Viewer PwrAgent version: ${available(metadata.applicationVersion)}`,
    `Viewer Electron version: ${available(metadata.electronVersion)}`,
    `Viewer Chrome version: ${available(metadata.chromeVersion)}`,
    `Viewer Node version: ${available(metadata.nodeVersion)}`,
    `Viewer PwrAgent profile: ${metadata.activeProfileName}`,
    `Viewer main process PID: ${metadata.mainProcessId}`,
    ...(metadata.rendererProcessId === undefined
      ? []
      : [`Viewer renderer process PID: ${metadata.rendererProcessId}`]),
    `Viewer PwrAgent log path: ${available(metadata.logFilePath)}`,
    `Viewer Codex profile path: ${available(metadata.codexProfilePath)}`,
  ].join("\n");
}
