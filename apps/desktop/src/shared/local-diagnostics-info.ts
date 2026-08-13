import type { AppServerBackendKind } from "@pwragent/shared";
import type { AppMetadata } from "./app-metadata";

export type LocalThreadDiagnosticsContext = {
  backend?: AppServerBackendKind;
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
    `PwrAgent profile: ${metadata.activeProfileName}`,
    ...processIdLines(metadata),
    `PwrAgent log path: ${available(metadata.logFilePath)}`,
    `Codex profile path: ${available(metadata.codexProfilePath)}`,
  ].join("\n");
}
