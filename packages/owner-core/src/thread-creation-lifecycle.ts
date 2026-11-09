import { isAcpBackendId, type AppServerBackendKind, type SetThreadModelSettingsRequest, type StartThreadResponse } from "@pwragent/shared";

export type CreatedThreadIdentity = { backend: AppServerBackendKind; threadId: string };
export type CreatedThreadParent = { parentThreadId: string; parentThreadBackend?: AppServerBackendKind };
export type ThreadCreationStage = "workspace" | "revoke-connections" | "rollback-workspace" | "pdf" | "connections" | "pending"
  | "placeholder" | "worktree" | "invalidate" | "execution" | "token-miser" | "pdf-catalog" | "git"
  | "pr" | "mcp" | "agent" | "environment" | "model" | "parent" | "parent-event" | "visibility" | "started";

type Visibility = Pick<StartThreadResponse, "pinnedRank" | "autoPinFailure">;

export interface ThreadCreationHost {
  providers: {
    codex(): Promise<{ threadId: string }>;
    claude(): Promise<{ threadId: string }>;
    acp(): Promise<{ threadId: string }>;
  };
  withWorkspaceWrite(work: () => Promise<{ threadId: string }>): Promise<{ threadId: string }>;
  connections: ReadonlyArray<{ bindThread(threadId: string): void; revoke(): void }>;
  rollbackWorkspace(): Promise<void>;
  rejection(error: unknown): unknown;
  bindPdf(identity: CreatedThreadIdentity): void;
  rememberPending(identity: CreatedThreadIdentity): Promise<void>;
  markPlaceholder(identity: CreatedThreadIdentity): void;
  recordWorktreeOwner(identity: CreatedThreadIdentity): Promise<void>;
  invalidate(identity: CreatedThreadIdentity): void;
  persistExecutionMode(identity: CreatedThreadIdentity): Promise<unknown>;
  persistTokenMiser(identity: CreatedThreadIdentity): Promise<unknown>;
  persistPdfCatalog(identity: CreatedThreadIdentity): Promise<unknown>;
  persistGitBranch(identity: CreatedThreadIdentity): Promise<unknown>;
  persistPrAutoDispatch(identity: CreatedThreadIdentity): Promise<unknown>;
  persistMcpSelection(identity: CreatedThreadIdentity): Promise<unknown>;
  persistAgent(identity: CreatedThreadIdentity): Promise<void>;
  persistEnvironment(identity: CreatedThreadIdentity): Promise<unknown>;
  readModelMigration(): boolean;
  persistModel(identity: CreatedThreadIdentity): Promise<unknown>;
  persistParent(identity: CreatedThreadIdentity): Promise<CreatedThreadParent | undefined>;
  announceParent(identity: CreatedThreadIdentity): Promise<void>;
  finalizeVisibility(identity: CreatedThreadIdentity, parent: CreatedThreadParent | undefined): Promise<Visibility>;
  announceStarted(identity: CreatedThreadIdentity): Promise<void>;
  failed(stage: ThreadCreationStage, error: unknown, identity: CreatedThreadIdentity | undefined): void;
}

export interface ThreadCreationOptions {
  backend: AppServerBackendKind;
  systemPlaceholder: boolean;
  worktree: boolean;
  tokenMiserOverride?: boolean;
  pdfCatalog: boolean;
  mcpSelection: boolean;
  agent: boolean;
  environment: boolean;
  modelSettings: Pick<SetThreadModelSettingsRequest, "model" | "reasoningEffort" | "serviceTier" | "fastMode">;
  parent: boolean;
}

/** Coordinates creation outcomes; providers own identities and hosts own effects. */
export class ThreadCreationLifecycle {
  async start(options: ThreadCreationOptions, host: ThreadCreationHost): Promise<CreatedThreadIdentity & Visibility> {
    const { backend } = options;
    let identity: CreatedThreadIdentity | undefined;
    const report = (stage: ThreadCreationStage, error: unknown): void => {
      try { host.failed(stage, error, identity); } catch { /* Diagnostics cannot replace the provider outcome. */ }
    };
    const attemptSync = (stage: ThreadCreationStage, effect: () => void): void => {
      try { effect(); } catch (error) { report(stage, error); }
    };
    const attempt = async <T>(stage: ThreadCreationStage, effect: () => Promise<T>): Promise<T | undefined> => {
      try { return await effect(); } catch (error) { report(stage, error); return undefined; }
    };
    try {
      await host.withWorkspaceWrite(async () => {
        const result = backend === "claude"
          ? await host.providers.claude()
          : isAcpBackendId(backend)
          ? await host.providers.acp()
          : await host.providers.codex();
        // Capture acceptance inside admission: its release can also fail.
        identity = { backend, threadId: result.threadId };
        return result;
      });
    } catch (error) {
      if (identity) {
        report("workspace", error);
      } else {
        // Rejected creation owns cleanup. Accepted threads retain their workspace
        // and registrations even if a later host finalizer fails.
        for (const connection of host.connections) attemptSync("revoke-connections", () => connection.revoke());
        await attempt("rollback-workspace", () => host.rollbackWorkspace());
        throw host.rejection(error);
      }
    }
    const created = identity!;
    attemptSync("pdf", () => host.bindPdf(created));
    for (const connection of host.connections) attemptSync("connections", () => connection.bindThread(created.threadId));
    await attempt("pending", () => host.rememberPending(created));
    if (options.systemPlaceholder) attemptSync("placeholder", () => host.markPlaceholder(created));
    if (options.worktree) await attempt("worktree", () => host.recordWorktreeOwner(created));
    attemptSync("invalidate", () => host.invalidate(created));
    if (backend === "claude" || backend === "codex") await attempt("execution", () => host.persistExecutionMode(created));
    if (backend === "codex") {
      if (options.tokenMiserOverride !== undefined) await attempt("token-miser", () => host.persistTokenMiser(created));
      if (options.pdfCatalog) await attempt("pdf-catalog", () => host.persistPdfCatalog(created));
      await attempt("git", () => host.persistGitBranch(created));
    }
    await attempt("pr", () => host.persistPrAutoDispatch(created));
    if (options.mcpSelection) await attempt("mcp", () => host.persistMcpSelection(created));
    if (options.agent) await attempt("agent", () => host.persistAgent(created));
    if (options.environment) await attempt("environment", () => host.persistEnvironment(created));
    let modelMigration = false;
    attemptSync("model", () => { modelMigration = host.readModelMigration(); });
    if (modelMigration || Object.values(options.modelSettings).some((value) => value !== undefined)) {
      await attempt("model", () => host.persistModel(created));
    }
    // Storage owns the relationship. Announcement failure cannot undo a saved
    // parent, and a rejected write leaves visibility to handle a root.
    const parent = options.parent ? await attempt("parent", () => host.persistParent(created)) : undefined;
    if (parent) await attempt("parent-event", () => host.announceParent(created));
    const visibility = await attempt("visibility", () => host.finalizeVisibility(created, parent));
    // Codex owns its thread/started notification. Other providers need the host.
    if (backend !== "codex") await attempt("started", () => host.announceStarted(created));
    return { ...created, ...visibility };
  }
}
