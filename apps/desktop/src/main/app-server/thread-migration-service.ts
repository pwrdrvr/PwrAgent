import { randomUUID } from "node:crypto";
import path from "node:path";
import { buildDirectorySummaries } from "@pwragent/agent-core";
import {
  buildThreadIdentityKey,
  isToolManagedWorktreePath,
  type AppServerThreadReplay,
  type ForkThreadRequest,
  type ForkThreadResponse,
  type LinkedDirectorySummary,
  type ListThreadMigrationSourceThreadsRequest,
  type ListThreadMigrationSourceThreadsResponse,
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
} from "../settings/codex-profiles";
import {
  CodexAppServerClient,
  type CodexThreadMigrationMetadata,
} from "../codex-app-server/client";
import { buildCodexClientArgs } from "./backend-registry";

const migrationLog = getMainLogger("pwragent:thread-migration");

type SourceMigrationClient = Pick<
  CodexAppServerClient,
  "archiveThread" | "close" | "listThreadsForMigration" | "readThread"
>;

type DestinationMigrationBackend = {
  forkThread(
    request: ForkThreadRequest & { sourceThreadPath?: string },
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
      settings.models.codex.profiles ??
      discoverCodexAuthProfiles({
        configuredProfile: activeCodexProfile,
        env: this.options.env,
        homeDir: this.options.homeDir,
      });

    return {
      activeCodexProfile,
      profiles: discovery.profiles
        .filter((profile) => normalizeSourceProfile(profile.name) !== activeCodexProfile)
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
            ...(profile.accountEmail ? { accountEmail: profile.accountEmail } : {}),
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
      archived: request.archived,
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

    for (const item of run.items) {
      await this.migrateOne({ item, request, sourceProfile });
    }

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
    sourceProfile: string;
  }): Promise<void> {
    const { item, request, sourceProfile } = params;
    try {
      const sourceThread = await this.resolveSourceThread(
        sourceProfile,
        item.sourceThreadId,
      );
      if (!sourceThread.rolloutPath) {
        throw new Error("Source CAS did not provide a rollout path for this thread.");
      }
      if (hasProfileOwnedWorktree(sourceThread.linkedDirectories)) {
        throw new Error(
          request.operation === "copy"
            ? "Copy is blocked until branch conflict strategies for profile-owned worktrees are implemented."
            : "Move is blocked until this thread's profile-owned worktree can be migrated first.",
        );
      }

      item.status = "copying";
      const destination = await this.options.destination.forkThread({
        backend: "codex",
        sourceThreadId: sourceThread.threadId,
        sourceThreadPath: sourceThread.rolloutPath,
        directoryKind: sourceThread.projectKey ? "directory" : "workspace",
        directoryLabel: sourceThread.projectKey
          ? path.basename(sourceThread.projectKey)
          : sourceThread.title,
        directoryPath: sourceThread.projectKey,
        workMode: "local",
      });
      item.destinationThreadId = destination.threadId;

      item.status = "validating";
      const sourceClient = await this.getSourceClient(sourceProfile);
      const [sourceReplay, destinationReplay] = await Promise.all([
        sourceClient.readThread({ threadId: sourceThread.threadId }),
        this.options.destination.readThread({
          backend: "codex",
          threadId: destination.threadId,
        }),
      ]);
      const validation: NonNullable<ThreadMigrationRunItem["validation"]> = validateReplay(
        sourceReplay,
        destinationReplay.replay,
      );
      item.validation = validation;
      if (!validation.matched) {
        throw new Error("Destination replay did not match source replay.");
      }

      item.status = "worktree";
      if (request.operation === "move") {
        item.status = "archiving-source";
        await sourceClient.archiveThread({ threadId: sourceThread.threadId });
      }

      item.status = "completed";
    } catch (error) {
      item.status = "failed";
      item.error = error instanceof Error ? error.message : String(error);
      migrationLog.warn("thread migration item failed", {
        sourceProfile,
        sourceThreadId: item.sourceThreadId,
        destinationThreadId: item.destinationThreadId,
        status: item.status,
        error: item.error,
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

  private async assertProfileSelectable(sourceProfile: string): Promise<void> {
    const sources = await this.listSources();
    const source = sources.profiles.find((profile) => profile.profile === sourceProfile);
    if (!source) {
      throw new Error("Source profile is not available for migration.");
    }
    if (!source.available) {
      throw new Error(source.unavailableReason ?? "Source profile is unavailable.");
    }
  }

  private async getSourceClient(sourceProfile: string): Promise<SourceMigrationClient> {
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
      }) ??
      new CodexAppServerClient({
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
    linkedDirectories: thread.linkedDirectories,
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
      label: projectPath ? path.basename(projectPath) || projectPath : "No project",
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
  };
}

function stripInternalThread(
  thread: InternalSourceThread,
): ThreadMigrationSourceThreadSummary {
  const { rolloutPath: _rolloutPath, ...publicThread } = thread;
  return publicThread;
}

function hasProfileOwnedWorktree(directories: LinkedDirectorySummary[]): boolean {
  return directories.some(
    (directory) =>
      isToolManagedWorktreePath(directory.worktreePath) ||
      isToolManagedWorktreePath(directory.path),
  );
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
      sourceFingerprint.length === destinationFingerprint.length &&
      sourceFingerprint.every((entry, index) => entry === destinationFingerprint[index]),
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
