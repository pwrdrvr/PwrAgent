import { createHash } from "node:crypto";
import type {
  NavigationQueueProjection,
  NavigationQueueProjectionRequest,
  NavigationLaunchpadConfiguration,
  NavigationLaunchpadConfigRequest,
  NavigationLaunchpadConfigResponse,
  NavigationSelectedDetailRequest,
  NavigationSelectedDetailResponse,
  ThreadQueuedTurnSummary,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  NAVIGATION_QUERY_MAX_RESULT_BYTES,
  NAVIGATION_QUERY_PROTOCOL_VERSION,
} from "@pwragent/shared";
import type { DesktopBackendRegistry } from "./backend-registry";
import { getDesktopBackendRegistry } from "./backend-registry";
import { getDesktopOverlayStore } from "./desktop-overlay-store";
import { resolveScratchProjectsRoots } from "./scratch-projects";
import { buildMessagingBindingsByThreadKey } from "../messaging/messaging-bindings-snapshot";
import { NavigationQueryError } from "./navigation-query-store";

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
      codexEnvironmentId: storedLaunchpad.codexEnvironmentId,
      codexEnvironmentExecutionTarget: storedLaunchpad.codexEnvironmentExecutionTarget,
      codexEnvironmentActionId: storedLaunchpad.codexEnvironmentActionId,
      createdAt: storedLaunchpad.createdAt,
      updatedAt: storedLaunchpad.updatedAt,
    } : undefined;
    const payload = { defaults, directoryKey: request.directoryKey, launchpad };
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
    const threadKey = buildThreadIdentityKey(summary.source, summary.id);
    const messagingBindingsByThreadKey = await buildMessagingBindingsByThreadKey([
      summary,
    ]);
    const snapshot = await getDesktopOverlayStore().reconcileNavigationSnapshot({
      backend: summary.source,
      fetchedAt: Date.now(),
      messagingBindingsByThreadKey,
      partial: true,
      queuedExecutionModesByThreadKey: {
        [threadKey]: this.registry.getQueuedExecutionModeForThread(request.ref),
      },
      threads: [summary],
      workspaceRoots: resolveScratchProjectsRoots(),
    });
    const projected = snapshot.threads.find(
      (thread) => buildThreadIdentityKey(thread.source, thread.id) === threadKey,
    );
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
    const detailRevision = revision({ thread, workspaceDirectories });
    if (request.knownRevision === detailRevision) {
      return {
        protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
        ref: request.ref,
        revision: detailRevision,
        readiness: "ready",
        identity: "present",
        unchanged: true,
      };
    }
    const response: NavigationSelectedDetailResponse = {
      protocol: NAVIGATION_QUERY_PROTOCOL_VERSION,
      ref: request.ref,
      revision: detailRevision,
      readiness: "ready",
      identity: "present",
      thread,
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

  readQueueProjection(
    request: NavigationQueueProjectionRequest,
  ): NavigationQueueProjection {
    if (request.protocol !== NAVIGATION_QUERY_PROTOCOL_VERSION) {
      throw new NavigationQueryError(
        "navigation_invalid_request",
        `Navigation query protocol ${NAVIGATION_QUERY_PROTOCOL_VERSION} is required.`,
      );
    }
    const entries = this.registry.getQueuedTurnsForThread(request.ref);
    const queuedExecutionMode = this.registry.getQueuedExecutionModeForThread(request.ref)?.mode;
    const queueRevision = revision({ entries, queuedExecutionMode });
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
    if (offset > entries.length) {
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
    for (; nextOffset < entries.length && nextOffset - offset < 100; nextOffset += 1) {
      const candidate = {
        ...response,
        entries: [...response.entries, entries[nextOffset]!],
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
      response.entries.push(entries[nextOffset] as ThreadQueuedTurnSummary);
    }
    response.complete = nextOffset >= entries.length;
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
