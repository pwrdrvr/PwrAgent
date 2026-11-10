import { projectNavigationSelectedDetail, readNavigationQueueProjection, readNavigationSelectedCollection } from "@pwragent/owner-core/navigation-detail-projection";
import { createHash } from "node:crypto";
import type {
  AppServerBackendKind,
  ThreadPendingWakesList,
  NavigationQueueProjection,
  NavigationQueueProjectionRequest,
  NavigationLaunchpadConfiguration,
  NavigationLaunchpadConfigRequest,
  NavigationLaunchpadConfigResponse,
  NavigationSelectedDetailRequest,
  NavigationSelectedDetailResponse,
  ThreadSubAgentSummary,
  ThreadPullRequestWatchSummary,
} from "@pwragent/shared";
import {
  NAVIGATION_DETAIL_COLLECTION_NAMES,
  NAVIGATION_QUERY_MAX_RESULT_BYTES,
  NAVIGATION_QUERY_PROTOCOL_VERSION,
  projectActiveThreadSubAgents,
} from "@pwragent/shared";
import type { DesktopBackendRegistry } from "./backend-registry";
import { getDesktopBackendRegistry } from "./backend-registry";
import { getDesktopOverlayStore } from "../storage/desktop-overlay-store";
import { buildMessagingBindingsByThreadKey } from "../messaging/messaging-bindings-snapshot";
import { listCodexEnvironmentOptions } from "./codex-environment-config";
import { NavigationQueryError } from "./navigation-query-store";
import { describeHibernatedThreadWorkspace, detectMissingThreadWorkspace } from "./missing-thread-workspace";
import { readMergedSubAgentPage } from "./thread-display";
import { collectConcurrent } from "../../shared/concurrent-work";
import { listingDiagnostics } from "../diagnostics/listing-diagnostics";
import { boundThreadPendingWakes } from "./thread-pending-wakes";

function revision(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("base64url");
}

function responseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export class NavigationDetailService {
  constructor(
    private readonly registry: DesktopBackendRegistry = getDesktopBackendRegistry(),
  ) {}

  async readLaunchpadConfig(
    request: NavigationLaunchpadConfigRequest,
  ): Promise<NavigationLaunchpadConfigResponse> {
    if (request.protocol !== NAVIGATION_QUERY_PROTOCOL_VERSION
      || (request.directoryKey !== undefined
        && (typeof request.directoryKey !== "string" || request.directoryKey.length > 16_384))) {
      throw new NavigationQueryError("navigation_invalid_request", "Invalid launchpad configuration request.");
    }
    const store = getDesktopOverlayStore();
    const [defaults, storedLaunchpad] = await Promise.all([
      store.getLaunchpadDefaults(),
      request.directoryKey ? store.getDirectoryLaunchpad({ directoryKey: request.directoryKey }) : undefined,
    ]);
    const inspectPath = storedLaunchpad?.federationTarget?.scope === "remote" ? undefined : storedLaunchpad?.directoryPath;
    const [environmentOptions, directoryGitStatus] = inspectPath ? await Promise.all([
      listCodexEnvironmentOptions(inspectPath),
      this.registry.readSelectedWorkspaceGitStatus(inspectPath),
    ]) : [undefined, undefined];
    const launchpad: NavigationLaunchpadConfiguration | undefined = storedLaunchpad ? {
      backend: storedLaunchpad.backend,
      executionMode: storedLaunchpad.executionMode,
      workMode: storedLaunchpad.workMode,
      model: storedLaunchpad.model,
      reasoningEffort: storedLaunchpad.reasoningEffort,
      serviceTier: storedLaunchpad.serviceTier,
      fastMode: storedLaunchpad.fastMode,
      acpRuntime: storedLaunchpad.acpRuntime,
      providerSettings: storedLaunchpad.providerSettings,
      directoryKey: storedLaunchpad.directoryKey,
      directoryKind: storedLaunchpad.directoryKind,
      directoryLabel: storedLaunchpad.directoryLabel,
      directoryPath: storedLaunchpad.directoryPath,
      agent: storedLaunchpad.agent,
      mcpConnectionIds: storedLaunchpad.mcpConnectionIds,
      registeredAt: storedLaunchpad.registeredAt,
      settingsTouchedAt: storedLaunchpad.settingsTouchedAt,
      messagingToolUpdateMode: storedLaunchpad.messagingToolUpdateMode,
      prAutoDispatchEnabled: storedLaunchpad.prAutoDispatchEnabled,
      tokenMiserEnabled: storedLaunchpad.tokenMiserEnabled,
      branchName: storedLaunchpad.branchName,
      federationTarget: storedLaunchpad.federationTarget,
      parentThreadId: storedLaunchpad.parentThreadId,
      parentThreadBackend: storedLaunchpad.parentThreadBackend,
      parentThreadInstanceId: storedLaunchpad.parentThreadInstanceId,
      parentThreadTitle: storedLaunchpad.parentThreadTitle,
      sourceThreadId: storedLaunchpad.sourceThreadId,
      codexEnvironmentOptions: environmentOptions,
      codexEnvironmentId: storedLaunchpad.codexEnvironmentId,
      codexEnvironmentExecutionTarget: storedLaunchpad.codexEnvironmentExecutionTarget,
      codexEnvironmentActionId: storedLaunchpad.codexEnvironmentActionId,
      createdAt: storedLaunchpad.createdAt,
      updatedAt: storedLaunchpad.updatedAt,
    } : undefined;
    const payload = { defaults, directoryKey: request.directoryKey, launchpad, directoryGitStatus };
    const configRevision = revision(payload);
    const response: NavigationLaunchpadConfigResponse = {
      protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
      revision: configRevision,
      ...(request.knownRevision === configRevision ? { unchanged: true, directoryKey: request.directoryKey } : payload),
    };
    if (responseBytes(response) > NAVIGATION_QUERY_MAX_RESULT_BYTES) {
      throw new NavigationQueryError("navigation_item_too_large", "Selected launchpad configuration exceeds the bounded detail budget.");
    }
    return response;
  }

  async readSelectedDetail(
    request: NavigationSelectedDetailRequest,
    options: { includePendingWakes?: boolean } = {},
  ): Promise<NavigationSelectedDetailResponse> {
    return await listingDiagnostics.trace("workflow", { query: "selected-detail" }, () => this.readSelectedDetailData(request, options));
  }

  private async readSelectedDetailData(
    request: NavigationSelectedDetailRequest,
    options: { includePendingWakes?: boolean },
  ): Promise<NavigationSelectedDetailResponse> {
    if (request.protocol !== NAVIGATION_QUERY_PROTOCOL_VERSION) {
      throw new NavigationQueryError(
        "navigation_invalid_request",
        `Navigation query protocol ${NAVIGATION_QUERY_PROTOCOL_VERSION} is required.`,
      );
    }
    const summary = this.registry.getCachedThreadSummary({
      backend: request.ref.backend,
      threadId: request.ref.threadId,
    }) ?? await this.registry.resolveThread({
      backend: request.ref.backend,
      threadId: request.ref.threadId,
    });
    if (!summary) {
      return {
        protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
        ref: request.ref,
        revision: revision({ identity: "unresolved", ref: request.ref }),
        readiness: "ready",
        identity: "unresolved",
      };
    }
    if (request.collection) {
      const name = request.collection.name;
      if (!NAVIGATION_DETAIL_COLLECTION_NAMES.includes(name)) throw new NavigationQueryError("navigation_invalid_request", "Unknown selected-detail collection.");
      const store = getDesktopOverlayStore();
      let all: unknown[] | undefined;
      let count: number;
      let manifestRevision: string;
      if (name === "subAgents") {
        // Cards live in their own table. The revision comes from its counter
        // plus the in-memory live state, so paging never hashes every card,
        // and each page reads only its own rows below.
        const manifest = await this.subAgentCollectionManifest(request.ref, summary);
        count = manifest.count;
        manifestRevision = manifest.revision;
      } else {
        const overlay = await store.getThreadOverlayState({ backend: summary.source, threadId: summary.id });
        all = name === "codexNativeSubAgents" ? summary.codexNativeSubAgents ?? []
          : overlay?.[name] ?? (name === "worktreeSnapshots" ? summary.worktreeSnapshots : undefined) ?? [];
        count = all.length;
        manifestRevision = revision({ ref: request.ref, name, values: all });
      }
      return readNavigationSelectedCollection(request, { count, revision: manifestRevision,
        read: async (offset, limit) => all ? all.slice(offset, offset + limit)
          : await this.readSubAgentCollectionPage(summary, { offset, limit, count }),
      });
    }
    const messagingBindingsByThreadKey = await buildMessagingBindingsByThreadKey([
      summary,
    ]);
    const projected = await getDesktopOverlayStore().projectNavigationThreadDetail({
      thread: summary,
      messagingBindingsByThreadKey,
      queuedExecutionMode: this.registry.getQueuedExecutionModeForThread(request.ref),
    });
    const canonical = projected
      ? await this.registry.canonicalizeNavigationThreadPullRequests([projected]) : [];
    const hydrated = (await this.registry.hydrateThreadGitWorkingStates(canonical, {
      probeMissing: request.probeWorkingStates === true,
    }))[0];
    // Queue payloads have an independent complete FIFO resource and readiness.
    // A selected configuration read must not enumerate or duplicate that FIFO.
    const thread = hydrated ? (({ queuedTurns: _queue, ...configuration }) => configuration)(hydrated) : undefined;
    if (!thread) {
      return {
        protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
        ref: request.ref,
        revision: revision({ identity: "unresolved", ref: request.ref }),
        readiness: "ready",
        identity: "unresolved",
      };
    }
    if (request.includeWorkspaceConfiguration && thread.linkedDirectories.length > 100) {
      throw new NavigationQueryError("navigation_item_too_large", "Selected workspace configuration exceeds the 100-directory detail budget.");
    }
    // Ancillary reads and directory probes overlap. Peer wake projection
    // reuses the active-watch read. SQLite wrappers still execute synchronously;
    // GitReadCache continues to own physical Git admission.
    const activePrWatchesRead = getDesktopOverlayStore().listActiveThreadPrStatusWatches({ backend: summary.source, threadId: summary.id });
    // A hibernated checkout is not missing until a restore of it has failed.
    const checkoutHibernation = this.registry.readCheckoutHibernation({ backend: summary.source, threadId: summary.id });
    const [subAgentCollection, workspaceMissing, activeCards, activePrWatches, pendingWakes, workspaceDirectories] = await Promise.all([
      this.subAgentCollectionManifest(request.ref, summary),
      detectMissingThreadWorkspace(thread, {
        readBranch: async (repositoryPath) =>
          (await this.registry.readSelectedWorkspaceGitStatus(repositoryPath))?.currentBranch,
        includeHibernated: checkoutHibernation.restoreFailure !== undefined,
      }),
      getDesktopOverlayStore().listActiveThreadSubAgents({ backend: summary.source, threadId: summary.id }),
      activePrWatchesRead,
      options.includePendingWakes
        ? activePrWatchesRead.then((watches) => readPendingWakesForDetail({ backend: summary.source, threadId: summary.id }, watches))
        : undefined,
      request.includeWorkspaceConfiguration
        ? collectConcurrent(thread.linkedDirectories, 4, async (directory) => ({
            key: directory.id, label: directory.label, path: directory.path,
            gitStatus: directory.path ? await this.registry.readSelectedWorkspaceGitStatus(directory.path) : undefined,
          }))
        : undefined,
    ]);
    const collections = NAVIGATION_DETAIL_COLLECTION_NAMES.map((name) => name === "subAgents"
      ? { name, ...subAgentCollection }
      : {
          name, count: thread[name]?.length ?? 0,
          revision: revision({ ref: request.ref, name, values: thread[name] ?? [] }),
        });
    // Checked on every detail read, never stored: one stat while the folder
    // exists. Viewers on other instances get the owner's answer.
    const workspaceHibernated = workspaceMissing ? undefined
      : checkoutHibernation.progress ?? describeHibernatedThreadWorkspace(thread, checkoutHibernation.restoring);
    const configuration = {
      ...thread,
      ...(workspaceMissing ? { workspaceMissing } : {}),
      ...(workspaceHibernated ? { workspaceHibernated } : {}),
    };
    for (const name of NAVIGATION_DETAIL_COLLECTION_NAMES) delete configuration[name];
    // Live gate events and selected-detail refreshes must expose the same
    // helpers before persistence at turn end; active cards come from the
    // partial index, never from the thread's whole card history.
    configuration.activeSubAgents = projectActiveThreadSubAgents(summary.source === "codex"
      ? this.registry.mergeLiveTokenMiserSubAgents(summary.id, activeCards)
      : activeCards);
    // The owner's watches, so a peer viewer reads the same list. Detail only:
    // it is projected per read and never stored with the navigation row.
    if (activePrWatches.length > 0) configuration.activePrWatches = activePrWatches;
    // Only peer viewers need this projection; local windows use the pending
    // wakes IPC channel. Keep its live activity out of local detail revisions.
    if (pendingWakes) {
      configuration.pendingWakes = pendingWakes.wakes;
      if (pendingWakes.incomplete) configuration.pendingWakesIncomplete = true;
    }
    if (configuration.pendingWakes) {
      const baseBytes = responseBytes({ ref: request.ref, thread: { ...configuration, pendingWakes: [] }, collections, workspaceDirectories }) + 512;
      const bounded = boundThreadPendingWakes({ wakes: configuration.pendingWakes }, Math.max(0, NAVIGATION_QUERY_MAX_RESULT_BYTES - baseBytes));
      configuration.pendingWakes = bounded.wakes;
      if (bounded.incomplete) configuration.pendingWakesIncomplete = true;
    }
    return projectNavigationSelectedDetail(request, configuration, collections, workspaceDirectories);
  }

  /**
   * One page of the merged card collection, newest `createdAt` first: only
   * the page's rows from the card table, with live gates merged in order and
   * live usage applied. `count` is the collection manifest's.
   */
  private async readSubAgentCollectionPage(
    summary: { id: string; source: AppServerBackendKind },
    page: { offset: number; limit: number; count: number },
  ): Promise<ThreadSubAgentSummary[]> {
    if (page.limit === 0) return [];
    const store = getDesktopOverlayStore();
    const thread = { backend: summary.source, threadId: summary.id };
    const live = summary.source === "codex" ? this.registry.listLiveTokenMiserSubAgents(summary.id) : [];
    const excludeMonitorIds = live.map((card) => card.monitorId);
    const cards = await readMergedSubAgentPage({
      offset: page.offset,
      limit: page.limit,
      storedCount: page.count - live.length,
      live,
      read: (offset, limit) => store.listThreadSubAgentPage({ ...thread, excludeMonitorIds, offset, limit }),
    });
    if (summary.source !== "codex") return cards;
    // Live usage lands on the page's own cards and never moves one.
    const merged = new Map(this.registry.mergeLiveTokenMiserSubAgents(summary.id, cards)
      .map((card) => [card.monitorId, card]));
    return cards.map((card) => merged.get(card.monitorId) ?? card);
  }

  /** Count and revision of the merged card collection, without reading stored cards. */
  private async subAgentCollectionManifest(
    ref: NavigationSelectedDetailRequest["ref"],
    summary: { id: string; source: AppServerBackendKind },
  ): Promise<{ count: number; revision: string }> {
    const store = getDesktopOverlayStore();
    const thread = { backend: summary.source, threadId: summary.id };
    const stored = await store.readThreadSubAgentRevision(thread);
    // The order is part of the revision: a cursor issued while Codex
    // collections were ordered by `updatedAt` must not page this order.
    if (summary.source !== "codex") {
      return { count: stored.count, revision: revision({ ref, name: "subAgents", order: "created", stored }) };
    }
    // Live gates add to the count only when not yet persisted.
    const liveIds = this.registry.listLiveTokenMiserSubAgents(summary.id).map((card) => card.monitorId);
    const persisted = await store.getThreadSubAgents({ ...thread, monitorIds: liveIds });
    return {
      count: stored.count + liveIds.length - persisted.length,
      revision: revision({ ref, name: "subAgents", order: "created", stored,
        live: this.registry.readLiveSubAgentRevisionSource(summary.id) }),
    };
  }

  readQueueProjection(request: NavigationQueueProjectionRequest): NavigationQueueProjection {
    return readNavigationQueueProjection(request, () => this.registry.iterateQueuedTurnSummaries(request.ref),
      this.registry.getQueuedExecutionModeForThread(request.ref)?.mode);
  }
}

type PendingWakesProjector = (thread: {
  backend: AppServerBackendKind;
  threadId: string;
}, activePrWatches: readonly ThreadPullRequestWatchSummary[]) => Promise<Pick<ThreadPendingWakesList, "wakes" | "incomplete">>;

let pendingWakesProjector: PendingWakesProjector | undefined;

/** Main's app-server service supplies the list; tests leave it unset. */
export function setNavigationDetailPendingWakesProjector(projector: PendingWakesProjector | undefined): void {
  pendingWakesProjector = projector;
}

/** A failed read leaves the field out rather than failing the detail. */
async function readPendingWakesForDetail(thread: {
  backend: AppServerBackendKind;
  threadId: string;
}, activePrWatches: readonly ThreadPullRequestWatchSummary[]): Promise<Pick<ThreadPendingWakesList, "wakes" | "incomplete"> | undefined> {
  if (!pendingWakesProjector) return undefined;
  try {
    return await pendingWakesProjector(thread, activePrWatches);
  } catch {
    return undefined;
  }
}

let desktopNavigationDetailService: NavigationDetailService | undefined;

export function getDesktopNavigationDetailService(): NavigationDetailService {
  desktopNavigationDetailService ??= new NavigationDetailService();
  return desktopNavigationDetailService;
}
