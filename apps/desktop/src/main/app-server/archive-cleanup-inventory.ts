import {
  buildThreadIdentityKey,
  isAcpBackendId,
  parseThreadIdentityKey,
  type ThreadOverlayState,
} from "@pwragent/shared/contracts/navigation";
import { mergeThreadLinkedDirectories } from "@pwragent/shared/navigation-state";
import {
  type AppServerBackendKind,
  type AppServerThreadSummary,
  type LinkedDirectorySummary,
} from "@pwragent/shared/contracts/normalized-app-server";
import { getMainLogger } from "../log";
import { ArchiveFleetIndex, type FleetChange, type FleetRow } from "./archive-cleanup-fleet-index";
import { ARCHIVE_CLEANUP_SLICE_SIZE, type ArchiveCleanupContext } from "./archive-cleanup-queue";
import { archiveCleanupWorkspaceFilter, type ArchiveWorkspaceAdmission } from "./archive-cleanup-workspace-scope";
import type { ArchiveCleanupDiscoveryRequest, ArchiveCleanupMetadata } from "./backend-registry-types";
import {
  linkedDirectoryWorktreePath,
  normalizeWorktreePathForComparison,
  resolveThreadWorkspaceCwd,
  withRetainedWorktrees,
} from "./linked-directory-identity";
import type { RegistryContext, RegistryHost } from "./registry-context";
import type { RegistryHostPorts } from "./registry-host-ports";
import { ARCHIVE_FLEET_DELTA_PAGES, ARCHIVE_FLEET_DELTA_PAGE_SIZE, archiveWorkspacePaths } from "./thread-archive-helpers";
import type { ThreadDirectoryEnrichment } from "./thread-directory-enricher";

const backendRegistryLog = getMainLogger("pwragent:backend-registry");

export interface ArchiveCleanupInventoryHost extends Pick<RegistryHostPorts, "listThreads" | "invalidateThreadListCache"> {
  readonly acpWorktreeRepositoryResolver: (
    cwd: string,
    options?: { fresh?: boolean },
  ) => Promise<LinkedDirectorySummary | undefined>;
  readonly isBootstrapModeFn: () => boolean;
  readonly isCodexBootstrapDeferredFn: () => boolean;
  readonly pendingStartedThreads: ReadonlyMap<string, AppServerThreadSummary>;
  readonly runtimeInstanceId: string;
  withPendingStartedThreads(
    backend: AppServerBackendKind,
    threads: AppServerThreadSummary[],
    params?: { archived?: boolean; filter?: string },
  ): AppServerThreadSummary[];
}

/** Reads checkout ownership evidence and maintains the index for one cleanup queue batch. */
export class ArchiveCleanupInventory {
  /** The fleet index of the current cleanup queue batch. Each batch reads the
   * fleet once; writers and notifications keep it current within the batch. */
  private archiveFleet?: { batch: object; index: ArchiveFleetIndex };

  /** The identities each fleet admission found related to its scope. */
  private readonly archiveFleetAdmissionKeys = new WeakMap<ArchiveWorkspaceAdmission, ReadonlySet<string>>();

  /** Each fleet admission's related paths per identity; see `ownershipPaths`. */
  private readonly archiveFleetAdmissionPaths = new WeakMap<ArchiveWorkspaceAdmission, ReadonlyMap<string, readonly string[]>>();

  constructor(
    private readonly context: Pick<RegistryContext, "providers" | "stores">,
    private readonly host: RegistryHost<ArchiveCleanupInventoryHost>,
    private readonly readWorkspaceRevision: () => number,
  ) {}

  clearBatch(): void {
    this.archiveFleet = undefined;
  }

  canReuseTarget(batch: object | undefined): boolean {
    return batch !== undefined && this.archiveFleet?.batch === batch && !this.archiveFleet.index.needsRebuild;
  }

  notePathWrite(paths: readonly string[]): Promise<void> | undefined {
    return this.archiveFleet?.index.notePathWrite(paths);
  }

  async findThreadForArchiveCleanup(params: ArchiveCleanupDiscoveryRequest): Promise<ArchiveCleanupMetadata> {
    const read = async () => await this.readThreadForArchiveCleanup(params);
    return params.context?.withInventory ? await params.context.withInventory(read) : await read();
  }

  async readThreadForArchiveCleanup(params: ArchiveCleanupDiscoveryRequest): Promise<ArchiveCleanupMetadata> {
    if (this.context.providers.codex.listArchiveCleanupThreadsPage) {
      return await this.readPacedArchiveCleanupMetadata(params);
    }
    // Alternate backend adapters retain the aggregate discovery contract.
    // The shipped Codex client uses the bounded read-only path above.
    await params.context?.checkpoint();
    let activeThreads = await this.host().listThreads({
      archived: false,
      callerReason: "archive-cleanup",
    });
    const activeThread = activeThreads.find(
      (thread) =>
        thread.source === params.backend && thread.id === params.threadId,
    );
    // Ownership can belong to an archived thread on any backend. If this
    // lookup fails, the caller must skip cleanup rather than assume ownership.
    await params.context?.checkpoint();
    let archivedThreads = await this.host().listThreads({
      archived: true,
      callerReason: "archive-cleanup",
    });
    // Provider listings do not contain PwrAgent's ownership marker and can
    // still report the old workspace after a move. Use the same overlay
    // precedence as navigation for adopted worktrees. Leave legacy cleanup
    // candidate discovery unchanged for threads without an ownership marker.
    const allThreads = [...activeThreads, ...archivedThreads];
    const overlaysByThreadKey = new Map<string, ThreadOverlayState | undefined>();
    await Promise.all([...new Set(allThreads.map((thread) => thread.source))].map(async (backend) => {
      const overlays = await this.context.stores.threads.getThreadOverlayStates({
        backend,
        threadIds: allThreads.filter((thread) => thread.source === backend).map((thread) => thread.id),
      });
      for (const [threadId, overlay] of Object.entries(overlays)) {
        overlaysByThreadKey.set(buildThreadIdentityKey(backend, threadId), overlay);
      }
    }));
    const withWorkspaceOverlay = (thread: AppServerThreadSummary): AppServerThreadSummary => {
      const overlay = overlaysByThreadKey.get(buildThreadIdentityKey(thread.source, thread.id));
      const directories = overlay?.extraLinkedDirectories ?? [];
      const linkedDirectories = directories.some((directory) => directory.worktreeOwnership === "external")
        ? mergeThreadLinkedDirectories([...thread.linkedDirectories, ...directories])
        : thread.linkedDirectories;
      const withRetained = withRetainedWorktrees(linkedDirectories, overlay);
      return withRetained === thread.linkedDirectories ? thread : { ...thread, linkedDirectories: withRetained };
    };
    activeThreads = activeThreads.map(withWorkspaceOverlay);
    archivedThreads = archivedThreads.map(withWorkspaceOverlay);
    if (activeThread) {
      this.host().invalidateThreadListCache();
      return {
        activeThreads,
        archivedThreads,
        thread: withWorkspaceOverlay(activeThread), overlaysByThreadKey,
      };
    }

    const archivedThread = archivedThreads.find(
      (thread) => thread.source === params.backend && thread.id === params.threadId,
    );
    if (archivedThread) {
      this.host().invalidateThreadListCache();
      return {
        activeThreads,
        archivedThreads,
        thread: archivedThread, overlaysByThreadKey,
      };
    }

    this.host().invalidateThreadListCache();
    throw new Error("Thread metadata was not found.");
  }

  private async readPacedArchiveCleanupMetadata(params: ArchiveCleanupDiscoveryRequest): Promise<ArchiveCleanupMetadata> {
    const { thread, activeTarget, targetIsActive, ...inventory } = await this.readPacedArchiveCleanupInventory(params);
    const missingRollout = params.backend === "codex" && params.codexRolloutMissing === true;
    const archivedTarget = thread ?? (missingRollout ? activeTarget : undefined);
    if (!archivedTarget || (targetIsActive && !missingRollout)) {
      throw new Error("Archived thread metadata was not found or the thread is active again; the worktree was kept.");
    }
    return { ...inventory, thread: archivedTarget };
  }

  /** Queue jobs use the fleet index. Broad repair and the identity-only read
   * that builds the index each perform one complete, uncached read. */
  async readPacedArchiveCleanupInventory(params: ArchiveCleanupDiscoveryRequest): Promise<
    Omit<ArchiveCleanupMetadata, "thread"> & { thread?: AppServerThreadSummary; activeTarget?: AppServerThreadSummary; targetIsActive: boolean; codexWatermark?: number }
  > {
    if (this.host().isBootstrapModeFn()) throw new Error("Archive discovery is unavailable in bootstrap mode.");
    const fleet = this.archiveFleetIndexFor(params);
    if (fleet) return await this.readFleetArchiveCleanupInventory(fleet, params);
    const context = params.context;
    const revision = this.readWorkspaceRevision();
    const activeThreads: AppServerThreadSummary[] = [];
    const archivedThreads: AppServerThreadSummary[] = [];
    const activeChildren: AppServerThreadSummary[] = [];
    const legacyParentBackends = new Set<AppServerBackendKind>([params.backend]);
    const worktreeEvidence = {
      externalPaths: new Set<string>(), activeByPath: new Map<string, AppServerThreadSummary[]>(),
      archivedByPath: new Map<string, AppServerThreadSummary[]>(),
    };
    let archivedTarget = params.targetThread;
    let activeTarget: AppServerThreadSummary | undefined;
    let targetIsActive = false;
    const overlaysByThreadKey = new Map<string, ThreadOverlayState | undefined>();
    const agents = (await this.context.providers.acp.archiveCleanupBackendIds()).map((backendId) => ({ backendId }));
    const directoryObservations = new Map<string, Promise<ThreadDirectoryEnrichment>>();
    const workspaceObservations = new Map<string, Promise<LinkedDirectorySummary | undefined>>();
    // Admission never uses the preliminary inventory. Larger metadata pages
    // amortize RPC cost while overlay/CPU slices remain bounded at 25 rows.
    // thread/list clamps page size at 100; requesting more does not save RPCs.
    // Scope only filesystem/Git enrichment, including aliases and descendants;
    // every provider identity and its current overlay still participates.
    const directoryFilter = params.identityOnly ? async () => false : params.removalAdmission?.directoryFilter
      ?? (params.ownershipScope ? archiveCleanupWorkspaceFilter(params.ownershipScope) : undefined);
    const providerPageSize = directoryFilter ? 100 : ARCHIVE_CLEANUP_SLICE_SIZE;
    const scanStartedAt = Date.now();
    let providerPages = 0;
    // Newest active Codex row this complete read covered. Admission later
    // reads only rows the provider changed at or after it.
    let codexWatermark: number | undefined = 0;
    const appendPage = async (backend: AppServerBackendKind, rows: AppServerThreadSummary[], archived: boolean, resolveCwd = isAcpBackendId(backend), providerRows = backend === "codex") => {
      for (let offset = 0; offset < rows.length; offset += ARCHIVE_CLEANUP_SLICE_SIZE) {
        await context?.checkpoint();
        const slice = rows.slice(offset, offset + ARCHIVE_CLEANUP_SLICE_SIZE);
        params.onDiscoveryProgress?.({ detail: `Reading ${archived ? "archived" : "active"} ${backend} threads`, found: activeThreads.length + archivedThreads.length });
        const readOverlays = this.context.stores.archive.getArchiveCleanupOverlayStates ?? this.context.stores.threads.getThreadOverlayStates;
        const overlays = await readOverlays.call(this.context.stores.archive, { backend, threadIds: slice.map((thread) => thread.id) });
        for (const row of slice) {
          context?.assertCurrent();
          const overlay = overlays[row.id];
          overlaysByThreadKey.set(buildThreadIdentityKey(backend, row.id), overlay);
          if (overlay?.archiveTombstonedAt !== undefined) continue;
          let directories = row.linkedDirectories;
          if (resolveCwd) {
            const cwd = resolveThreadWorkspaceCwd(row, overlay?.extraLinkedDirectories ?? []);
            // Discovery is read-only here. Do not turn a cleanup safety scan
            // into per-thread durable cache writes or trust a stale cache.
            if (cwd && (!directoryFilter || await directoryFilter(cwd))) {
              let observation = workspaceObservations.get(cwd);
              if (!observation) {
                await context?.checkpoint();
                observation = this.host().acpWorktreeRepositoryResolver(cwd);
                workspaceObservations.set(cwd, observation);
              }
              const directory = await observation;
              if (directory) directories = [directory];
            }
          }
          if (providerRows && !archived && codexWatermark !== undefined) {
            codexWatermark = typeof row.updatedAt === "number" ? Math.max(codexWatermark, row.updatedAt) : undefined;
          }
          params.fleetRows?.push({ backend, archived, overlay, base: { ...row, source: backend, linkedDirectories: directories } });
          directories = withRetainedWorktrees(
            mergeThreadLinkedDirectories([...directories, ...(overlay?.extraLinkedDirectories ?? [])]),
            overlay,
          );
          const thread: AppServerThreadSummary = {
            id: row.id, source: backend, title: row.title, titleSource: row.titleSource, updatedAt: row.updatedAt, linkedDirectories: directories,
            projectKey: row.projectKey, gitBranch: row.gitBranch, observedGitBranch: row.observedGitBranch,
          };
          params.removalAdmission?.observeThread(buildThreadIdentityKey(backend, row.id), [
            ...archiveWorkspacePaths(thread),
            ...(!row.projectKey && row.linkedDirectories.length === 0 ? [""] : []),
          ]);
          (archived ? archivedThreads : activeThreads).push(thread);
          if (!archived && overlay?.parentThreadId === params.threadId) activeChildren.push(thread);
          if (row.id === params.threadId) {
            legacyParentBackends.add(backend);
            if (backend === params.backend) {
              if (archived) archivedTarget = thread;
              else {
                targetIsActive = true;
                activeTarget = thread;
              }
            }
          }
          const paths = new Set<string>();
          if (thread.projectKey) paths.add(normalizeWorktreePathForComparison(thread.projectKey));
          for (const directory of directories) {
            const worktreePath = linkedDirectoryWorktreePath(directory);
            if (!worktreePath) continue;
            const key = normalizeWorktreePathForComparison(worktreePath);
            paths.add(key);
            if (directory.worktreeOwnership === "external") worktreeEvidence.externalPaths.add(key);
          }
          for (const key of paths) {
            const index = archived ? worktreeEvidence.archivedByPath : worktreeEvidence.activeByPath;
            const users = index.get(key) ?? [];
            users.push(thread);
            index.set(key, users);
          }
        }
      }
    };
    for (const archived of params.targetThread ? [false] : [false, true]) {
      if (!this.host().isCodexBootstrapDeferredFn()) {
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          await context?.checkpoint();
          params.onDiscoveryProgress?.({ detail: `Reading ${archived ? "archived" : "active"} Codex page ${providerPages + 1}`, found: activeThreads.length + archivedThreads.length });
          const page = await this.context.providers.codex.listArchiveCleanupThreadsPage!({
            archived, cursor, limit: providerPageSize,
            checkpoint: async () => { await context?.checkpoint(); },
            directoryObservations,
            directoryFilter,
          });
          providerPages += 1;
          await appendPage("codex", page.threads, archived);
          cursor = page.nextCursor?.trim();
          if (cursor && cursors.has(cursor)) throw new Error("Archive discovery returned a repeated cursor; worktree safety is incomplete.");
          if (cursor) cursors.add(cursor);
        } while (cursor);
        if (!archived) {
          // A newly started thread may not appear in the provider list yet.
          // It is nevertheless an active checkout user.
          const pending = this.host().withPendingStartedThreads("codex", [], { archived: false });
          await appendPage("codex", pending, false, true, false);
        }
      }
      for (const agent of agents) {
        let after: string | undefined;
        do {
          await context?.checkpoint();
          const page = this.context.providers.acp.listArchiveCleanupSessionsPage(agent.backendId, {
            archived, after, limit: ARCHIVE_CLEANUP_SLICE_SIZE,
          });
          await appendPage(agent.backendId, page.sessions.map((session) => this.context.providers.acp.sessionToThreadSummary(session)), archived);
          if (page.nextCursor && after && page.nextCursor <= after) throw new Error("ACP archive discovery did not advance.");
          after = page.nextCursor;
        } while (after);
      }
      // Claude threads hold checkouts too. Without them, archiving another
      // thread could remove a worktree a Claude thread still runs in. Their
      // directory comes from the cwd, the same way ACP sessions resolve it.
      await context?.checkpoint();
      await appendPage("claude", await this.context.providers.claude.listThreads({ archived }), archived, true);
    }
    context?.assertCurrent();
    backendRegistryLog.info("archive cleanup inventory read", {
      backend: params.backend, threadId: params.threadId, runtimeInstanceId: this.host().runtimeInstanceId,
      durationMs: Date.now() - scanStartedAt, providerPages, activeThreads: activeThreads.length, archivedThreads: archivedThreads.length,
      directoryObservations: directoryObservations.size, workspaceObservations: workspaceObservations.size,
      ownershipScope: params.ownershipScope, providerPageSize,
    });
    // A confirmed missing rollout can leave retained metadata in the active
    // provider listing. Use that exact identity for recovery while still
    // scanning every checkout user. Actual restore intent cancels this job.
    return { workspaceRevision: revision, activeThreads, archivedThreads: params.targetThread ? [...archivedThreads, params.targetThread] : archivedThreads,
      thread: archivedTarget, activeTarget, targetIsActive, overlaysByThreadKey, activeChildren, legacyParentBackends, worktreeEvidence,
      codexWatermark: this.host().isCodexBootstrapDeferredFn() ? undefined : codexWatermark };
  }

  /** The current queue batch's fleet index, when this read can use one.
   * Repair keeps its complete audit; alternate adapters use aggregate discovery. */
  private archiveFleetIndexFor(params: ArchiveCleanupDiscoveryRequest): ArchiveFleetIndex | undefined {
    const batch = params.context?.batch;
    if (!batch || params.identityOnly || params.fleetRows || !params.threadId || !this.context.providers.codex.listArchiveCleanupThreadsPage) return undefined;
    if (this.archiveFleet?.batch !== batch) this.archiveFleet = { batch, index: new ArchiveFleetIndex() };
    return this.archiveFleet.index;
  }

  /** Record a change the current batch's index has not read yet. A change
   * with no identity can affect any checkout, so it requests a complete read. */
  noteArchiveFleetChange(identity: { backend: AppServerBackendKind; threadId: string } | undefined, change: FleetChange, reason: string): void {
    const index = this.archiveFleet?.index;
    if (!index) return;
    if (identity) index.markDirty(buildThreadIdentityKey(identity.backend, identity.threadId), change);
    else index.requestRebuild(reason);
  }

  private archiveFleetRow(backend: AppServerBackendKind, base: AppServerThreadSummary, overlay: ThreadOverlayState | undefined, archived: boolean): FleetRow {
    const linkedDirectories = withRetainedWorktrees(
      mergeThreadLinkedDirectories([...base.linkedDirectories, ...(overlay?.extraLinkedDirectories ?? [])]),
      overlay,
    );
    const thread: AppServerThreadSummary = {
      id: base.id, source: backend, title: base.title, titleSource: base.titleSource, linkedDirectories,
      projectKey: base.projectKey, gitBranch: base.gitBranch, observedGitBranch: base.observedGitBranch,
    };
    return {
      key: buildThreadIdentityKey(backend, base.id), backend, threadId: base.id, archived, base, thread, overlay,
      paths: archiveWorkspacePaths(thread),
      // A provider row with no workspace of its own cannot prove where it runs.
      unknownWorkspace: !base.projectKey && base.linkedDirectories.length === 0,
      externalPaths: linkedDirectories.filter((directory) => directory.worktreeOwnership === "external")
        .map((directory) => linkedDirectoryWorktreePath(directory) ?? directory.path),
    };
  }

  private async readClaudeArchiveCleanupChangeToken(): Promise<string | undefined> {
    try { return await this.context.providers.claude.archiveCleanupChangeToken?.(); } catch { return undefined; }
  }

  /** A foreign Claude write changes only Claude's ownership evidence. Read
   * its complete membership and overlays without walking the Codex fleet. */
  private async refreshArchiveFleetClaudeRows(index: ArchiveFleetIndex, token: string, context?: ArchiveCleanupContext): Promise<void> {
    const epoch = index.beginRead();
    const observed = new Map<string, { key: string; backend: "claude"; threadId: string; archived: boolean; base: AppServerThreadSummary }>();
    for (const archived of [false, true]) {
      await context?.checkpoint();
      for (const base of await this.context.providers.claude.listThreads({ archived })) {
        const key = buildThreadIdentityKey("claude", base.id);
        // An active listing wins if a concurrent restore puts the identity
        // in both pages, just as it does in a complete fleet read.
        if (!observed.has(key)) observed.set(key, { key, backend: "claude", threadId: base.id, archived, base });
      }
    }
    const rows = [...observed.values()];
    const overlays = await this.readArchiveFleetOverlays(rows, context);
    context?.assertCurrent();
    for (const row of index.rowsForBackend("claude")) {
      if (!observed.has(row.key)) {
        index.delete(row.key);
        index.settle(row.key, epoch);
      }
    }
    for (const row of rows) {
      const overlay = overlays.get(row.key);
      if (overlay?.archiveTombstonedAt !== undefined) index.delete(row.key);
      else {
        const next = this.archiveFleetRow("claude", row.base, overlay, row.archived);
        const prior = index.get(row.key);
        // Transcript, title and usage writes move the token too. Preserve
        // preliminary checkout observations when ownership did not change.
        if (!prior || prior.archived !== next.archived
          || JSON.stringify(prior.thread) !== JSON.stringify(next.thread)
          || JSON.stringify(prior.overlay) !== JSON.stringify(next.overlay)) await index.upsert(next);
      }
      index.settle(row.key, epoch);
    }
    // Capture the token from before the read. A write during it remains
    // visible to the next admission, and newer dirty marks remain unsettled.
    index.claudeToken = token;
  }

  /** One complete identity and overlay read: every provider, every page. */
  private async rebuildArchiveFleet(index: ArchiveFleetIndex, context?: ArchiveCleanupContext): Promise<void> {
    const reason = index.rebuildReason ?? "new batch";
    const epoch = index.beginRead();
    const startedAt = Date.now();
    // Observe change tokens before the read, so a write during it forces the
    // next admission to read again rather than trust this result.
    const overlayToken = this.context.stores.archive.readArchiveCleanupChangeToken?.();
    const claudeToken = await this.readClaudeArchiveCleanupChangeToken();
    const fleetRows: NonNullable<ArchiveCleanupDiscoveryRequest["fleetRows"]> = [];
    const inventory = await this.readPacedArchiveCleanupInventory({ backend: "codex", threadId: "", context, identityOnly: true, fleetRows });
    // A provider can list one identity as both active and archived. Archived
    // membership must be unambiguous: an active listing anywhere wins.
    const rows = new Map<string, FleetRow>();
    for (const row of fleetRows) {
      const next = this.archiveFleetRow(row.backend, row.base, row.overlay, row.archived);
      const previous = rows.get(next.key);
      if (!previous || (previous.archived && !next.archived)) rows.set(next.key, next);
    }
    await index.replaceAll([...rows.values()], epoch, {
      codexWatermark: inventory.codexWatermark, overlayToken, claudeToken,
    });
    backendRegistryLog.info("archive cleanup fleet index built", {
      runtimeInstanceId: this.host().runtimeInstanceId, reason, rows: index.size, durationMs: Date.now() - startedAt,
    });
  }

  private async refreshArchiveFleet(index: ArchiveFleetIndex, context?: ArchiveCleanupContext): Promise<"rebuilt" | "current"> {
    // Past a quarter of the fleet, one complete read costs less than reading
    // each changed identity on its own.
    if (index.dirtyCount > Math.max(ARCHIVE_CLEANUP_SLICE_SIZE, index.size / 4)) index.requestRebuild("many identities changed");
    if (!index.needsRebuild) await this.refreshDirtyArchiveFleetRows(index, context);
    if (!index.needsRebuild) return "current";
    await this.rebuildArchiveFleet(index, context);
    return "rebuilt";
  }

  /** Read again only the identities a writer or notification changed. */
  private async refreshDirtyArchiveFleetRows(index: ArchiveFleetIndex, context?: ArchiveCleanupContext): Promise<void> {
    const dirty = index.dirtyEntries();
    if (!dirty.length) return;
    const epoch = index.beginRead();
    const checkpoint = async () => { await context?.checkpoint(); };
    const reads: Array<{ key: string; backend: AppServerBackendKind; threadId: string; archived: boolean; base: AppServerThreadSummary }> = [];
    let claude: Map<string, { thread: AppServerThreadSummary; archived: boolean }> | undefined;
    for (const { key, changes, membership } of dirty) {
      const identity = parseThreadIdentityKey(key);
      if (!identity) {
        index.requestRebuild("unrecognized identity");
        return;
      }
      const backend = identity.backend;
      const threadId = identity.threadId;
      const prior = index.get(key);
      if (membership === "deleted") {
        index.delete(key);
        index.settle(key, epoch);
        continue;
      }
      let archived = membership ? membership === "archived" : prior?.archived ?? false;
      // Archive membership and overlay links do not move the provider's cwd.
      let base = changes.has("provider") || !prior ? undefined : prior.base;
      if (!base) {
        if (isAcpBackendId(backend)) {
          const session = this.context.providers.acp.getSession(backend, threadId);
          // Deletion is announced; an unreadable session is not proof that it
          // is gone, so it protects every checkout until it can be read.
          base = session ? this.context.providers.acp.sessionToThreadSummary(session)
            : { id: threadId, source: backend, title: "", titleSource: "explicit", linkedDirectories: [] };
          if (session) archived = Boolean(session.archivedAt);
        } else if (backend === "claude") {
          if (!claude) {
            claude = new Map();
            for (const isArchived of [false, true]) {
              await checkpoint();
              for (const thread of await this.context.providers.claude.listThreads({ archived: isArchived })) claude.set(thread.id, { thread, archived: isArchived });
            }
          }
          const found = claude.get(threadId);
          if (!found) {
            index.delete(key);
            index.settle(key, epoch);
            continue;
          }
          base = found.thread;
          archived = found.archived;
        } else if (backend === "codex") {
          const pending = this.host().pendingStartedThreads.get(key);
          if (pending && !archived) base = pending;
          else if (this.context.providers.codex.readArchiveCleanupThreadSummary) {
            // An unreadable owner protects every checkout until it is read.
            base = await this.context.providers.codex.readArchiveCleanupThreadSummary(threadId, checkpoint).catch(() => undefined)
              ?? { id: threadId, source: "codex", title: "", titleSource: "explicit", linkedDirectories: [] };
          } else {
            index.requestRebuild("provider row reads unavailable");
            return;
          }
        } else {
          index.requestRebuild("unsupported backend");
          return;
        }
      }
      reads.push({ key, backend, threadId, archived, base });
    }
    const overlays = await this.readArchiveFleetOverlays(reads, context);
    for (const read of reads) {
      const overlay = overlays.get(read.key);
      if (overlay?.archiveTombstonedAt !== undefined) index.delete(read.key);
      else await index.upsert(this.archiveFleetRow(read.backend, read.base, overlay, read.archived));
      index.settle(read.key, epoch);
    }
  }

  private async readArchiveFleetOverlays(
    identities: ReadonlyArray<{ key: string; backend: AppServerBackendKind; threadId: string }>,
    context?: ArchiveCleanupContext,
  ): Promise<Map<string, ThreadOverlayState | undefined>> {
    const result = new Map<string, ThreadOverlayState | undefined>();
    const byBackend = new Map<AppServerBackendKind, string[]>();
    for (const { backend, threadId } of identities) byBackend.set(backend, [...byBackend.get(backend) ?? [], threadId]);
    const read = this.context.stores.archive.getArchiveCleanupOverlayStates ?? this.context.stores.threads.getThreadOverlayStates;
    for (const [backend, threadIds] of byBackend) {
      for (let offset = 0; offset < threadIds.length; offset += ARCHIVE_CLEANUP_SLICE_SIZE) {
        await context?.checkpoint();
        const slice = threadIds.slice(offset, offset + ARCHIVE_CLEANUP_SLICE_SIZE);
        const overlays = await read.call(this.context.stores.archive, { backend, threadIds: slice });
        for (const threadId of slice) result.set(buildThreadIdentityKey(backend, threadId), overlays[threadId]);
      }
    }
    return result;
  }

  /** Reread the overlays of related identities and apply any that changed. */
  private async refreshArchiveFleetOverlays(index: ArchiveFleetIndex, keys: ReadonlySet<string>, context?: ArchiveCleanupContext): Promise<void> {
    const rows = index.rows(keys);
    const overlays = await this.readArchiveFleetOverlays(rows, context);
    for (const row of rows) {
      const overlay = overlays.get(row.key);
      if (overlay?.archiveTombstonedAt !== undefined) index.delete(row.key);
      else if (JSON.stringify(overlay) !== JSON.stringify(row.overlay)) {
        await index.upsert(this.archiveFleetRow(row.backend, row.base, overlay, row.archived));
      }
    }
  }

  /**
   * The provider's rows changed since the index's watermark, newest first.
   * A new thread, a cwd change and an unarchived thread advance `updated_at`.
   * Protocol-only captures (2026-11-05, Codex 0.160.0 and 0.163.0) confirmed
   * `thread/unarchive` advances it in another app-server's `thread/list`
   * with `sortKey: "updated_at"` and `useStateDbOnly: true`, including after
   * restarting the restoring client. Archived `thread/resume` (ID or path)
   * and `thread/fork` reject rather than reactivate the thread. Thus a short
   * read sees an external restore without rereading the fleet.
   */
  private async readArchiveFleetCodexDelta(
    index: ArchiveFleetIndex,
    context: ArchiveCleanupContext | undefined,
    directoryFilter?: (cwd: string | undefined) => Promise<boolean>,
  ): Promise<void> {
    const watermark = index.codexWatermark!;
    let newest = watermark;
    const changed: AppServerThreadSummary[] = [];
    const cursors = new Set<string>();
    const directoryObservations = new Map<string, Promise<ThreadDirectoryEnrichment>>();
    let cursor: string | undefined;
    for (let pages = 0; ; pages += 1) {
      if (pages >= ARCHIVE_FLEET_DELTA_PAGES) {
        index.requestRebuild("provider changes exceeded the incremental read");
        return;
      }
      await context?.checkpoint();
      const page = await this.context.providers.codex.listArchiveCleanupThreadsPage!({
        archived: false, cursor, limit: ARCHIVE_FLEET_DELTA_PAGE_SIZE, sortKey: "updated_at",
        checkpoint: async () => { await context?.checkpoint(); }, directoryObservations, directoryFilter,
      });
      let reachedOlder = false;
      for (const row of page.threads) {
        if (typeof row.updatedAt !== "number") {
          index.requestRebuild("provider row without updatedAt");
          return;
        }
        // Rows at the watermark itself are read again: a timestamp tie cannot
        // prove the row predates the complete read.
        if (row.updatedAt < watermark) {
          reachedOlder = true;
          continue;
        }
        newest = Math.max(newest, row.updatedAt);
        changed.push(row);
      }
      cursor = page.nextCursor?.trim();
      if (reachedOlder || !cursor) break;
      if (cursors.has(cursor)) {
        index.requestRebuild("provider recency cursor repeated");
        return;
      }
      cursors.add(cursor);
    }
    const unseen = changed.filter((row) => !index.get(buildThreadIdentityKey("codex", row.id)))
      .map((row) => ({ key: buildThreadIdentityKey("codex", row.id), backend: "codex" as const, threadId: row.id }));
    const overlays = await this.readArchiveFleetOverlays(unseen, context);
    for (const row of changed) {
      const key = buildThreadIdentityKey("codex", row.id);
      const overlay = overlays.has(key) ? overlays.get(key) : index.get(key)?.overlay;
      if (overlay?.archiveTombstonedAt !== undefined) continue;
      await index.upsert(this.archiveFleetRow("codex", row, overlay, false));
    }
    index.codexWatermark = newest;
  }

  /**
   * Fresh evidence for one removal, bounded by what changed: identities that
   * PwrAgent's writers and notifications marked, provider rows changed since
   * the watermark, and the overlays of every related identity. Without a
   * provider recency read or after another process wrote the overlay store,
   * admission reads the complete fleet again. Foreign Claude writes refresh
   * that provider's membership without discarding the other providers.
   */
  private async verifyArchiveFleetForAdmission(index: ArchiveFleetIndex, scopePath: string, params: ArchiveCleanupDiscoveryRequest): Promise<void> {
    const overlayToken = this.context.stores.archive.readArchiveCleanupChangeToken?.();
    if (overlayToken === undefined || overlayToken !== index.overlayToken) index.requestRebuild("overlay store changed or has no change token");
    const claudeToken = await this.readClaudeArchiveCleanupChangeToken();
    if (claudeToken === undefined) index.requestRebuild("Claude sessions have no change token");
    if (await index.pathWriteRelates(scopePath)) index.requestRebuild("workspace write near this checkout");
    if (this.context.providers.codex.archiveCleanupRecencyReads !== true || index.codexWatermark === undefined || this.host().isCodexBootstrapDeferredFn()) {
      index.requestRebuild("provider recency reads unavailable");
    }
    if (!index.needsRebuild && claudeToken !== undefined && claudeToken !== index.claudeToken) {
      await this.refreshArchiveFleetClaudeRows(index, claudeToken, params.context);
    }
    if (await this.refreshArchiveFleet(index, params.context) === "rebuilt") return;
    await this.readArchiveFleetCodexDelta(index, params.context, params.removalAdmission?.directoryFilter);
    await this.refreshArchiveFleet(index, params.context);
  }

  /** Git and cwd enrichment for related rows only, as the complete read did. */
  private async enrichArchiveFleetRows(
    rows: readonly FleetRow[],
    directoryFilter: ((cwd: string | undefined) => Promise<boolean>) | undefined,
    context: ArchiveCleanupContext | undefined,
    directoryObservations: Map<string, Promise<ThreadDirectoryEnrichment>>,
    workspaceObservations: Map<string, Promise<LinkedDirectorySummary | undefined>>,
  ): Promise<AppServerThreadSummary[]> {
    const checkpoint = async () => { await context?.checkpoint(); };
    const result: AppServerThreadSummary[] = [];
    for (let offset = 0; offset < rows.length; offset += ARCHIVE_CLEANUP_SLICE_SIZE) {
      await checkpoint();
      const slice = rows.slice(offset, offset + ARCHIVE_CLEANUP_SLICE_SIZE);
      const codex = slice.filter((row) => row.backend === "codex").map((row) => row.base);
      const enrichedCodex = codex.length && this.context.providers.codex.enrichArchiveCleanupThreads
        ? await this.context.providers.codex.enrichArchiveCleanupThreads(codex, { checkpoint, directoryObservations, directoryFilter })
        : codex;
      let codexIndex = 0;
      for (const row of slice) {
        context?.assertCurrent();
        let directories = row.backend === "codex" ? enrichedCodex[codexIndex++]!.linkedDirectories : row.base.linkedDirectories;
        if (row.backend !== "codex") {
          const cwd = resolveThreadWorkspaceCwd(row.base, row.overlay?.extraLinkedDirectories ?? []);
          if (cwd && (!directoryFilter || await directoryFilter(cwd))) {
            let observation = workspaceObservations.get(cwd);
            if (!observation) {
              await checkpoint();
              observation = this.host().acpWorktreeRepositoryResolver(cwd);
              workspaceObservations.set(cwd, observation);
            }
            const directory = await observation;
            if (directory) directories = [directory];
          }
        }
        result.push({ ...row.thread, linkedDirectories: withRetainedWorktrees(
          mergeThreadLinkedDirectories([...directories, ...(row.overlay?.extraLinkedDirectories ?? [])]), row.overlay,
        ) });
      }
    }
    return result;
  }

  /** Ownership lists for related identities, as consumers expect them. */
  private async buildArchiveFleetLists(
    index: ArchiveFleetIndex,
    keys: ReadonlySet<string>,
    scopes: readonly string[],
    directoryFilter: ((cwd: string | undefined) => Promise<boolean>) | undefined,
    context: ArchiveCleanupContext | undefined,
    removalAdmission?: ArchiveWorkspaceAdmission,
    directoryObservations = new Map<string, Promise<ThreadDirectoryEnrichment>>(),
    workspaceObservations = new Map<string, Promise<LinkedDirectorySummary | undefined>>(),
  ) {
    const rows = index.rows(keys);
    const ownershipPaths = new WeakMap<AppServerThreadSummary, readonly string[]>();
    const pathsByKey = new Map<string, readonly string[]>();
    if (removalAdmission) this.archiveFleetAdmissionPaths.set(removalAdmission, pathsByKey);
    const enriched = await this.enrichArchiveFleetRows(rows, directoryFilter, context, directoryObservations, workspaceObservations);
    context?.assertCurrent();
    const activeThreads: AppServerThreadSummary[] = [];
    const archivedThreads: AppServerThreadSummary[] = [];
    const byKey = new Map<string, { row: FleetRow; summary: AppServerThreadSummary }>();
    const worktreeEvidence: NonNullable<ArchiveCleanupMetadata["worktreeEvidence"]> = {
      externalPaths: new Set(), activeByPath: new Map(), archivedByPath: new Map(),
    };
    for (const [offset, row] of rows.entries()) {
      const summary = enriched[offset]!;
      // Enrichment can only add a checkout above a related cwd; keep any path
      // the index has not seen, and every path of an unknown owner.
      const related = await index.relatedPaths(row.key, scopes);
      const known = new Set(row.paths);
      const paths = related ? [...new Set([...related, ...archiveWorkspacePaths(summary).filter((value) => !known.has(value))])] : undefined;
      if (paths) {
        ownershipPaths.set(summary, paths);
        pathsByKey.set(row.key, paths);
      }
      byKey.set(row.key, { row, summary });
      (row.archived ? archivedThreads : activeThreads).push(summary);
      removalAdmission?.observeThread(row.key, [...paths ?? archiveWorkspacePaths(summary), ...(row.unknownWorkspace ? [""] : [])]);
      const evidencePaths = new Set(summary.projectKey ? [normalizeWorktreePathForComparison(summary.projectKey)] : []);
      for (const directory of summary.linkedDirectories) {
        const worktreePath = linkedDirectoryWorktreePath(directory);
        if (!worktreePath) continue;
        const normalized = normalizeWorktreePathForComparison(worktreePath);
        evidencePaths.add(normalized);
        if (directory.worktreeOwnership === "external") worktreeEvidence.externalPaths.add(normalized);
      }
      const byPath = row.archived ? worktreeEvidence.archivedByPath : worktreeEvidence.activeByPath;
      for (const value of evidencePaths) byPath.set(value, [...byPath.get(value) ?? [], summary]);
    }
    return { activeThreads, archivedThreads, byKey, worktreeEvidence, ownershipPaths };
  }

  /**
   * Discovery and admission from the batch's fleet index. The returned lists
   * hold only identities related to the candidate scopes, plus every identity
   * whose workspace is unknown; every consumer of these lists asks only about
   * those scopes, so unrelated threads cost nothing per removal.
   */
  private async readFleetArchiveCleanupInventory(index: ArchiveFleetIndex, params: ArchiveCleanupDiscoveryRequest): Promise<
    Omit<ArchiveCleanupMetadata, "thread"> & { thread?: AppServerThreadSummary; activeTarget?: AppServerThreadSummary; targetIsActive: boolean }
  > {
    const revision = this.readWorkspaceRevision();
    const key = buildThreadIdentityKey(params.backend, params.threadId);
    const scope = params.ownershipScope ?? params.removalAdmission?.scopePath;
    if (scope) await this.verifyArchiveFleetForAdmission(index, scope, params);
    else await this.refreshArchiveFleet(index, params.context);
    params.context?.assertCurrent();
    let lists: Awaited<ReturnType<ArchiveCleanupInventory["buildArchiveFleetLists"]>>;
    if (scope) {
      // Admission: fresh overlays for every related identity, then fresh lists.
      await this.refreshArchiveFleetOverlays(index, await index.related(scope), params.context);
      const keys = await index.related(scope);
      if (index.get(key)) keys.add(key);
      if (params.removalAdmission) this.archiveFleetAdmissionKeys.set(params.removalAdmission, keys);
      lists = await this.buildArchiveFleetLists(index, keys, [scope], params.removalAdmission?.directoryFilter ?? archiveCleanupWorkspaceFilter(scope),
        params.context, params.removalAdmission);
    } else {
      // Only the target's own checkouts can become candidates.
      const targetRow = index.get(key);
      // One job's observations: the target's checkout is enriched once.
      const directoryObservations = new Map<string, Promise<ThreadDirectoryEnrichment>>();
      const workspaceObservations = new Map<string, Promise<LinkedDirectorySummary | undefined>>();
      const [target] = targetRow ? await this.enrichArchiveFleetRows([targetRow], undefined, params.context, directoryObservations, workspaceObservations) : [];
      const roots = [...new Set((target?.linkedDirectories ?? []).map(linkedDirectoryWorktreePath)
        .filter((value): value is string => Boolean(value)))];
      const memoized = roots.length === 1
        ? await index.memo(roots[0]!, async (keys) => await this.buildArchiveFleetLists(index, keys, roots, archiveCleanupWorkspaceFilter(roots[0]!), params.context,
          undefined, directoryObservations, workspaceObservations))
        : undefined;
      if (memoized && (!targetRow || memoized.byKey.has(key))) lists = memoized;
      else {
        const keys = new Set(targetRow ? [key] : []);
        for (const root of roots) for (const related of await index.related(root)) keys.add(related);
        const filters = roots.map(archiveCleanupWorkspaceFilter);
        lists = await this.buildArchiveFleetLists(index, keys, roots, async (cwd) => {
          for (const filter of filters) if (await filter(cwd)) return true;
          return false;
        }, params.context, undefined, directoryObservations, workspaceObservations);
      }
    }
    const target = lists.byKey.get(key);
    const thread = params.targetThread ?? (target?.row.archived ? target.summary : undefined);
    const activeTarget = target && !target.row.archived ? target.summary : undefined;
    const overlaysByThreadKey = new Map<string, ThreadOverlayState | undefined>();
    const activeChildren = index.childrenOf(params.threadId).map((row) => {
      overlaysByThreadKey.set(row.key, row.overlay);
      return row.thread;
    });
    // Shared lists may be memoized; copy before adding a supplied target.
    const archivedThreads = params.targetThread && !lists.archivedThreads.includes(params.targetThread)
      ? [...lists.archivedThreads.filter((row) => row.id !== params.targetThread!.id || row.source !== params.targetThread!.source), params.targetThread]
      : lists.archivedThreads;
    return {
      workspaceRevision: revision, activeThreads: lists.activeThreads, archivedThreads, thread, activeTarget, targetIsActive: Boolean(activeTarget),
      overlaysByThreadKey, activeChildren, worktreeEvidence: lists.worktreeEvidence, ownershipPaths: lists.ownershipPaths,
      legacyParentBackends: new Set([params.backend, ...index.withThreadId(params.threadId).map((row) => row.backend)]),
    };
  }

  /**
   * Fleet admission observes only related identities. Before an unobserved
   * identity's change or in-flight mutation reaches the scope, give it the
   * batch evidence admission used: proven disjoint when the index related it
   * to nothing here, its indexed paths otherwise. New paths it reports later
   * still have to be proven by `prepare`, as before.
   */
  observeArchiveFleetIdentity(scope: ArchiveWorkspaceAdmission, key: string): void {
    if (scope.hasObserved(key)) return;
    const related = this.archiveFleetAdmissionKeys.get(scope);
    const row = this.archiveFleet?.index.get(key);
    if (!row) return;
    // While admission is still reading, `prepare` proves the indexed paths.
    if (related && !related.has(key) && !row.unknownWorkspace && row.paths.length) scope.observeDisjoint(key, row.paths);
    else {
      const paths = this.archiveFleetAdmissionPaths.get(scope)?.get(key) ?? row.paths;
      scope.observeThread(key, [...paths, ...(row.unknownWorkspace || !paths.length ? [""] : [])]);
    }
  }
}
