import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HandoffInstanceThreadRequest, HandoffInstanceThreadResult, ThreadHandoffExport } from "@pwragent/shared";
import { exportGitHandoff, importGitHandoff } from "../app-server/git-instance-handoff";
import { runGitCommand } from "../app-server/git-executable";
import { computeWorktreePath, releaseWorktreePathReservation } from "../app-server/git-directory-service";
import type { FilePushResult } from "./federation-file-push";
import { decodeHandoffBytes, decodeThreadHandoff, encodeThreadHandoff, threadHistoryDigest, THREAD_HANDOFF_MAX_BYTES } from "./thread-handoff-package";

export const THREAD_HANDOFF_METHODS = {
  send: "thread.handoff.send",
  import: "thread.handoff.import",
  prepare: "thread.handoff.prepare",
} as const;

export type ImportInstanceThreadRequest = {
  handoffId: string;
  file: FilePushResult;
  targetRepositoryPath?: string;
};

type HandoffBackend = {
  withThreadHandoff<T>(threadId: string, work: () => Promise<T>): Promise<T>;
  exportThreadForHandoff(threadId: string): Promise<ThreadHandoffExport>;
  forkThread(request: { backend: "codex"; sourceThreadId: string; sourceThreadPath: string; directoryPath: string; directoryKind: "directory"; directoryLabel?: string; workMode: "local" | "worktree"; importedWorktree?: { repositoryPath: string; worktreePath: string } }): Promise<{ threadId: string }>;
  readThread(request: { backend: "codex"; threadId: string }): Promise<{ replay: ThreadHandoffExport["replay"] }>;
  archiveThread(request: { backend: "codex"; threadId: string; preserveWorktrees?: boolean }): Promise<unknown>;
  renameThread(request: { backend: "codex"; threadId: string; name: string }): Promise<unknown>;
  /** Reserves a worktree path under the receiver's Worktrees setting. */
  allocateHandoffWorktreePath?(repositoryPath: string): Promise<string>;
};

/**
 * Settled imports kept for acknowledgement retries. A sender retries the same
 * handoff ID only within one transfer, so the oldest settled entry can go.
 */
const IMPORT_CACHE_LIMIT = 128;

export class ThreadInstanceHandoffService {
  private readonly imports = new Map<string, { fingerprint: string; result: Promise<HandoffInstanceThreadResult>; settled?: true }>();

  constructor(private readonly options: {
    backend: HandoffBackend;
    directory: string;
    localInstanceId: () => string;
    push: (instanceId: string, source: string) => Promise<FilePushResult>;
    remoteImport: (instanceId: string, request: ImportInstanceThreadRequest) => Promise<HandoffInstanceThreadResult>;
    assertTarget: (instanceId: string) => void;
    prepareTarget?: (instanceId: string, repository: string) => Promise<string[]>;
    /** Creates the directory a history-only import starts in (Workspaces). */
    createHistoryWorkspace?: () => Promise<string>;
    assertMovable?: (threadId: string) => Promise<void>;
    receipt: (sourceInstanceId: string, file: FilePushResult) => boolean;
  }) {}

  async send(request: HandoffInstanceThreadRequest): Promise<HandoffInstanceThreadResult> {
    if (!request || !request.sourceThreadId || typeof request.sourceThreadId !== "string"
      || typeof request.targetInstanceId !== "string" || !request.targetInstanceId
      || !["copy", "move"].includes(request.operation)
      || (request.targetRepositoryPath !== undefined && typeof request.targetRepositoryPath !== "string")) {
      throw new Error("Invalid thread handoff request.");
    }
    this.options.assertTarget(request.targetInstanceId);
    return await this.options.backend.withThreadHandoff(request.sourceThreadId, async () => {
      if (request.operation === "move") await this.options.assertMovable?.(request.sourceThreadId);
      await mkdir(this.options.directory, { recursive: true });
      const staging = await mkdtemp(path.join(this.options.directory, "outgoing-"));
      try {
        const source = await this.options.backend.exportThreadForHandoff(request.sourceThreadId);
        const historyDigest = threadHistoryDigest(source.replay);
        let repository: string | undefined;
        if (source.cwd) {
          if (!(await stat(source.cwd)).isDirectory()) throw new Error("The source workspace is not an available directory.");
          repository = await runGitCommand(source.cwd, ["rev-parse", "--show-toplevel"])
            .then((result) => result.stdout.trim())
            .catch((error: unknown) => {
              const stderr = error && typeof error === "object" && "stderr" in error ? error.stderr : undefined;
              if (typeof stderr === "string" && /not a git repository/i.test(stderr)) return undefined;
              throw error;
            });
        }
        if (repository && !request.targetRepositoryPath?.trim()) {
          throw new Error("Choose the existing repository path on the receiving machine before transferring a Git thread.");
        }
        const handoffId = randomUUID();
        const filePath = path.join(staging, `${handoffId}.pwragent-handoff.gz`);
        const receiverCommits = repository && request.targetRepositoryPath
          ? await this.options.prepareTarget?.(request.targetInstanceId, request.targetRepositoryPath) ?? []
          : [];
        const git = repository ? await exportGitHandoff(repository, staging, receiverCommits) : undefined;
        if (git && repository && source.cwd) {
          const relative = path.relative(await realpath(repository), await realpath(source.cwd)).split(path.sep).join("/");
          if (relative) git.cwdRelative = relative;
        }
        await writeFile(filePath, await encodeThreadHandoff({
          version: 1, handoffId, sourceThreadId: request.sourceThreadId,
          rolloutBase64: source.rolloutBase64, historyDigest,
          ...(source.title ? { title: source.title } : {}), ...(git ? { git } : {}),
        }), { mode: 0o600, flag: "wx" });
        const file = await this.options.push(request.targetInstanceId, filePath);
        const destination = await this.options.remoteImport(request.targetInstanceId, {
          handoffId, file, ...(request.targetRepositoryPath ? { targetRepositoryPath: request.targetRepositoryPath } : {}),
        });
        if (destination.handoffId !== handoffId || destination.sourceThreadId !== request.sourceThreadId
          || destination.instanceId !== request.targetInstanceId || !destination.threadId) {
          throw new Error("The receiver returned an invalid handoff acknowledgement. The source was retained.");
        }
        if (request.operation === "move") {
          try {
            await this.options.assertMovable?.(request.sourceThreadId);
            const current = await this.options.backend.exportThreadForHandoff(request.sourceThreadId);
            if (threadHistoryDigest(current.replay) !== historyDigest) throw new Error("Source history changed during transfer.");
            await this.options.backend.archiveThread({ backend: "codex", threadId: request.sourceThreadId, preserveWorktrees: true });
            destination.sourceArchived = true;
          } catch (error) {
            destination.warnings.push(`Destination is ready; source archival was not confirmed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return destination;
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
  }

  async receive(sourceInstanceId: string, request: ImportInstanceThreadRequest): Promise<HandoffInstanceThreadResult> {
    if (!request || typeof request.handoffId !== "string" || !/^[0-9a-f-]{36}$/.test(request.handoffId)
      || !request.file || !this.options.receipt(sourceInstanceId, request.file)
      || (request.targetRepositoryPath !== undefined && (typeof request.targetRepositoryPath !== "string" || !path.isAbsolute(request.targetRepositoryPath)))) {
      throw new Error("Thread import requires a verified file pushed by this peer and an absolute destination path.");
    }
    const key = `${sourceInstanceId}:${request.handoffId}`;
    const fingerprint = JSON.stringify(request);
    const existing = this.imports.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("Handoff ID was reused with different inputs.");
      return await existing.result;
    }
    if (this.imports.size >= IMPORT_CACHE_LIMIT) this.evictSettledImport();
    const entry: { fingerprint: string; result: Promise<HandoffInstanceThreadResult>; settled?: true } = {
      fingerprint, result: this.importOne(request),
    };
    void entry.result.then(() => { entry.settled = true; }, () => { entry.settled = true; });
    this.imports.set(key, entry);
    return await entry.result;
  }

  private evictSettledImport(): void {
    for (const [key, entry] of this.imports) {
      if (entry.settled) {
        this.imports.delete(key);
        return;
      }
    }
    throw new Error(`Thread import limit reached: ${IMPORT_CACHE_LIMIT} imports are still in progress.`);
  }

  private async importOne(request: ImportInstanceThreadRequest): Promise<HandoffInstanceThreadResult> {
    const info = await stat(request.file.path);
    if (!info.isFile() || info.size !== request.file.sizeBytes || info.size > THREAD_HANDOFF_MAX_BYTES) throw new Error("Incoming handoff file has changed or exceeds 128 MiB.");
    const bytes = await readFile(request.file.path);
    if (createHash("sha256").update(bytes).digest("hex") !== request.file.sha256) throw new Error("Incoming handoff checksum changed.");
    // The package holds the transcript and every workspace file. Once its bytes
    // are verified in memory, the file-push folder (Downloads by default) must
    // not keep a copy, whether or not the import succeeds.
    await rm(request.file.path, { force: true });
    const pkg = await decodeThreadHandoff(bytes);
    if (pkg.handoffId !== request.handoffId) throw new Error("Incoming handoff ID did not match.");
    if (pkg.git && !request.targetRepositoryPath) throw new Error("A Git handoff requires an existing destination repository.");
    const repository = pkg.git
      ? (await runGitCommand(request.targetRepositoryPath!, ["rev-parse", "--show-toplevel"])).stdout.trim()
      : undefined;
    await mkdir(this.options.directory, { recursive: true });
    const staging = await mkdtemp(path.join(this.options.directory, "incoming-"));
    let workspace: string | undefined;
    let rollback: (() => Promise<void>) | undefined;
    let threadId: string | undefined;
    let forkAttempted = false;
    try {
      const rollout = path.join(staging, "thread.jsonl");
      await writeFile(rollout, decodeHandoffBytes(pkg.rolloutBase64), { mode: 0o600, flag: "wx" });
      if (pkg.git && repository) {
        workspace = await (this.options.backend.allocateHandoffWorktreePath?.(repository)
          ?? computeWorktreePath({ repoRoot: repository, storage: "in-repo" }));
        const bundlePath = path.join(staging, "workspace.bundle");
        await writeFile(bundlePath, decodeHandoffBytes(pkg.git.bundleBase64), { mode: 0o600, flag: "wx" });
        rollback = await importGitHandoff({ repository: request.targetRepositoryPath!, worktree: workspace, bundlePath, snapshot: pkg.git });
      } else {
        const created = await this.createHistoryWorkspace(pkg.handoffId);
        workspace = created;
        rollback = async () => await rm(created, { recursive: true, force: true });
      }
      const cwd = pkg.git?.cwdRelative ? path.join(workspace, ...pkg.git.cwdRelative.split("/")) : workspace;
      await mkdir(cwd, { recursive: true });
      forkAttempted = true;
      const result = await this.options.backend.forkThread({
        backend: "codex", sourceThreadId: pkg.sourceThreadId, sourceThreadPath: rollout,
        directoryPath: cwd,
        directoryKind: "directory", workMode: repository ? "worktree" : "local",
        ...(repository ? { directoryLabel: path.basename(repository), importedWorktree: { repositoryPath: repository, worktreePath: workspace } } : {}),
      });
      threadId = result.threadId;
      const destination = await this.options.backend.readThread({ backend: "codex", threadId });
      if (threadHistoryDigest(destination.replay) !== pkg.historyDigest) throw new Error("Destination history did not match the source.");
      const warnings: string[] = [];
      warnings.push("PwrAgent PR tracking, schedules, messaging bindings, and thread grouping remain on the source instance.");
      if (pkg.title) await this.options.backend.renameThread({ backend: "codex", threadId, name: pkg.title })
        .catch(() => warnings.push("Thread history transferred; the title could not be restored."));
      if (pkg.git?.sourceBranch) warnings.push(`Workspace is detached at the source commit. Original branch: ${pkg.git.sourceBranch}.`);
      return { handoffId: pkg.handoffId, sourceThreadId: pkg.sourceThreadId, instanceId: this.options.localInstanceId(), backend: "codex", threadId, directoryPath: cwd, sourceArchived: false, warnings };
    } catch (error) {
      // A rejected fork can follow successful provider creation or a lost response.
      // Without an ID we cannot retire that thread, so preserve its checkout.
      if (forkAttempted && !threadId) {
        throw new Error(`Destination creation could not be confirmed. Workspace retained at ${workspace}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      if (threadId) await this.options.backend.archiveThread({ backend: "codex", threadId, preserveWorktrees: true });
      await rollback?.();
      if (repository && workspace) await releaseWorktreePathReservation(workspace);
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async createHistoryWorkspace(handoffId: string): Promise<string> {
    if (this.options.createHistoryWorkspace) return await this.options.createHistoryWorkspace();
    const workspace = path.join(this.options.directory, "workspaces", handoffId);
    await mkdir(path.dirname(workspace), { recursive: true });
    await mkdir(workspace);
    return workspace;
  }
}
