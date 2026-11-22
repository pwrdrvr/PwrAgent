import { createHash } from "node:crypto";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import type { ThreadPendingWakesList } from "@pwragent/shared/contracts/thread-pending-wakes";
import type {
  NavigationQueueProjection,
  NavigationQueueProjectionRequest,
  NavigationLaunchpadConfiguration,
  NavigationLaunchpadConfigRequest,
  NavigationLaunchpadConfigResponse,
  NavigationSelectedDetailRequest,
  NavigationSelectedDetailResponse,
  ThreadActiveSubAgent,
  ThreadSubAgentSummary,
} from "@pwragent/shared/contracts/navigation";
import type { ThreadPullRequestWatchSummary } from "@pwragent/shared/contracts/thread-tools";
import {
  isThreadSubAgentVisibleInPanel,
  projectActiveThreadSubAgents,
} from "@pwragent/shared/subagent-visibility";
import {
  NAVIGATION_DETAIL_COLLECTION_NAMES,
  NAVIGATION_QUERY_MAX_RESULT_BYTES,
  NAVIGATION_QUERY_PROTOCOL_VERSION,
} from "@pwragent/shared/contracts/navigation";
import type { DesktopBackendRegistry } from "./backend-registry";
import { getDesktopBackendRegistry } from "./backend-registry";
import { getDesktopOverlayStore } from "../storage/desktop-overlay-store";
import { getOwnerHostServices } from "../owner-host";
import { buildMessagingBindingsByThreadKey } from "../messaging/messaging-bindings-snapshot";
import { listCodexEnvironmentOptions } from "./codex-environment-config";
import { NavigationQueryError } from "./navigation-query-store";
import { describeHibernatedThreadWorkspace, detectMissingThreadWorkspace, primaryThreadWorktree } from "./missing-thread-workspace";
import { normalizeWorktreePathForComparison } from "./linked-directory-identity";
import { readMergedSubAgentPage } from "./thread-display";
import { collectConcurrent } from "../../shared/concurrent-work";
import { listingDiagnostics } from "../diagnostics/listing-diagnostics";
import { resolvePrimaryThreadRepoKey } from "../pr-status/primary-thread-repository";
import { PR_METADATA_PRIORITY, type PrMetadataDemand } from "../pr-status/pr-metadata-process";
import { boundThreadPendingWakes } from "./thread-pending-wakes";

/** The most records one selected-collection page holds, before the byte budget. */
const SELECTED_COLLECTION_PAGE_RECORDS = 100;
const ACTIVE_SUB_AGENT_PREVIEW_ROWS = 32;
const ACTIVE_SUB_AGENT_PREVIEW_BYTES = 32 * 1024;
const ACTIVE_SUB_AGENT_TASK_PREVIEW_CHARS = 512;

function revision(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("base64url");
}

function unresolvedDetail(
  request: NavigationSelectedDetailRequest,
  readiness: NavigationSelectedDetailResponse["readiness"] = "ready",
): NavigationSelectedDetailResponse {
  return {
    protocol: NAVIGATION_QUERY_PROTOCOL_VERSION, ref: request.ref, lookup: request.lookup,
    revision: revision({ identity: "unresolved", ref: request.ref, readiness, lookup: request.lookup }),
    readiness, identity: "unresolved",
  };
}

function responseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isFailedSubAgent(agent: ThreadActiveSubAgent): boolean {
  return agent.status === "failed" || agent.status === "failure";
}

function compareComposerSubAgents(left: ThreadSubAgentSummary, right: ThreadSubAgentSummary): number {
  const leftFailed = isFailedSubAgent(left);
  const rightFailed = isFailedSubAgent(right);
  return leftFailed && rightFailed
    ? (right.completedAt ?? right.updatedAt) - (left.completedAt ?? left.updatedAt)
    : Number(leftFailed) - Number(rightFailed);
}

/** The remaining JSON string content bytes, after accounting for its quotes. */
function fitSubAgentTask(task: string, maxBytes: number): string {
  const ellipsis = "…";
  let remaining = maxBytes - (responseBytes(ellipsis) - 2);
  if (remaining < 0) return "";
  let prefix = "";
  for (const character of task) {
    remaining -= responseBytes(character) - 2;
    if (remaining < 0) break;
    prefix += character;
  }
  return `${prefix}${ellipsis}`;
}

/** Keep stop controls for live work ahead of the newest failed work. */
function boundActiveSubAgents(cards: readonly ThreadSubAgentSummary[], maxBytes: number): {
  rows: ThreadActiveSubAgent[];
  addedBytes: number;
  incomplete: boolean;
  moreInPanel: boolean;
} {
  const projected = projectActiveThreadSubAgents(cards.toSorted(compareComposerSubAgents));
  const rows: ThreadActiveSubAgent[] = [];
  let addedBytes = 0;
  let omittedLive = false;
  for (const row of projected) {
    const failed = isFailedSubAgent(row);
    if (rows.length >= ACTIVE_SUB_AGENT_PREVIEW_ROWS || (failed && omittedLive)) break;
    const task = row.task.length > ACTIVE_SUB_AGENT_TASK_PREVIEW_CHARS
      ? `${row.task.slice(0, ACTIVE_SUB_AGENT_TASK_PREVIEW_CHARS - 1).replace(/[\uD800-\uDBFF]$/u, "")}…`
      : row.task;
    const preview = { ...row, task };
    const separatorBytes = Number(rows.length > 0);
    const available = maxBytes - addedBytes - separatorBytes;
    let size = responseBytes(preview);
    if (size > available) {
      if (failed) continue;
      const withoutTask = responseBytes({ ...preview, task: "" });
      if (withoutTask > available) {
        omittedLive = true;
        continue;
      }
      preview.task = fitSubAgentTask(task, available - withoutTask);
      size = responseBytes(preview);
    }
    rows.push(preview);
    addedBytes += size + separatorBytes;
  }
  const incomplete = rows.length < projected.length;
  if (!incomplete) return { rows, addedBytes, incomplete, moreInPanel: false };
  const shownIds = new Set(rows.map((row) => row.monitorId));
  const omittedIds = new Set(projected.filter((row) => !shownIds.has(row.monitorId)).map((row) => row.monitorId));
  const now = Date.now();
  const moreInPanel = cards.some((card) => omittedIds.has(card.monitorId) && isThreadSubAgentVisibleInPanel(card, now));
  return { rows, addedBytes, incomplete, moreInPanel };
}

type QueueCursor = {
  offset: number;
  revision: string;
};

function encodeQueueCursor(cursor: QueueCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeQueueCursor(value: string): QueueCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<QueueCursor>;
    if (
      typeof parsed.offset !== "number"
      || !Number.isSafeInteger(parsed.offset)
      || parsed.offset < 0
      || typeof parsed.revision !== "string"
    ) {
      throw new Error("invalid cursor fields");
    }
    return parsed as QueueCursor;
  } catch {
    throw new NavigationQueryError(
      "navigation_invalid_request",
      "Queue projection cursor is malformed.",
    );
  }
}

/** The registry members detail reads use. Narrowed so a stand-in typed
 * against it fails typecheck when the service starts calling another one. */
export type NavigationDetailRegistry = Pick<
  DesktopBackendRegistry,
  | "canonicalizeNavigationThreadPullRequests"
  | "getCachedThreadSummary"
  | "getThreadInfo"
  | "getQueuedExecutionModeForThread"
  | "hydrateThreadGitWorkingStates"
  | "isIncompleteThreadList"
  | "iterateQueuedTurnSummaries"
  | "listThreads"
  | "listLiveTokenMiserSubAgents"
  | "mergeLiveTokenMiserSubAgents"
  | "projectOutpostLaunchpadSettings"
  | "readCheckoutHibernation"
  | "readLiveSubAgentRevisionSource"
  | "readNavigationThreadLink"
  | "readSelectedWorkspaceGitStatus"
  | "resolveThread"
>;

export class NavigationDetailService {
  constructor(
    private readonly registry: NavigationDetailRegistry = getDesktopBackendRegistry(),
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
    const [storedDefaults, rawLaunchpad] = await Promise.all([
      store.getLaunchpadDefaults(),
      request.directoryKey ? store.getDirectoryLaunchpad({ directoryKey: request.directoryKey }) : undefined,
    ]);
    const useProxyModels = getOwnerHostServices().runtimePolicy?.codexOpenAiProviderEnabled === false;
    const defaults = useProxyModels ? this.registry.projectOutpostLaunchpadSettings(storedDefaults) : storedDefaults;
    const storedLaunchpad = useProxyModels && rawLaunchpad ? this.registry.projectOutpostLaunchpadSettings(rawLaunchpad) : rawLaunchpad;
    const inspectPath = storedLaunchpad?.federationTarget?.scope === "remote" ? undefined : storedLaunchpad?.directoryPath;
    const [environmentOptions, directoryGitStatus] = inspectPath ? await Promise.all([
      listCodexEnvironmentOptions(inspectPath),
      this.registry.readSelectedWorkspaceGitStatus(inspectPath),
    ]) : [undefined, undefined];
    const launchpad: NavigationLaunchpadConfiguration | undefined = storedLaunchpad ? {
      backend: storedLaunchpad.backend,
      codexModelProviderId: storedLaunchpad.codexModelProviderId,
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
    options: { includePendingWakes?: boolean; signal?: AbortSignal } = {},
  ): Promise<NavigationSelectedDetailResponse> {
    return await listingDiagnostics.trace("workflow", { query: "selected-detail" }, () => this.readSelectedDetailData(request, options));
  }

  private async readThreadLinkDetail(request: NavigationSelectedDetailRequest): Promise<NavigationSelectedDetailResponse> {
    const match = await this.registry.readNavigationThreadLink(request.ref).catch(() => null);
    if (!match) return unresolvedDetail(request, match === null ? "failed" : "ready");
    const { id, source, title, titleSource, createdAt, updatedAt, threadStatus, gitBranch, executionMode, model, reasoningEffort } = match.thread;
    const thread = { id, source, title, titleSource, createdAt, updatedAt, threadStatus, gitBranch, executionMode,
      model, reasoningEffort, linkedDirectories: [], inbox: { inInbox: false } };
    const identity = match.archived ? "archived" : "present";
    const response: NavigationSelectedDetailResponse = {
      protocol: NAVIGATION_QUERY_PROTOCOL_VERSION, ref: request.ref, lookup: request.lookup,
      revision: revision({ identity, thread }), readiness: "ready", identity, thread,
    };
    if (responseBytes(response) > NAVIGATION_QUERY_MAX_RESULT_BYTES) {
      throw new NavigationQueryError("navigation_item_too_large", "Thread link facts exceed the bounded detail budget.");
    }
    return response;
  }

  private async readSelectedDetailData(
    request: NavigationSelectedDetailRequest,
    options: { includePendingWakes?: boolean; signal?: AbortSignal },
  ): Promise<NavigationSelectedDetailResponse> {
    if (request.protocol !== NAVIGATION_QUERY_PROTOCOL_VERSION) {
      throw new NavigationQueryError(
        "navigation_invalid_request",
        `Navigation query protocol ${NAVIGATION_QUERY_PROTOCOL_VERSION} is required.`,
      );
    }
    if (request.lookup === "thread-link") return await this.readThreadLinkDetail(request);
    let summary = this.registry.getCachedThreadSummary({
      backend: request.ref.backend,
      threadId: request.ref.threadId,
    }) ?? await this.registry.resolveThread({
      backend: request.ref.backend,
      threadId: request.ref.threadId,
    });
    // An explicit link can name an archived thread that active navigation
    // has never loaded. Keep this fallback on the read-only detail path:
    // resolveThread also admits message destinations and must stay active-only.
    if (!summary) {
      const archived = await this.registry.listThreads({
        backend: request.ref.backend, archived: true, enrichDirectories: false,
        callerReason: "thread-id-lookup",
      });
      summary = archived.find((thread) => thread.id === request.ref.threadId);
      if (!summary && this.registry.isIncompleteThreadList(archived)) return unresolvedDetail(request, "failed");
    }
    if (!summary) return unresolvedDetail(request);
    // Membership comes from the owner's archive observations, not archivedAt:
    // Codex can omit that timestamp or retain one after an unarchive. Keep the
    // history available without authorizing the archived thread's composer.
    const identity = this.registry.getThreadInfo(request.ref)?.archived === true ? "archived" : "present";
    const prDemand: PrMetadataDemand = { priority: () => PR_METADATA_PRIORITY.selected, signal: options.signal };
    if (request.collection) {
      const name = request.collection.name;
      if (name !== "prs" && !NAVIGATION_DETAIL_COLLECTION_NAMES.includes(name)) throw new NavigationQueryError("navigation_invalid_request", "Unknown selected-detail collection.");
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
        if (name === "prs") {
          // Membership comes from the owner's overlay. Resolve status from
          // the registry just as for a compact row or exact configuration.
          const [thread] = await this.registry.canonicalizeNavigationThreadPullRequests([
            { ...summary, inbox: { inInbox: false }, prs: overlay?.prs },
          ], prDemand);
          all = thread?.prs ?? [];
        } else {
          all = name === "codexNativeSubAgents" ? summary.codexNativeSubAgents ?? []
            : overlay?.[name] ?? (name === "worktreeSnapshots" ? summary.worktreeSnapshots : undefined) ?? [];
        }
        count = all.length;
        manifestRevision = revision({ ref: request.ref, name, values: all });
      }
      const manifest = { name, revision: manifestRevision };
      const cursor = request.collection.cursor ? decodeQueueCursor(request.collection.cursor) : undefined;
      if (cursor && cursor.revision !== manifest.revision) {
        throw new NavigationQueryError("navigation_cursor_expired", "Selected collection changed while paging; restart this collection.");
      }
      const offset = cursor?.offset ?? 0;
      if (offset > count) throw new NavigationQueryError("navigation_invalid_request", "Selected collection cursor is outside its revision.");
      const limit = Math.min(SELECTED_COLLECTION_PAGE_RECORDS, count - offset);
      const values = all ? all.slice(offset, offset + limit)
        : await this.readSubAgentCollectionPage(summary, { offset, limit, count });
      // A stored card that does not parse is counted but never read. A short
      // read is the collection's end, so a viewer is never left without one.
      const end = values.length < limit ? offset + values.length : count;
      const response: NavigationSelectedDetailResponse = {
        protocol: 2, ref: request.ref, revision: manifest.revision, readiness: "ready", identity,
        collectionPage: { name: manifest.name, revision: manifest.revision,
          values: { [manifest.name]: [] }, complete: offset === end },
      };
      const envelopeBytes = responseBytes(response);
      let valuesBytes = 0;
      let accepted = 0;
      for (let taken = 1; taken <= values.length; taken += 1) {
        const next = offset + taken;
        const complete = next === end;
        const nextCursor = next < end ? encodeQueueCursor({ offset: next, revision: manifest.revision }) : undefined;
        // Size each record in array context (including JSON's null fallback),
        // without reserializing the admitted prefix. Brackets are in the envelope.
        valuesBytes += responseBytes([values[taken - 1]]) - 2 + (taken > 1 ? 1 : 0);
        // Nonempty pages start with complete:false; true is one byte shorter.
        // A base64url cursor needs no escaping, but its offset changes its length.
        const candidateBytes = envelopeBytes + valuesBytes - (complete ? 1 : 0)
          + (nextCursor === undefined ? 0 : ",\"nextCursor\":\"\"".length + nextCursor.length);
        if (candidateBytes > NAVIGATION_QUERY_MAX_RESULT_BYTES) {
          if (taken === 1) throw new NavigationQueryError("navigation_item_too_large", "One selected collection record exceeds the result budget.");
          break;
        }
        accepted = taken;
        response.collectionPage!.complete = complete;
        response.collectionPage!.nextCursor = nextCursor;
      }
      if (accepted > 0) {
        response.collectionPage!.values = { [manifest.name]: values.slice(0, accepted) };
      }
      return response;
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
      ? await this.registry.canonicalizeNavigationThreadPullRequests([projected], prDemand) : [];
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
    const worktreePath = primaryThreadWorktree(thread)?.worktreePath;
    const failedRestorePath = checkoutHibernation.restoreFailure?.worktreePath;
    const [subAgentCollection, workspaceMissing, activeCards, activePrWatches, pendingWakes, workspaceDirectories, primaryGitRepository] = await Promise.all([
      this.subAgentCollectionManifest(request.ref, summary),
      detectMissingThreadWorkspace(thread, {
        readBranch: async (repositoryPath) =>
          (await this.registry.readSelectedWorkspaceGitStatus(repositoryPath))?.currentBranch,
        includeHibernated: Boolean(worktreePath && failedRestorePath
          && normalizeWorktreePathForComparison(worktreePath) === normalizeWorktreePathForComparison(failedRestorePath)),
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
      thread.primaryGitRepository ?? resolvePrimaryThreadRepoKey(thread, undefined, { demand: prDemand }),
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
      ...(primaryGitRepository ? { primaryGitRepository } : {}),
      ...(workspaceMissing ? { workspaceMissing } : {}),
      ...(workspaceHibernated ? { workspaceHibernated } : {}),
    };
    for (const name of NAVIGATION_DETAIL_COLLECTION_NAMES) delete configuration[name];
    // Live gate events and selected-detail refreshes must expose the same
    // helpers before persistence at turn end; active cards come from the
    // partial index, never from the thread's whole card history.
    const composerCards = summary.source === "codex"
      ? this.registry.mergeLiveTokenMiserSubAgents(summary.id, activeCards)
      : activeCards;
    configuration.activeSubAgents = [];
    // The owner's watches, so a peer viewer reads the same list. Detail only:
    // it is projected per read and never stored with the navigation row.
    if (activePrWatches.length > 0) configuration.activePrWatches = activePrWatches;
    // Only peer viewers need this projection; local windows use the pending
    // wakes IPC channel. Keep its live activity out of local detail revisions.
    if (pendingWakes) {
      configuration.pendingWakes = [];
      if (pendingWakes.incomplete) configuration.pendingWakesIncomplete = true;
      if (pendingWakes.followUpsSuspended) configuration.pendingWakesFollowUpsSuspended = true;
    }
    if (composerCards.length || pendingWakes?.wakes.length) {
      // Leave room for the envelope and incomplete flags before allocating
      // the remaining capacity between the independent previews.
      const baseBytes = responseBytes({ ref: request.ref, thread: configuration, collections, workspaceDirectories }) + 512;
      const previewBytes = Math.max(0, NAVIGATION_QUERY_MAX_RESULT_BYTES - baseBytes);
      // The base already includes the two brackets of each empty array.
      const active = boundActiveSubAgents(composerCards, Math.min(ACTIVE_SUB_AGENT_PREVIEW_BYTES - 2, previewBytes));
      configuration.activeSubAgents = active.rows;
      if (active.incomplete) configuration.activeSubAgentsIncomplete = true;
      if (active.moreInPanel) configuration.activeSubAgentsMoreInPanel = true;
      if (pendingWakes) {
        const wakes = boundThreadPendingWakes(pendingWakes, previewBytes - active.addedBytes + 2);
        configuration.pendingWakes = wakes.wakes;
        if (wakes.incomplete) configuration.pendingWakesIncomplete = true;
      }
    }
    const detailRevision = revision({ identity, thread: configuration, workspaceDirectories });
    if (request.knownRevision === detailRevision) {
      return {
        protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
        ref: request.ref,
        revision: detailRevision,
        readiness: "ready",
        identity,
        unchanged: true,
        collections,
      };
    }
    const response: NavigationSelectedDetailResponse = {
      protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
      ref: request.ref,
      revision: detailRevision,
      readiness: "ready",
      identity,
      thread: configuration,
      collections,
      ...(workspaceDirectories ? { workspaceDirectories } : {}),
    };
    const bytes = responseBytes(response);
    if (bytes > NAVIGATION_QUERY_MAX_RESULT_BYTES) {
      throw new NavigationQueryError(
        "navigation_item_too_large",
        `Selected thread detail exceeds the result budget (${bytes} bytes, limit ${NAVIGATION_QUERY_MAX_RESULT_BYTES} bytes).`,
      );
    }
    return response;
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

  readQueueProjection(
    request: NavigationQueueProjectionRequest,
  ): NavigationQueueProjection {
    if (request.protocol !== NAVIGATION_QUERY_PROTOCOL_VERSION) {
      throw new NavigationQueryError(
        "navigation_invalid_request",
        `Navigation query protocol ${NAVIGATION_QUERY_PROTOCOL_VERSION} is required.`,
      );
    }
    // Hash one compact summary at a time. The independent FIFO may outlive
    // every navigation page; do not clone/stringify its complete population.
    const hash = createHash("sha256");
    let entryCount = 0;
    let projectionBytes = 0;
    for (const entry of this.registry.iterateQueuedTurnSummaries(request.ref)) {
      const encoded = JSON.stringify(entry);
      projectionBytes += Buffer.byteLength(encoded, "utf8");
      if (projectionBytes > 8 * 1024 * 1024) {
        throw new NavigationQueryError("navigation_busy", "Queue projection exceeds its 8 MiB admission budget.");
      }
      hash.update(encoded).update("\n");
      entryCount += 1;
    }
    const queuedExecutionMode = this.registry.getQueuedExecutionModeForThread(request.ref)?.mode;
    const queueRevision = hash.update(JSON.stringify({ queuedExecutionMode })).digest("base64url");
    if (!request.cursor && request.knownRevision === queueRevision) {
      return {
        protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
        ref: request.ref,
        revision: queueRevision,
        readiness: "ready",
        complete: true,
        entries: [],
        unchanged: true,
      };
    }
    const cursor = request.cursor ? decodeQueueCursor(request.cursor) : undefined;
    if (cursor && cursor.revision !== queueRevision) {
      throw new NavigationQueryError(
        "navigation_cursor_expired",
        "Queue changed while paging; restart from its current revision.",
      );
    }
    const offset = cursor?.offset ?? 0;
    if (offset > entryCount) {
      throw new NavigationQueryError(
        "navigation_invalid_request",
        "Queue projection cursor is outside its revision.",
      );
    }
    const response: NavigationQueueProjection = {
      protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
      ref: request.ref,
      revision: queueRevision,
      readiness: "ready",
      complete: false,
      entries: [],
      ...(queuedExecutionMode ? { queuedExecutionMode } : {}),
    };
    let nextOffset = offset;
    let position = 0;
    for (const entry of this.registry.iterateQueuedTurnSummaries(request.ref)) {
      if (position++ < offset) continue;
      if (nextOffset - offset >= 100) break;
      const candidate = {
        ...response,
        entries: [...response.entries, entry],
        complete: nextOffset + 1 >= entryCount,
        ...(nextOffset + 1 < entryCount ? { nextCursor: encodeQueueCursor({
          offset: nextOffset + 1,
          revision: queueRevision,
        }) } : {}),
      };
      if (responseBytes(candidate) > NAVIGATION_QUERY_MAX_RESULT_BYTES) {
        if (nextOffset === offset) {
          throw new NavigationQueryError(
            "navigation_item_too_large",
            "One queue entry exceeds the result budget.",
          );
        }
        break;
      }
      response.entries.push(entry);
      nextOffset += 1;
    }
    response.complete = nextOffset >= entryCount;
    if (!response.complete) {
      response.nextCursor = encodeQueueCursor({
        offset: nextOffset,
        revision: queueRevision,
      });
    }
    return response;
  }
}

type PendingWakesProjector = (thread: {
  backend: AppServerBackendKind;
  threadId: string;
}, activePrWatches: readonly ThreadPullRequestWatchSummary[]) => Promise<Pick<ThreadPendingWakesList, "wakes" | "incomplete" | "followUpsSuspended">>;

let pendingWakesProjector: PendingWakesProjector | undefined;

/** Main's app-server service supplies the list; tests leave it unset. */
export function setNavigationDetailPendingWakesProjector(projector: PendingWakesProjector | undefined): void {
  pendingWakesProjector = projector;
}

/** A failed read leaves the field out rather than failing the detail. */
async function readPendingWakesForDetail(thread: {
  backend: AppServerBackendKind;
  threadId: string;
}, activePrWatches: readonly ThreadPullRequestWatchSummary[]): Promise<Pick<ThreadPendingWakesList, "wakes" | "incomplete" | "followUpsSuspended"> | undefined> {
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
