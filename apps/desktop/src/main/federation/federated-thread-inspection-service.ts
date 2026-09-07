import { randomUUID } from "node:crypto";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { getDesktopNavigationQueryPool } from "../app-server/navigation-query-pool";
import {
  PwrAgentFederatedThreadInspectionError,
  type PwrAgentFederatedThreadInspectionHandler,
} from "../agent-tools/pwragent-thread-agent-tools";
import type { RemoteThreadTargetStore } from "../state/remote-thread-target-store";
import {
  FederatedThreadTargetError,
  resolveFederatedThreadTarget,
  type ResolvedFederatedThreadTarget,
} from "./federated-thread-target-service";
import {
  getDesktopFederationRuntime,
  type DesktopFederationRuntime,
} from "./federation-runtime";

export function createFederatedThreadInspectionHandler(
  options: {
    runtime?: () => DesktopFederationRuntime;
    targetStore?: RemoteThreadTargetStore;
  } = {},
): PwrAgentFederatedThreadInspectionHandler {
  const runtime = options.runtime ?? getDesktopFederationRuntime;
  return async (request) => {
    const activeRuntime = runtime();
    let match: ResolvedFederatedThreadTarget | undefined;
    try {
      match = await resolveFederatedThreadTarget({
        runtime: activeRuntime,
        targetStore: options.targetStore,
        request,
      });
    } catch (error) {
      if (error instanceof FederatedThreadTargetError) {
        throw new PwrAgentFederatedThreadInspectionError(
          error.code,
          error.message,
        );
      }
      throw error;
    }
    if (!match) {
      return undefined;
    }
    if (!match.peer.capabilities.includes("thread_detail")) {
      throw new Error(
        `Federation instance ${match.peer.label} owns thread ${request.threadId} but does not grant thread_detail.`,
      );
    }
    const ref = { backend: request.backend, threadId: request.threadId, ownerInstanceId: match.peer.target.instanceId };
    const pool = getDesktopNavigationQueryPool();
    const consumerId = `inspect-thread:${randomUUID()}`;
    let summary: NavigationThreadSummary | undefined;
    try {
      const detail = await pool.readExact({ kind: "detail", consumerId, owner: match.peer.target, ref,
        identity: JSON.stringify([ref.backend, ref.threadId]), operation: JSON.stringify([null, false, false]),
        load: async (rpcOptions) => activeRuntime.remoteNavigationSelectedDetail(match.peer.target,
          { protocol: 2, ref, federationTarget: match.peer.target }, rpcOptions),
      });
      if (detail.protocol !== 2 || detail.ref.backend !== ref.backend || detail.ref.threadId !== ref.threadId
        || detail.ref.ownerInstanceId !== ref.ownerInstanceId
        || (detail.thread && (detail.thread.source !== ref.backend || detail.thread.id !== ref.threadId
          || (detail.thread.federation?.ref.target.scope === "remote" && detail.thread.federation.ref.target.instanceId !== ref.ownerInstanceId)))) {
        throw new Error("Selected detail does not match the requested thread owner.");
      }
      summary = detail.readiness === "ready" && (detail.identity === "present" || detail.identity === "archived") ? detail.thread : undefined;
    } finally {
      pool.release(consumerId);
    }
    const read = await match.backend.readThread({
      backend: request.backend,
      threadId: request.threadId,
      includeTurns: request.includeTurns,
      ...(request.before ? { before: request.before } : {}),
      limit: request.limit,
      viewOnly: true,
    });
    return {
      instanceId: match.peer.target.instanceId,
      instanceLabel: match.peer.label,
      thread: match.thread,
      ...(summary ? { summary } : {}),
      read,
    };
  };
}
