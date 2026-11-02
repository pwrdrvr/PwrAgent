import { createHash } from "node:crypto";
import type {
  AppServerBackendKind,
  NavigationQueueProjection,
  NavigationQueueProjectionRequest,
  NavigationLaunchpadConfiguration,
  NavigationLaunchpadConfigRequest,
  NavigationLaunchpadConfigResponse,
  NavigationSelectedDetailRequest,
  NavigationSelectedDetailResponse,
  ThreadSubAgentSummary,
} from "@pwragent/shared";
import {
  NAVIGATION_DETAIL_COLLECTION_NAMES,
  NAVIGATION_QUERY_MAX_RESULT_BYTES,
  NAVIGATION_QUERY_PROTOCOL_VERSION,
  projectActiveThreadSubAgents,
} from "@pwragent/shared";
import type { DesktopBackendRegistry } from "./backend-registry";
import { getDesktopBackendRegistry } from "./backend-registry";
import { getDesktopOverlayStore } from "./desktop-overlay-store";
import { buildMessagingBindingsByThreadKey } from "../messaging/messaging-bindings-snapshot";
import { listCodexEnvironmentOptions } from "./codex-environment-config";
import { NavigationQueryError } from "./navigation-query-store";
import { detectMissingThreadWorkspace } from "./missing-thread-workspace";
import { readMergedSubAgentPage } from "./thread-display";

/** The most records one selected-collection page holds, before the byte budget. */
const SELECTED_COLLECTION_PAGE_RECORDS = 100;

function revision(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("base64url");
}

function responseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
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
        protocol: 2, ref: request.ref, revision: manifest.revision, readiness: "ready", identity: "present",
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
    const subAgentCollection = await this.subAgentCollectionManifest(request.ref, summary);
    const collections = NAVIGATION_DETAIL_COLLECTION_NAMES.map((name) => name === "subAgents"
      ? { name, ...subAgentCollection }
      : {
          name, count: thread[name]?.length ?? 0,
          revision: revision({ ref: request.ref, name, values: thread[name] ?? [] }),
        });
    // Checked on every detail read, never stored: one stat while the folder
    // exists. Viewers on other instances get the owner's answer.
    const workspaceMissing = await detectMissingThreadWorkspace(thread, {
      readBranch: async (repositoryPath) =>
        (await this.registry.readSelectedWorkspaceGitStatus(repositoryPath))?.currentBranch,
    });
    const configuration = { ...thread, ...(workspaceMissing ? { workspaceMissing } : {}) };
    for (const name of NAVIGATION_DETAIL_COLLECTION_NAMES) delete configuration[name];
    // Live gate events and selected-detail refreshes must expose the same
    // helpers before persistence at turn end; active cards come from the
    // partial index, never from the thread's whole card history.
    const activeCards = await getDesktopOverlayStore().listActiveThreadSubAgents({
      backend: summary.source, threadId: summary.id,
    });
    configuration.activeSubAgents = projectActiveThreadSubAgents(summary.source === "codex"
      ? this.registry.mergeLiveTokenMiserSubAgents(summary.id, activeCards)
      : activeCards);
    // The owner's watches, so a peer viewer reads the same list. Detail only:
    // it is projected per read and never stored with the navigation row.
    const activePrWatches = await getDesktopOverlayStore().listActiveThreadPrStatusWatches({
      backend: summary.source, threadId: summary.id,
    });
    if (activePrWatches.length > 0) configuration.activePrWatches = activePrWatches;
    let workspaceDirectories: NavigationSelectedDetailResponse["workspaceDirectories"];
    if (request.includeWorkspaceConfiguration) {
      if (thread.linkedDirectories.length > 100) {
        throw new NavigationQueryError("navigation_item_too_large", "Selected workspace configuration exceeds the 100-directory detail budget.");
      }
      workspaceDirectories = [];
      for (const directory of thread.linkedDirectories) {
        workspaceDirectories.push({ key: directory.id, label: directory.label, path: directory.path,
          gitStatus: directory.path ? await this.registry.readSelectedWorkspaceGitStatus(directory.path) : undefined });
      }
    }
    const detailRevision = revision({ thread: configuration, workspaceDirectories });
    if (request.knownRevision === detailRevision) {
      return {
        protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
        ref: request.ref,
        revision: detailRevision,
        readiness: "ready",
        identity: "present",
        unchanged: true,
        collections,
      };
    }
    const response: NavigationSelectedDetailResponse = {
      protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
      ref: request.ref,
      revision: detailRevision,
      readiness: "ready",
      identity: "present",
      thread: configuration,
      collections,
      ...(workspaceDirectories ? { workspaceDirectories } : {}),
    };
    if (responseBytes(response) > NAVIGATION_QUERY_MAX_RESULT_BYTES) {
      throw new NavigationQueryError(
        "navigation_item_too_large",
        "Selected thread detail exceeds the result budget; read its collections separately.",
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

let desktopNavigationDetailService: NavigationDetailService | undefined;

export function getDesktopNavigationDetailService(): NavigationDetailService {
  desktopNavigationDetailService ??= new NavigationDetailService();
  return desktopNavigationDetailService;
}
