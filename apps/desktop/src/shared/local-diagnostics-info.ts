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
  if (!remoteTarget && !remoteViewerTarget) {
    return [];
  }
  const classification = remoteViewerTarget
    ? remoteTarget && remoteTarget.instanceId !== remoteViewerTarget.instanceId
      ? "Remote² Thread in Remote Viewer"
      : "Remote Thread in Remote Viewer"
    : remoteTarget
      ? "Remote Thread Mounted in Local Viewer"
      : "Local Thread in Local Viewer";
  const ownerInstanceId = remoteTarget?.instanceId
    ?? remoteViewerTarget?.instanceId;

  const optionalLine = (
    label: string,
    value: string | undefined,
  ): string[] => value?.trim() ? [`${label}: ${value}`] : [];

  return [
    `Thread/view classification: ${classification}`,
    ...(remoteTarget
      ? [`Federation mount provenance: ${
          federation?.derivedFromMountedParent
            ? "Derived from mounted parent"
            : "Direct"
        }`]
      : []),
    ...(remoteViewerTarget
      ? [`Remote viewer target instance ID: ${remoteViewerTarget.instanceId}`]
      : []),
    ...optionalLine(
      "Remote viewer target label",
      context.federationWindowLabel ?? remoteViewer?.label,
    ),
    `Thread owner federation instance ID: ${available(ownerInstanceId)}`,
    ...optionalLine(
      "Thread owner label",
      federation?.instanceLabel ?? owner?.label,
    ),
    ...optionalLine("Thread owner hostname", owner?.host?.hostname),
    ...optionalLine("Thread owner profile", owner?.profileName),
    ...optionalLine(
      "Thread owner status",
      federation?.peerStatus ?? owner?.status,
    ),
    `Federation routing target: remote:${available(ownerInstanceId)}`,
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
