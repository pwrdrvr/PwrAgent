import { isAcpBackendId, type AppServerBackendKind, type SetThreadModelSettingsRequest, type StartThreadResponse } from "@pwragent/shared";

export type CreatedThreadIdentity = { backend: AppServerBackendKind; threadId: string };
export type CreatedThreadParent = { parentThreadId: string; parentThreadBackend?: AppServerBackendKind };
export type ThreadCreationStage = "workspace" | "revoke-connections" | "rollback-workspace" | "pdf" | "connections" | "pending"
  | "placeholder" | "worktree" | "invalidate" | "execution" | "token-miser" | "pdf-catalog" | "git"
  | "pr" | "mcp" | "agent" | "environment" | "model" | "parent" | "parent-event" | "visibility" | "started";

type Visibility = Pick<StartThreadResponse, "pinnedRank" | "autoPinFailure">;
type Connection = ThreadCreationHost["connections"][number];
type PreparationFailure = (stage: "revoke-connections" | "rollback-workspace", error: unknown) => void;

/** Invocation-local resources remain owned until preparation hands them to creation. */
export class ThreadCreationPreparation {
  readonly connections: Connection[] = [];
  private readonly pending: Promise<PromiseSettledResult<unknown>>[] = [];
  private workspaceRollback: (() => Promise<void>) | undefined;

  setWorkspaceRollback(rollback: (() => Promise<void>) | undefined): void {
    this.workspaceRollback = rollback;
  }

  track<T>(work: Promise<T>): Promise<T> {
    // Observe immediately, including branches admitted before a synchronous
    // preparation failure prevents the host from reaching its normal join.
    this.pending.push(work.then(
      (value) => ({ status: "fulfilled", value }),
      (reason: unknown) => ({ status: "rejected", reason }),
    ));
    return work;
  }

  registerConnections<T extends Connection>(work: Promise<T[]>): Promise<T[]> {
    return this.track(work.then((connections) => {
      this.connections.push(...connections);
      return connections;
    }));
  }

  async drain(): Promise<PromiseSettledResult<unknown>[]> {
    return await Promise.all(this.pending);
  }

  async rollbackWorkspace(): Promise<void> {
    const rollback = this.workspaceRollback;
    this.workspaceRollback = undefined;
    await rollback?.();
  }

  async reject(failed: PreparationFailure): Promise<void> {
    await this.drain();
    const report: PreparationFailure = (stage, error) => {
      try { failed(stage, error); } catch { /* Cleanup must survive diagnostics failure. */ }
    };
    for (const connection of this.connections) {
      try { connection.revoke(); } catch (error) { report("revoke-connections", error); }
    }
    try { await this.rollbackWorkspace(); } catch (error) { report("rollback-workspace", error); }
  }
}

export interface PreparedThreadCreation<Metadata> {
  options: ThreadCreationOptions;
  host: Omit<ThreadCreationHost, "connections" | "rollbackWorkspace">;
  metadata: Metadata;
}

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

/** A host supplies only its supported effects; desktop retains the full contract above. */
export type ThreadCreationPorts = Partial<Omit<ThreadCreationHost, "providers">> & {
  providers: Partial<ThreadCreationHost["providers"]>;
};

/** Coordinates creation outcomes; providers own identities and hosts own effects. */
export class ThreadCreationLifecycle {
  async prepare<Metadata>(
    prepare: (resources: ThreadCreationPreparation) => Promise<PreparedThreadCreation<Metadata>>,
    failed: PreparationFailure,
  ): Promise<CreatedThreadIdentity & Visibility & Metadata> {
    const resources = new ThreadCreationPreparation();
    let prepared: PreparedThreadCreation<Metadata>;
    try {
      prepared = await prepare(resources);
      const results = await resources.drain();
      for (const result of results) if (result.status === "rejected") throw result.reason;
    } catch (error) {
      await resources.reject(failed);
      throw error;
    }
    // From here start owns rejection cleanup; acceptance retains these resources.
    const result = await this.start(prepared.options, {
      ...prepared.host,
      connections: resources.connections,
      rollbackWorkspace: async () => await resources.rollbackWorkspace(),
    });
    return { ...prepared.metadata, ...result };
  }

  async start(options: Pick<ThreadCreationOptions, "backend"> & Partial<ThreadCreationOptions>, host: ThreadCreationPorts): Promise<CreatedThreadIdentity & Visibility> {
    const { backend } = options;
    let identity: CreatedThreadIdentity | undefined;
    const report = (stage: ThreadCreationStage, error: unknown): void => {
      try { host.failed?.(stage, error, identity); } catch { /* Diagnostics cannot replace the provider outcome. */ }
    };
    const attemptSync = (stage: ThreadCreationStage, effect: () => void): void => {
      try { effect(); } catch (error) { report(stage, error); }
    };
    const attempt = async <T>(stage: ThreadCreationStage, effect: () => T | Promise<T>): Promise<T | undefined> => {
      try { return await effect(); } catch (error) { report(stage, error); return undefined; }
    };
    try {
      const create = async () => {
        const provider = host.providers[backend === "claude" ? "claude" : isAcpBackendId(backend) ? "acp" : "codex"];
        if (!provider) throw new Error(`Thread creation is unavailable for ${backend}`);
        const result = await provider.call(host.providers);
        // Capture acceptance inside admission: its release can also fail.
        identity = { backend, threadId: result.threadId };
        return result;
      };
      if (host.withWorkspaceWrite) await host.withWorkspaceWrite(create);
      else await create();
    } catch (error) {
      if (identity) {
        report("workspace", error);
      } else {
        // Rejected creation owns cleanup. Accepted threads retain their workspace
        // and registrations even if a later host finalizer fails.
        for (const connection of host.connections ?? []) attemptSync("revoke-connections", () => connection.revoke());
        await attempt("rollback-workspace", () => host.rollbackWorkspace?.());
        throw host.rejection ? host.rejection(error) : error;
      }
    }
    const created = identity!;
    attemptSync("pdf", () => host.bindPdf?.(created));
    for (const connection of host.connections ?? []) attemptSync("connections", () => connection.bindThread(created.threadId));
    await attempt("pending", () => host.rememberPending?.(created));
    if (options.systemPlaceholder) attemptSync("placeholder", () => host.markPlaceholder?.(created));
    if (options.worktree) await attempt("worktree", () => host.recordWorktreeOwner?.(created));
    attemptSync("invalidate", () => host.invalidate?.(created));
    if (backend === "claude" || backend === "codex") await attempt("execution", () => host.persistExecutionMode?.(created));
    if (backend === "codex") {
      if (options.tokenMiserOverride !== undefined) await attempt("token-miser", () => host.persistTokenMiser?.(created));
      if (options.pdfCatalog) await attempt("pdf-catalog", () => host.persistPdfCatalog?.(created));
      await attempt("git", () => host.persistGitBranch?.(created));
    }
    await attempt("pr", () => host.persistPrAutoDispatch?.(created));
    if (options.mcpSelection) await attempt("mcp", () => host.persistMcpSelection?.(created));
    if (options.agent) await attempt("agent", () => host.persistAgent?.(created));
    if (options.environment) await attempt("environment", () => host.persistEnvironment?.(created));
    let modelMigration = false;
    attemptSync("model", () => { modelMigration = host.readModelMigration?.() ?? false; });
    if (modelMigration || Object.values(options.modelSettings ?? {}).some((value) => value !== undefined)) {
      await attempt("model", () => host.persistModel?.(created));
    }
    // Storage owns the relationship. Announcement failure cannot undo a saved
    // parent, and a rejected write leaves visibility to handle a root.
    const parent = options.parent ? await attempt("parent", () => host.persistParent?.(created)) : undefined;
    if (parent) await attempt("parent-event", () => host.announceParent?.(created));
    const visibility = await attempt("visibility", () => host.finalizeVisibility?.(created, parent));
    // Codex owns its thread/started notification. Other providers need the host.
    if (backend !== "codex") await attempt("started", () => host.announceStarted?.(created));
    return { ...created, ...visibility };
  }
}
