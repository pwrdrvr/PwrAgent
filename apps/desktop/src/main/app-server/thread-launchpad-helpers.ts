import { parseRemoteLaunchpadStorageKey } from "@pwragent/shared";
import path from "node:path";
import { createCodexEnvironmentHydrationStorage } from "../storage/desktop-runtime-storage";
import type { OverlayStoreLike } from "../storage/desktop-overlay-store";
import {
  type AppServerThreadReplay,
  type CodexEnvironmentOption,
  type CodexThreadEnvironmentRuntime,
  type NavigationLaunchpadDraft,
  type NavigationLaunchpadDefaults,
  type EnsureDirectoryLaunchpadRequest,
} from "@pwragent/shared";
import { type CodexEnvironmentSelection } from "./codex-environment-runtime";
import { type CodexEnvironmentHydrationStore } from "../storage/codex-environment-hydration-store";



/** Same connections, in any order; two absent selections are the same. */
export function sameMcpConnectionIds(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((id) => b.includes(id));
}

export function isEmptyDirectoryLaunchpadDraft(launchpad: NavigationLaunchpadDraft): boolean {
  return (
    launchpad.prompt.trim().length === 0 &&
    (launchpad.imageAttachments?.length ?? 0) === 0 &&
    launchpad.settingsTouchedAt === undefined
  );
}

export function defaultLaunchpadWorkMode(
  request: Pick<EnsureDirectoryLaunchpadRequest, "directoryKind" | "directoryPath">,
  defaults: NavigationLaunchpadDefaults
): NavigationLaunchpadDraft["workMode"] {
  return request.directoryKind === "directory" && request.directoryPath
    ? defaults.workMode ?? "local"
    : "local";
}

export function fallbackLaunchpadIdentity(
  storageKey: string,
): Pick<
  EnsureDirectoryLaunchpadRequest,
  "directoryKind" | "directoryLabel" | "directoryPath"
> {
  const directoryKey =
    parseRemoteLaunchpadStorageKey(storageKey)?.directoryKey ?? storageKey;
  if (directoryKey.startsWith("directory:")) {
    const directoryPath = directoryKey.slice("directory:".length);
    if (directoryPath.length > 0) {
      return {
        directoryKind: "directory",
        directoryLabel: path.basename(directoryPath) || directoryPath,
        directoryPath,
      };
    }
  }

  return {
    directoryKind: directoryKey.startsWith("workspace:") ? "workspace" : "directory",
    directoryLabel: directoryKey.startsWith("workspace:")
      ? "Workspaces"
      : directoryKey,
  };
}

export function resolveCodexEnvironmentSelection(
  launchpad: NavigationLaunchpadDraft,
  options: CodexEnvironmentOption[],
): CodexEnvironmentSelection | undefined {
  if (!launchpad.codexEnvironmentId) {
    return undefined;
  }

  const environment = options.find(
    (candidate) => candidate.id === launchpad.codexEnvironmentId,
  );
  if (!environment) {
    return undefined;
  }

  return {
    environment,
    executionTarget: launchpad.codexEnvironmentExecutionTarget ?? "local",
    runSetup: Boolean(environment.setupScript),
  };
}

export async function resetLaunchpadAfterMaterialize(params: {
  defaultPrAutoDispatchEnabled: boolean;
  defaults: NavigationLaunchpadDefaults;
  launchpad: NavigationLaunchpadDraft;
  overlayStore: OverlayStoreLike;
}): Promise<void> {
  const {
    defaultPrAutoDispatchEnabled,
    defaults,
    launchpad,
    overlayStore,
  } = params;
  // Registration belongs to the project, not the submitted message. Replace
  // a registered draft in one write so it remains in the owner directory index
  // throughout workspace setup and after the thread is archived or removed.
  if (launchpad.registeredAt !== undefined) {
    const persisted = await overlayStore.getDirectoryLaunchpad({ directoryKey: launchpad.directoryKey });
    await overlayStore.upsertDirectoryLaunchpad({
      ...(persisted ?? launchpad),
      registeredAt: launchpad.registeredAt,
      prompt: "",
      imageAttachments: [],
      fileAttachments: [],
      editorDocument: undefined,
      updatedAt: Date.now(),
    });
    return;
  }
  await overlayStore.resetDirectoryLaunchpad({
    directoryKey: launchpad.directoryKey,
  });

  if (!launchpad.codexEnvironmentId && !launchpad.messagingToolUpdateMode) {
    return;
  }

  const now = Date.now();
  await overlayStore.upsertDirectoryLaunchpad({
    directoryKey: launchpad.directoryKey,
    directoryKind: launchpad.directoryKind,
    directoryLabel: launchpad.directoryLabel,
    directoryPath: launchpad.directoryPath,
    backend: defaults.backend,
    executionMode: defaults.executionMode,
    model: defaults.model,
    reasoningEffort: defaults.reasoningEffort,
    serviceTier: defaults.serviceTier,
    fastMode: defaults.fastMode,
    prAutoDispatchEnabled: defaultPrAutoDispatchEnabled,
    prompt: "",
    workMode: defaultLaunchpadWorkMode(launchpad, defaults),
    branchName: launchpad.branchName,
    messagingToolUpdateMode: launchpad.messagingToolUpdateMode,
    codexEnvironmentId: launchpad.codexEnvironmentId,
    codexEnvironmentExecutionTarget: launchpad.codexEnvironmentId
      ? launchpad.codexEnvironmentExecutionTarget ?? "local"
      : undefined,
    codexEnvironmentActionId: launchpad.codexEnvironmentActionId,
    createdAt: now,
    updatedAt: now,
  });
}

export function buildCodexEnvironmentSetupActivity(
  runtime: CodexThreadEnvironmentRuntime | undefined,
): AppServerThreadReplay["entries"][number] | undefined {
  if (!runtime?.setupStatus || !runtime.setupCommand) {
    return undefined;
  }

  const completed = runtime.setupStatus === "completed";
  const failed = runtime.setupStatus === "failed";
  return {
    type: "activity",
    id: `codex-environment-setup-${runtime.environmentId}`,
    createdAt: runtime.setupStartedAt,
    summary: completed
      ? `Environment setup completed: ${runtime.environmentName}`
      : failed
        ? `Environment setup failed: ${runtime.environmentName}`
        : `Environment setup skipped: ${runtime.environmentName}`,
    status: failed ? "failed" : "completed",
    details: [
      {
        id: "setup",
        kind: "command",
        label: "Setup command",
        status: failed ? "failed" : "completed",
        command: {
          displayCommand: runtime.setupCommand,
          rawCommand: runtime.setupCommand,
          cwd: runtime.cwd,
          output: runtime.setupOutput,
          exitCode: runtime.setupExitCode,
          durationMs: runtime.setupDurationMs,
        },
      },
    ],
  };
}

export function appendCodexEnvironmentSetupActivity(params: {
  replay: AppServerThreadReplay;
  runtime?: CodexThreadEnvironmentRuntime;
}): AppServerThreadReplay {
  const activity = buildCodexEnvironmentSetupActivity(params.runtime);
  if (!activity) {
    return params.replay;
  }
  if (params.replay.entries.some((entry) => entry.id === activity.id)) {
    return params.replay;
  }
  return {
    ...params.replay,
    entries: [activity, ...params.replay.entries],
  };
}

export function createDefaultCodexEnvironmentHydrationStore():
  | CodexEnvironmentHydrationStore
  | undefined {
  try {
    return createCodexEnvironmentHydrationStorage();
  } catch {
    return undefined;
  }
}

export function cloneCodexEnvironmentRuntimeForFork(
  runtime: CodexThreadEnvironmentRuntime,
  cwd?: string,
): CodexThreadEnvironmentRuntime {
  const {
    actionRuns: _actionRuns,
    actionId: _actionId,
    actionName: _actionName,
    actionCommand: _actionCommand,
    actionStatus: _actionStatus,
    actionPid: _actionPid,
    actionStartedAt: _actionStartedAt,
    actionExitedAt: _actionExitedAt,
    actionExitCode: _actionExitCode,
    actionExitSignal: _actionExitSignal,
    actionDurationMs: _actionDurationMs,
    actionOutput: _actionOutput,
    selectedActionIdByEnvironmentId,
    ...rest
  } = runtime;
  const inheritedSelectedActionIdByEnvironmentId =
    selectedActionIdByEnvironmentId ??
    (_actionId && runtime.environmentId ? { [runtime.environmentId]: _actionId } : undefined);
  const next: CodexThreadEnvironmentRuntime = {
    ...rest,
    ...(inheritedSelectedActionIdByEnvironmentId
      ? {
          selectedActionIdByEnvironmentId: {
            ...inheritedSelectedActionIdByEnvironmentId,
          },
        }
      : {}),
    ...(runtime.actions
      ? { actions: runtime.actions.map((action) => ({ ...action })) }
      : {}),
    ...(runtime.shellEnvironment
      ? { shellEnvironment: { ...runtime.shellEnvironment } }
      : {}),
  };
  const trimmedCwd = cwd?.trim();
  if (trimmedCwd) {
    next.cwd = trimmedCwd;
  }
  return next;
}

export function readSelectedActionIdByEnvironmentIdForFork(
  runtime: CodexThreadEnvironmentRuntime,
): Record<string, string> | undefined {
  if (runtime.selectedActionIdByEnvironmentId) {
    return { ...runtime.selectedActionIdByEnvironmentId };
  }
  if (runtime.actionId && runtime.environmentId) {
    return { [runtime.environmentId]: runtime.actionId };
  }
  return undefined;
}
