import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { buildDirectorySummaries } from "@pwragent/agent-core";
import {
  buildThreadIdentityKey,
  isToolManagedWorktreePath,
  type AppServerThreadReplay,
  type ForkThreadRequest,
  type ForkThreadResponse,
  type ListThreadMigrationSourceThreadsRequest,
  type ListThreadMigrationSourceThreadsResponse,
  type RetryThreadMigrationRequest,
  type ListThreadMigrationSourcesResponse,
  type StartThreadMigrationRequest,
  type StartThreadMigrationResponse,
  type ThreadIdentifier,
  type ThreadMigrationRunItem,
  type ThreadMigrationSourceProjectGroup,
  type ThreadMigrationSourceThreadSummary,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import { getMainLogger } from "../log";
import { normalizeProfileName } from "../profile";
import type { DesktopSettingsService } from "../settings/desktop-settings-service";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import {
  discoverCodexAuthProfiles,
  resolveDefaultCodexHome,
  resolveCodexHomeForProfile,
} from "@pwrdrvr/codex-discovery";
import {
  CodexAppServerClient,
  type CodexThreadMigrationMetadata,
} from "../codex-app-server/client";
import { buildCodexClientArgs } from "./backend-registry";

const migrationLog = getMainLogger("pwragent:thread-migration");
const execFileAsync = promisify(execFile);

type SourceMigrationClient = Pick<
  CodexAppServerClient,
  | "archiveThread"
  | "close"
  | "listThreadsForMigration"
  | "readThread"
  | "restoreThread"
>;

type DestinationMigrationBackend = {
  forkThread(
    request: ForkThreadRequest & {
      onPreparedWorkspaceRollback?: (
        rollback: (() => Promise<void>) | undefined,
      ) => void;
      sourceThreadPath?: string;
    },
  ): Promise<ForkThreadResponse>;
  readThread(request: {
    backend?: "codex";
    threadId: ThreadIdentifier;
  }): Promise<{ replay: AppServerThreadReplay }>;
};

type ThreadMigrationServiceOptions = {
  destination: DestinationMigrationBackend;
  settingsService?: Pick<
    DesktopSettingsService,
    "readSettings" | "resolveCodexCommandPreference" | "resolveCodexSpawnEnv"
  >;
  sourceClientFactory?: (params: {
    codexHome: string;
    command?: string;
    env: NodeJS.ProcessEnv;
    profile: string;
  }) => SourceMigrationClient;
  idFactory?: () => string;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

type InternalSourceThread = ThreadMigrationSourceThreadSummary & {
  rolloutPath?: string;
};

type MigrationDiagnostics = NonNullable<ThreadMigrationRunItem["diagnostics"]>;

export class ThreadMigrationService {
  private readonly sourceClients = new Map<string, SourceMigrationClient>();
  private readonly sourceThreadCache = new Map<
    string,
    Map<ThreadIdentifier, InternalSourceThread>
  >();

  constructor(private readonly options: ThreadMigrationServiceOptions) {}

  async listSources(): Promise<ListThreadMigrationSourcesResponse> {
    const settingsService = this.getSettingsService();
    const settings = await settingsService.readSettings();
    const activeCodexProfile = normalizeSourceProfile(
      settings.models.codex.profile.value,
    );
    const discovery =
      settings.models.codex.profiles
      ?? discoverCodexAuthProfiles({
        configuredProfile: activeCodexProfile,
        env: this.options.env,
        homeDir: this.options.homeDir,
      });

    return {
      activeCodexProfile,
      profiles: discovery.profiles
        .filter(
          (profile) =>
            normalizeSourceProfile(profile.name) !== activeCodexProfile,
        )
        .map((profile) => {
          const hasAuth = Boolean(profile.hasAuthFile);
          const available = Boolean(profile.exists && hasAuth);
          return {
            profile: normalizeSourceProfile(profile.name),
            displayName: profile.displayName,
            codexHome: profile.codexHome,
            source: profile.source,
            exists: profile.exists,
            selected: false,
            available,
            ...(available
              ? {}
              : {
                  unavailableReason: profile.exists
                    ? "Codex auth is not configured for this profile."
                    : "Codex profile directory does not exist.",
                }),
            ...(profile.accountEmail
              ? { accountEmail: profile.accountEmail }
              : {}),
          };
        }),
    };
  }

  async listSourceThreads(
    request: ListThreadMigrationSourceThreadsRequest,
  ): Promise<ListThreadMigrationSourceThreadsResponse> {
    const sourceProfile = normalizeSourceProfile(request.sourceProfile);
    await this.assertProfileSelectable(sourceProfile);

    const client = await this.getSourceClient(sourceProfile);
    const metadata = await client.listThreadsForMigration({
      archived: request.archived === true,
      filter: request.filter,
    });
    const sourceThreads = metadata.map((thread) =>
      normalizeSourceThread(sourceProfile, thread),
    );
    this.sourceThreadCache.set(
      sourceProfile,
      new Map(sourceThreads.map((thread) => [thread.threadId, thread])),
    );

    return {
      sourceProfile,
      fetchedAt: this.now(),
      projects: groupSourceThreads(sourceThreads),
    };
  }

  async startMigration(
    request: StartThreadMigrationRequest,
  ): Promise<StartThreadMigrationResponse> {
    const sourceProfile = normalizeSourceProfile(request.sourceProfile);
    await this.assertProfileSelectable(sourceProfile);

    const run: StartThreadMigrationResponse = {
      runId: this.createRunId(),
      operation: request.operation,
      startedAt: this.now(),
      items: request.threadIds.map((sourceThreadId) => ({
        sourceProfile,
        sourceThreadId,
        status: "pending",
      })),
    };

    migrationLog.info("thread migration run started", {
      copyStrategy: request.copyStrategy,
      operation: request.operation,
      runId: run.runId,
      sourceProfile,
      threadCount: request.threadIds.length,
      threadIds: request.threadIds,
    });

    for (const item of run.items) {
      await this.migrateOne({ item, request, runId: run.runId, sourceProfile });
    }

    migrationLog.info("thread migration run finished", {
      completedCount: run.items.filter((item) => item.status === "completed")
        .length,
      completedWithWarningsCount: run.items.filter(
        (item) =>
          item.status === "completed" && (item.warnings?.length ?? 0) > 0,
      ).length,
      failedCount: run.items.filter((item) => item.status === "failed").length,
      operation: request.operation,
      runId: run.runId,
      warningCount: run.items.reduce(
        (count, item) => count + (item.warnings?.length ?? 0),
        0,
      ),
    });

    return run;
  }

  async retryMigration(
    request: RetryThreadMigrationRequest,
  ): Promise<StartThreadMigrationResponse> {
    const sourceProfile = normalizeSourceProfile(request.sourceProfile);
    await this.assertProfileSelectable(sourceProfile);

    const run: StartThreadMigrationResponse = {
      runId: this.createRunId(),
      operation: request.operation,
      startedAt: this.now(),
      items: [
        {
          sourceProfile,
          sourceThreadId: request.threadId,
          status: "pending",
        },
      ],
    };
    const item = run.items[0]!;

    migrationLog.info("thread migration retry started", {
      copyStrategy: request.copyStrategy,
      operation: request.operation,
      runId: run.runId,
      sourceProfile,
      sourceThreadId: request.threadId,
    });

    const retrySourceState = await this.restoreSourceForRetry({
      item,
      runId: run.runId,
      sourceProfile,
    });
    if (item.status !== "failed") {
      await this.migrateOne({
        item,
        request: {
          copyStrategy: request.copyStrategy,
          operation: request.operation,
          sourceProfile,
          threadIds: [request.threadId],
        },
        runId: run.runId,
        sourceProfile,
      });
    }
    if (
      retrySourceState.wasArchived
      && item.diagnostics?.archivedSource !== true
    ) {
      await this.rearchiveSourceAfterRetry({
        item,
        runId: run.runId,
        sourceProfile,
      });
    }

    migrationLog.info("thread migration retry finished", {
      operation: request.operation,
      runId: run.runId,
      sourceProfile,
      sourceThreadId: request.threadId,
      status: item.status,
      warningCount: item.warnings?.length ?? 0,
    });

    return run;
  }

  async dispose(): Promise<void> {
    const clients = [...this.sourceClients.values()];
    this.sourceClients.clear();
    this.sourceThreadCache.clear();
    await Promise.allSettled(clients.map((client) => client.close()));
  }

  private async migrateOne(params: {
    item: ThreadMigrationRunItem;
    request: StartThreadMigrationRequest;
    runId: string;
    sourceProfile: string;
  }): Promise<void> {
    const { item, request, runId, sourceProfile } = params;
    let rollbackPreparedWorkspace: (() => Promise<void>) | undefined;
    try {
      const sourceThread = await this.resolveSourceThread(
        sourceProfile,
        item.sourceThreadId,
      );
      const sourceFacts = await inspectSourceThread(sourceThread);
      item.diagnostics = sourceFacts.diagnostics;
      item.warnings = sourceFacts.warnings;
      migrationLog.info("thread migration item starting", {
        ...item.diagnostics,
        operation: request.operation,
        runId,
        sourceProfile,
        sourceThreadId: item.sourceThreadId,
        warningCount: item.warnings.length,
        warnings: item.warnings,
      });
      if (!sourceThread.rolloutPath) {
        throw new Error(
          "Source CAS did not provide a rollout path for this thread.",
        );
      }
      if (
        request.operation === "copy"
        && request.copyStrategy
        && request.copyStrategy !== "detached-destination"
      ) {
        throw new Error(
          "Only detached destination Copy is implemented for branch/worktree migration.",
        );
      }
      const destinationWorkspace = resolveDestinationWorkspace(
        sourceThread,
        request,
      );
      item.diagnostics = {
        ...item.diagnostics,
        ...(destinationWorkspace.directoryPath
          ? { requestedDirectoryPath: destinationWorkspace.directoryPath }
          : {}),
        ...(destinationWorkspace.branchName
          ? { requestedBranchName: destinationWorkspace.branchName }
          : {}),
        ...(destinationWorkspace.worktreeBranchMode
          ? {
              requestedWorktreeBranchMode:
                destinationWorkspace.worktreeBranchMode,
            }
          : {}),
        requestedWorkMode: destinationWorkspace.workMode,
      };

      item.status = "copying";
      migrationLog.info("thread migration fork requested", {
        ...item.diagnostics,
        operation: request.operation,
        runId,
        sourceProfile,
        sourceThreadId: item.sourceThreadId,
      });
      const destination = await this.options.destination.forkThread({
        backend: "codex",
        sourceThreadId: sourceThread.threadId,
        sourceThreadPath: sourceThread.rolloutPath,
        onPreparedWorkspaceRollback: (rollback) => {
          rollbackPreparedWorkspace = rollback;
        },
        directoryKind: destinationWorkspace.directoryPath
          ? "directory"
          : "workspace",
        directoryLabel: destinationWorkspace.directoryLabel,
        directoryPath: destinationWorkspace.directoryPath,
        workMode: destinationWorkspace.workMode,
        ...(destinationWorkspace.worktreeBranchMode
          ? { worktreeBranchMode: destinationWorkspace.worktreeBranchMode }
          : {}),
        ...(destinationWorkspace.branchName
          ? { branchName: destinationWorkspace.branchName }
          : {}),
        ...(item.diagnostics?.sourceWorktreePath
          ? { excludedWorktreePaths: [item.diagnostics.sourceWorktreePath] }
          : {}),
      });
      item.destinationThreadId = destination.threadId;
      item.diagnostics = {
        ...item.diagnostics,
        ...(destination.linkedDirectory?.path
          ? { destinationDirectoryPath: destination.linkedDirectory.path }
          : {}),
        ...(destination.linkedDirectory?.worktreePath
          ? {
              destinationWorktreePath: destination.linkedDirectory.worktreePath,
            }
          : {}),
        destinationWorkMode: destination.workMode,
      };
      appendWarnings(
        item,
        validateDestinationWorkspaceResult(destinationWorkspace, destination),
      );
      migrationLog.info("thread migration fork completed", {
        ...item.diagnostics,
        destinationThreadId: destination.threadId,
        operation: request.operation,
        runId,
        sourceProfile,
        sourceThreadId: item.sourceThreadId,
        warningCount: item.warnings?.length ?? 0,
        warnings: item.warnings ?? [],
      });

      item.status = "validating";
      const sourceClient = await this.getSourceClient(sourceProfile);
      const [sourceReplay, destinationReplay] = await Promise.all([
        sourceClient.readThread({ threadId: sourceThread.threadId }),
        this.options.destination.readThread({
          backend: "codex",
          threadId: destination.threadId,
        }),
      ]);
      const validation: NonNullable<ThreadMigrationRunItem["validation"]> =
        validateReplay(sourceReplay, destinationReplay.replay);
      item.validation = validation;
      if (!validation.matched) {
        throw new Error("Destination replay did not match source replay.");
      }
      migrationLog.info("thread migration validation completed", {
        destinationThreadId: destination.threadId,
        matched: validation.matched,
        operation: request.operation,
        runId,
        sourceMessageCount: validation.sourceMessageCount,
        destinationMessageCount: validation.destinationMessageCount,
        sourceProfile,
        sourceThreadId: item.sourceThreadId,
      });

      item.status = "worktree";
      if (request.operation === "move") {
        item.status = "archiving-source";
        migrationLog.info("thread migration source archive requested", {
          destinationThreadId: destination.threadId,
          runId,
          sourceProfile,
          sourceThreadId: sourceThread.threadId,
        });
        await sourceClient.archiveThread({ threadId: sourceThread.threadId });
        item.diagnostics = {
          ...item.diagnostics,
          archivedSource: true,
        };
        migrationLog.info("thread migration source archived", {
          destinationThreadId: destination.threadId,
          runId,
          sourceProfile,
          sourceThreadId: sourceThread.threadId,
        });
      }

      item.status = "completed";
      rollbackPreparedWorkspace = undefined;
      const logPayload = {
        ...item.diagnostics,
        destinationThreadId: item.destinationThreadId,
        operation: request.operation,
        runId,
        sourceProfile,
        sourceThreadId: item.sourceThreadId,
        warningCount: item.warnings?.length ?? 0,
        warnings: item.warnings ?? [],
      };
      if (item.warnings?.length) {
        migrationLog.warn(
          "thread migration item completed with warnings",
          logPayload,
        );
      } else {
        migrationLog.info("thread migration item completed", logPayload);
      }
    } catch (error) {
      if (rollbackPreparedWorkspace) {
        try {
          await rollbackPreparedWorkspace();
          migrationLog.info("thread migration workspace rollback completed", {
            ...item.diagnostics,
            destinationThreadId: item.destinationThreadId,
            runId,
            sourceProfile,
            sourceThreadId: item.sourceThreadId,
          });
        } catch (rollbackError) {
          appendWarnings(item, [
            `Workspace rollback failed: ${
              rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError)
            }`,
          ]);
          migrationLog.warn("thread migration workspace rollback failed", {
            ...item.diagnostics,
            destinationThreadId: item.destinationThreadId,
            error:
              rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError),
            runId,
            sourceProfile,
            sourceThreadId: item.sourceThreadId,
          });
        }
      }
      item.status = "failed";
      item.error = error instanceof Error ? error.message : String(error);
      migrationLog.warn("thread migration item failed", {
        ...item.diagnostics,
        sourceProfile,
        sourceThreadId: item.sourceThreadId,
        destinationThreadId: item.destinationThreadId,
        status: item.status,
        error: item.error,
        runId,
        warningCount: item.warnings?.length ?? 0,
        warnings: item.warnings ?? [],
      });
    }
  }

  private async resolveSourceThread(
    sourceProfile: string,
    threadId: ThreadIdentifier,
  ): Promise<InternalSourceThread> {
    const cached = this.sourceThreadCache.get(sourceProfile)?.get(threadId);
    if (cached) {
      return cached;
    }

    await this.listSourceThreads({ sourceProfile });
    const refreshed = this.sourceThreadCache.get(sourceProfile)?.get(threadId);
    if (!refreshed) {
      throw new Error(`Source thread not found: ${threadId}`);
    }
    return refreshed;
  }

  private async restoreSourceForRetry(params: {
    item: ThreadMigrationRunItem;
    runId: string;
    sourceProfile: string;
  }): Promise<{ wasArchived: boolean }> {
    const { item, runId, sourceProfile } = params;
    let wasArchived = false;
    try {
      wasArchived = (
        await this.findSourceThreadState(sourceProfile, item.sourceThreadId)
      ).archived;
    } catch (error) {
      item.status = "failed";
      item.error = error instanceof Error ? error.message : String(error);
      migrationLog.warn("thread migration source retry lookup failed", {
        runId,
        sourceProfile,
        sourceThreadId: item.sourceThreadId,
        error: item.error,
      });
      return { wasArchived: false };
    }

    item.status = "restoring-source";
    migrationLog.info("thread migration source restore requested", {
      runId,
      sourceProfile,
      sourceThreadId: item.sourceThreadId,
    });
    try {
      const sourceClient = await this.getSourceClient(sourceProfile);
      await sourceClient.restoreThread({ threadId: item.sourceThreadId });
      this.sourceThreadCache.delete(sourceProfile);
      const refreshed = await this.refreshSourceThread(
        sourceProfile,
        item.sourceThreadId,
      );
      const sourceFacts = await inspectSourceThread(refreshed);
      item.diagnostics = sourceFacts.diagnostics;
      item.warnings = sourceFacts.warnings;
      migrationLog.info("thread migration source restore completed", {
        ...item.diagnostics,
        runId,
        sourceProfile,
        sourceThreadId: item.sourceThreadId,
        warningCount: item.warnings.length,
        warnings: item.warnings,
      });
      item.status = "pending";
      return { wasArchived };
    } catch (error) {
      item.status = "failed";
      item.error = error instanceof Error ? error.message : String(error);
      migrationLog.warn("thread migration source restore failed", {
        runId,
        sourceProfile,
        sourceThreadId: item.sourceThreadId,
        error: item.error,
      });
      return { wasArchived };
    }
  }

  private async rearchiveSourceAfterRetry(params: {
    item: ThreadMigrationRunItem;
    runId: string;
    sourceProfile: string;
  }): Promise<void> {
    const { item, runId, sourceProfile } = params;
    try {
      const sourceClient = await this.getSourceClient(sourceProfile);
      migrationLog.info("thread migration retry source rearchive requested", {
        runId,
        sourceProfile,
        sourceThreadId: item.sourceThreadId,
        status: item.status,
      });
      await sourceClient.archiveThread({ threadId: item.sourceThreadId });
      item.diagnostics = {
        ...item.diagnostics,
        archivedSource: true,
      };
      migrationLog.info("thread migration retry source rearchived", {
        runId,
        sourceProfile,
        sourceThreadId: item.sourceThreadId,
        status: item.status,
      });
    } catch (error) {
      appendWarnings(item, [
        `Retry source rearchive failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ]);
      migrationLog.warn("thread migration retry source rearchive failed", {
        error: error instanceof Error ? error.message : String(error),
        runId,
        sourceProfile,
        sourceThreadId: item.sourceThreadId,
        status: item.status,
      });
    }
  }

  private async findSourceThreadState(
    sourceProfile: string,
    threadId: ThreadIdentifier,
  ): Promise<{ archived: boolean; thread: InternalSourceThread }> {
    await this.listSourceThreads({ sourceProfile });
    const active = this.sourceThreadCache.get(sourceProfile)?.get(threadId);
    if (active) {
      return { archived: false, thread: active };
    }

    await this.listSourceThreads({ sourceProfile, archived: true });
    const archived = this.sourceThreadCache.get(sourceProfile)?.get(threadId);
    if (archived) {
      return { archived: true, thread: archived };
    }

    throw new Error(`Source thread not found for retry: ${threadId}`);
  }

  private async refreshSourceThread(
    sourceProfile: string,
    threadId: ThreadIdentifier,
  ): Promise<InternalSourceThread> {
    await this.listSourceThreads({ sourceProfile });
    const active = this.sourceThreadCache.get(sourceProfile)?.get(threadId);
    if (active) {
      return active;
    }

    await this.listSourceThreads({ sourceProfile, archived: true });
    const archived = this.sourceThreadCache.get(sourceProfile)?.get(threadId);
    if (!archived) {
      throw new Error(`Source thread not found after restore: ${threadId}`);
    }
    return archived;
  }

  private async assertProfileSelectable(sourceProfile: string): Promise<void> {
    const sources = await this.listSources();
    const source = sources.profiles.find(
      (profile) => profile.profile === sourceProfile,
    );
    if (!source) {
      throw new Error("Source profile is not available for migration.");
    }
    if (!source.available) {
      throw new Error(
        source.unavailableReason ?? "Source profile is unavailable.",
      );
    }
  }

  private async getSourceClient(
    sourceProfile: string,
  ): Promise<SourceMigrationClient> {
    const cached = this.sourceClients.get(sourceProfile);
    if (cached) {
      return cached;
    }

    const source = (await this.listSources()).profiles.find(
      (profile) => profile.profile === sourceProfile,
    );
    const codexHome =
      source?.codexHome ?? resolveCodexHome(sourceProfile, this.options);
    const settingsService = this.getSettingsService();
    const baseEnv = settingsService.resolveCodexSpawnEnv();
    const env = {
      ...baseEnv,
      CODEX_HOME: codexHome,
    };
    const command = settingsService.resolveCodexCommandPreference();
    const client =
      this.options.sourceClientFactory?.({
        codexHome,
        command,
        env,
        profile: sourceProfile,
      })
      ?? new CodexAppServerClient({
        args: buildCodexClientArgs(env),
        command,
        env,
      });
    this.sourceClients.set(sourceProfile, client);
    return client;
  }

  private getSettingsService(): Pick<
    DesktopSettingsService,
    "readSettings" | "resolveCodexCommandPreference" | "resolveCodexSpawnEnv"
  > {
    return this.options.settingsService ?? getDesktopSettingsService();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private createRunId(): string {
    return this.options.idFactory?.() ?? randomUUID();
  }
}

function resolveCodexHome(
  sourceProfile: string,
  options: Pick<ThreadMigrationServiceOptions, "env" | "homeDir">,
): string {
  if (!sourceProfile) {
    return resolveDefaultCodexHome(options);
  }
  const codexHome = resolveCodexHomeForProfile(sourceProfile, options);
  if (!codexHome) {
    throw new Error("Invalid source profile.");
  }
  return codexHome;
}

function normalizeSourceProfile(value: string | undefined): string {
  const raw = value?.trim() ?? "";
  if (!raw) {
    return "";
  }
  const normalized = normalizeProfileName(raw);
  if (!normalized) {
    throw new Error(`Invalid Codex profile "${value}".`);
  }
  return normalized;
}

function normalizeSourceThread(
  sourceProfile: string,
  thread: CodexThreadMigrationMetadata,
): InternalSourceThread {
  return {
    sourceProfile,
    threadId: thread.id,
    title: thread.title,
    ...(thread.summary ? { summary: thread.summary } : {}),
    ...(thread.projectKey ? { projectKey: thread.projectKey } : {}),
    ...(thread.createdAt ? { createdAt: thread.createdAt } : {}),
    ...(thread.updatedAt ? { updatedAt: thread.updatedAt } : {}),
    ...(thread.archivedAt ? { archivedAt: thread.archivedAt } : {}),
    ...(thread.gitBranch ? { gitBranch: thread.gitBranch } : {}),
    ...(thread.gitOriginUrl ? { gitOriginUrl: thread.gitOriginUrl } : {}),
    linkedDirectories: thread.linkedDirectories ?? [],
    ...(thread.rolloutPath ? { rolloutPath: thread.rolloutPath } : {}),
  };
}

function groupSourceThreads(
  threads: InternalSourceThread[],
): ThreadMigrationSourceProjectGroup[] {
  const threadByKey = new Map(
    threads.map((thread) => [
      buildThreadIdentityKey("codex", thread.threadId),
      thread,
    ]),
  );
  const groupedThreadKeys = new Set<string>();
  const groups = buildDirectorySummaries({
    threads: threads.map(toNavigationThreadSummary),
  }).map((directory): ThreadMigrationSourceProjectGroup => {
    const groupThreads = directory.threadKeys
      .map((threadKey) => {
        groupedThreadKeys.add(threadKey);
        return threadByKey.get(threadKey);
      })
      .filter((thread): thread is InternalSourceThread => Boolean(thread))
      .map(stripInternalThread);

    return {
      key: directory.key,
      label: directory.label,
      ...(directory.path ? { path: directory.path } : {}),
      threads: groupThreads,
    };
  });

  for (const thread of threads) {
    const threadKey = buildThreadIdentityKey("codex", thread.threadId);
    if (groupedThreadKeys.has(threadKey)) {
      continue;
    }
    const projectPath = thread.projectKey?.trim();
    groups.push({
      key: projectPath ? `directory:${projectPath}` : "unlinked",
      label: projectPath
        ? path.basename(projectPath) || projectPath
        : "No project",
      ...(projectPath ? { path: projectPath } : {}),
      threads: [stripInternalThread(thread)],
    });
  }

  return groups
    .filter((group) => group.threads.length > 0)
    .sort((left, right) => left.label.localeCompare(right.label));
}

function toNavigationThreadSummary(
  thread: InternalSourceThread,
): NavigationThreadSummary {
  return {
    id: thread.threadId,
    source: "codex",
    title: thread.title,
    titleSource: "explicit",
    linkedDirectories: thread.linkedDirectories,
    inbox: { inInbox: false },
    ...(thread.summary ? { summary: thread.summary } : {}),
    ...(thread.projectKey ? { projectKey: thread.projectKey } : {}),
    ...(thread.createdAt ? { createdAt: thread.createdAt } : {}),
    ...(thread.updatedAt ? { updatedAt: thread.updatedAt } : {}),
    ...(thread.archivedAt ? { archivedAt: thread.archivedAt } : {}),
    ...(thread.gitBranch ? { gitBranch: thread.gitBranch } : {}),
    ...(thread.gitOriginUrl ? { gitOriginUrl: thread.gitOriginUrl } : {}),
  };
}

function stripInternalThread(
  thread: InternalSourceThread,
): ThreadMigrationSourceThreadSummary {
  const { rolloutPath: _rolloutPath, ...publicThread } = thread;
  return publicThread;
}

function hasProfileOwnedWorktree(
  thread: Pick<InternalSourceThread, "linkedDirectories" | "projectKey">,
): boolean {
  return Boolean(
    (thread.projectKey && isToolManagedWorktreePath(thread.projectKey))
    || thread.linkedDirectories.some(
      (directory) =>
        Boolean(directory)
        && typeof directory === "object"
        && (isToolManagedWorktreePath(directory.worktreePath)
          || isToolManagedWorktreePath(directory.path)),
    ),
  );
}

function resolveDestinationWorkspace(
  thread: Pick<
    InternalSourceThread,
    "gitBranch" | "linkedDirectories" | "projectKey" | "title"
  >,
  request: Pick<StartThreadMigrationRequest, "copyStrategy" | "operation">,
): {
  branchName?: string;
  directoryLabel: string;
  directoryPath?: string;
  workMode: ForkThreadRequest["workMode"];
  worktreeBranchMode?: ForkThreadRequest["worktreeBranchMode"];
} {
  const directoryPath = resolveDestinationDirectoryPath(thread);
  const sourceHasProfileOwnedWorktree = hasProfileOwnedWorktree(thread);
  if (sourceHasProfileOwnedWorktree && !directoryPath) {
    throw new Error(
      "Move is blocked because the source managed worktree did not report its repository path.",
    );
  }
  const branchName =
    thread.gitBranch && thread.gitBranch !== "HEAD"
      ? thread.gitBranch
      : undefined;
  if (sourceHasProfileOwnedWorktree && !branchName) {
    throw new Error(
      "Migration is blocked because the source managed worktree did not report an attached branch.",
    );
  }
  const needsDestinationWorktree =
    Boolean(directoryPath && branchName)
    && ((request.operation === "move" && sourceHasProfileOwnedWorktree)
      || request.copyStrategy === "detached-destination");

  return {
    directoryLabel: directoryPath ? path.basename(directoryPath) : thread.title,
    ...(directoryPath ? { directoryPath } : {}),
    ...(branchName ? { branchName } : {}),
    ...(needsDestinationWorktree
      ? {
          worktreeBranchMode:
            request.operation === "move" ? "attached" : "detached",
        }
      : {}),
    workMode: needsDestinationWorktree ? "worktree" : "local",
  };
}

function resolveDestinationDirectoryPath(
  thread: Pick<InternalSourceThread, "linkedDirectories" | "projectKey">,
): string | undefined {
  for (const directory of thread.linkedDirectories) {
    const directoryPath = directory.path?.trim();
    if (directoryPath && !isToolManagedWorktreePath(directoryPath)) {
      return directoryPath;
    }
  }

  const projectKey = thread.projectKey?.trim();
  if (projectKey && !isToolManagedWorktreePath(projectKey)) {
    return projectKey;
  }

  return undefined;
}

async function inspectSourceThread(thread: InternalSourceThread): Promise<{
  diagnostics: MigrationDiagnostics;
  warnings: string[];
}> {
  const sourceDirectoryPath = resolveDestinationDirectoryPath(thread);
  const sourceWorktreePath = resolveSourceWorktreePath(thread);
  const sourceGitBranch =
    thread.gitBranch && thread.gitBranch !== "HEAD"
      ? thread.gitBranch
      : undefined;
  const [sourceDirectoryExists, sourceWorktreeExists, sourceBranchExists] =
    await Promise.all([
      pathExists(sourceDirectoryPath),
      pathExists(sourceWorktreePath),
      gitBranchExists(sourceDirectoryPath, sourceGitBranch),
    ]);
  const diagnostics: MigrationDiagnostics = {
    sourceTitle: thread.title,
    ...(thread.archivedAt ? { sourceArchivedAt: thread.archivedAt } : {}),
    ...(thread.projectKey ? { sourceProjectKey: thread.projectKey } : {}),
    ...(sourceDirectoryPath ? { sourceDirectoryPath } : {}),
    ...(sourceDirectoryExists === undefined ? {} : { sourceDirectoryExists }),
    ...(sourceWorktreePath ? { sourceWorktreePath } : {}),
    ...(sourceGitBranch ? { sourceGitBranch } : {}),
    ...(sourceWorktreeExists === undefined ? {} : { sourceWorktreeExists }),
    ...(sourceBranchExists === undefined ? {} : { sourceBranchExists }),
  };
  const warnings: string[] = [];
  if (thread.archivedAt) {
    warnings.push("Source thread was already archived before migration.");
  }
  if (sourceDirectoryPath && sourceDirectoryExists === false) {
    warnings.push(
      `Source project directory was not found: ${sourceDirectoryPath}`,
    );
  }
  if (sourceWorktreePath && sourceWorktreeExists === false) {
    warnings.push(`Source worktree was not found: ${sourceWorktreePath}`);
  }
  if (sourceGitBranch && sourceBranchExists === false) {
    warnings.push(`Source branch was not found: ${sourceGitBranch}`);
  }
  return { diagnostics, warnings };
}

function resolveSourceWorktreePath(
  thread: Pick<InternalSourceThread, "linkedDirectories" | "projectKey">,
): string | undefined {
  for (const directory of thread.linkedDirectories) {
    const worktreePath = directory.worktreePath?.trim();
    if (worktreePath && isToolManagedWorktreePath(worktreePath)) {
      return worktreePath;
    }
    const directoryPath = directory.path?.trim();
    if (directoryPath && isToolManagedWorktreePath(directoryPath)) {
      return directoryPath;
    }
  }
  const projectKey = thread.projectKey?.trim();
  if (projectKey && isToolManagedWorktreePath(projectKey)) {
    return projectKey;
  }
  return undefined;
}

async function pathExists(
  filesystemPath: string | undefined,
): Promise<boolean | undefined> {
  if (!filesystemPath) {
    return undefined;
  }
  try {
    await access(filesystemPath);
    return true;
  } catch {
    return false;
  }
}

async function gitBranchExists(
  repositoryPath: string | undefined,
  branchName: string | undefined,
): Promise<boolean | undefined> {
  if (!repositoryPath || !branchName) {
    return undefined;
  }
  try {
    await execFileAsync("git", [
      "-C",
      repositoryPath,
      "rev-parse",
      "--verify",
      `${branchName}^{commit}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

function validateDestinationWorkspaceResult(
  requested: ReturnType<typeof resolveDestinationWorkspace>,
  destination: ForkThreadResponse,
): string[] {
  const warnings: string[] = [];
  if (
    requested.workMode === "worktree"
    && destination.workMode !== "worktree"
  ) {
    warnings.push(
      `Destination returned ${destination.workMode} even though migration requested a worktree.`,
    );
  }
  if (
    requested.workMode === "worktree"
    && !destination.linkedDirectory?.worktreePath
  ) {
    warnings.push("Destination did not report a worktree path.");
  }
  return warnings;
}

function appendWarnings(
  item: ThreadMigrationRunItem,
  warnings: string[],
): void {
  if (warnings.length === 0) {
    return;
  }
  item.warnings = [...(item.warnings ?? []), ...warnings];
}

function validateReplay(
  source: AppServerThreadReplay,
  destination: AppServerThreadReplay,
): NonNullable<ThreadMigrationRunItem["validation"]> {
  const sourceFingerprint = fingerprintReplay(source);
  const destinationFingerprint = fingerprintReplay(destination);
  return {
    sourceMessageCount: sourceFingerprint.length,
    destinationMessageCount: destinationFingerprint.length,
    matched:
      sourceFingerprint.length === destinationFingerprint.length
      && sourceFingerprint.every(
        (entry, index) => entry === destinationFingerprint[index],
      ),
  };
}

function fingerprintReplay(replay: AppServerThreadReplay): string[] {
  return replay.messages.map((message) =>
    JSON.stringify({
      role: message.role,
      text: message.text,
      parts: message.parts?.map((part) =>
        part.type === "text"
          ? { type: "text", text: part.text }
          : { type: "image", alt: part.alt ?? "", url: part.url },
      ),
    }),
  );
}
