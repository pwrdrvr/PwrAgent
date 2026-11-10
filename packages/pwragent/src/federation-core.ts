export * from "@pwragent/federation/federation-transport";
export * from "@pwragent/federation/federation-identity";
export * from "@pwragent/federation/federation-noise";
export * from "@pwragent/federation/federation-enrollment";
export * from "@pwragent/federation/federation-router";
export * from "@pwragent/federation/federation-rpc";
export { FEDERATION_PROTOCOL_VERSION, FEDERATION_INVITE_VERSION } from "@pwragent/shared";

export * from "@pwragent/federation/federation-pty-service";
export * from "@pwragent/federation/terminal-history-store";
export * from "@pwragent/agent-tools/pwragent-messaging-agent-tools";
export * from "@pwragent/agent-tools/pwragent-messaging-codex-tools";

export * from "@pwragent/federation/thread-instance-handoff-service";
export * from "@pwragent/federation/git-instance-handoff";
export * from "@pwragent/federation/federation-file-push";

export { AgentToolRouter } from "@pwragent/agent-tools/agent-tool-router";
export { fitThreadReplayWithinByteBudget, mergeCausalMessagingContext, pageThreadReplay, shortenDerivedThreadTitle } from "@pwragent/shared";
export { authenticateMessageOrigin } from "@pwragent/federation/federation-message-origin";

export { resolveMessagingOutboundFile, validateMessagingFileMetadata } from "@pwragent/agent-tools/messaging-outbound-file";

export * from "@pwragent/federation/federation-replacement-receiver";
export { FEDERATION_BACKEND_METHOD_CAPABILITIES } from "@pwragent/federation/federation-backend-methods";

export { NavigationQueryStore, NavigationQueryError } from "@pwragent/owner-core/navigation-query-store";
export { buildThreadIdentityKey, isAppServerBackendKind, NAVIGATION_QUERY_MAX_RESULT_BYTES } from "@pwragent/shared";

export { CodexAppServerClient } from "@pwragent/owner-core/codex-app-server/client";
export { patchOwnerThreadMetadata } from "@pwragent/owner-core/thread-storage";
export { ThreadNamingLifecycle } from "@pwragent/owner-core/thread-naming-lifecycle";
export { ThreadTitleLifecycle } from "@pwragent/owner-core/thread-title-lifecycle";
export { ThreadTitleGenerationService } from "@pwragent/owner-core/thread-title-generation-service";
export { ThreadTurnStartLifecycle } from "@pwragent/owner-core/thread-turn-start-lifecycle";
export { ThreadCreationLifecycle } from "@pwragent/owner-core/thread-creation-lifecycle";
export { ThreadSteeringLifecycle } from "@pwragent/owner-core/thread-steering-lifecycle";
export { ThreadSteerSubmissionLifecycle } from "@pwragent/owner-core/thread-steer-submission-lifecycle";
export { ThreadInterruptionLifecycle } from "@pwragent/owner-core/thread-interruption-lifecycle";
export { ThreadTurnQueue } from "@pwragent/owner-core/thread-turn-queue";
export { DurableTurnRequestService } from "@pwragent/owner-core/durable-turn-request-service";
export { durableFederationCallerScope, DurableTurnRequestError } from "@pwragent/shared";
export { projectOwnerThreadTitle } from "@pwragent/owner-core/thread-title-projection";
export { projectProviderThreadSummary } from "@pwragent/owner-core/provider-thread-snapshot-storage";
export { projectAcpSessionThread } from "@pwragent/owner-core/acp-thread-projection";
export { retainsOwnerThread } from "@pwragent/owner-core/retained-owner-thread-storage";
import type { AcpSessionStorage } from "@pwragent/owner-core/acp-storage";
import { AcpSessionStore } from "@pwragent/sqlite-storage/acp-session-store";
import { projectClaudeSessionThread, type ClaudeProfileThreadStorage } from "@pwragent/owner-core/claude-profile-storage";
import { projectProviderThreadSummary } from "@pwragent/owner-core/provider-thread-snapshot-storage";
import { ClaudeSessionMetadataStore } from "@pwragent/sqlite-storage/claude-session-metadata-store";

import path from "node:path";
import os from "node:os";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { AppRuntimeInstanceStore } from "@pwragent/sqlite-storage/app-runtime-instance-store";
import {
  getProcessRuntimeIdentity,
  startProfileRuntimeHeartbeat,
  isProfileRuntimeIdentityLive,
} from "@pwragent/sqlite-storage/profile-runtime-markers";
import { RuntimeLeaseManager } from "@pwragent/owner-core/runtime-lease-manager";
import { adoptOutpostOwnerData } from "@pwragent/sqlite-storage/legacy-outpost-owner-data";
import type { OwnerJobStorage } from "@pwragent/owner-core/owner-job-storage";
import type { ImmediateOwnerThreadRegistry } from "@pwragent/owner-core/thread-storage";
import type { ProviderThreadSnapshotStorage } from "@pwragent/owner-core/provider-thread-snapshot-storage";
import { ProviderThreadSnapshotStore } from "@pwragent/sqlite-storage/provider-thread-snapshot-store";
import type { RetainedOwnerThreadStorage } from "@pwragent/owner-core/retained-owner-thread-storage";
import { RetainedOwnerThreadStore } from "@pwragent/sqlite-storage/retained-owner-thread-store";
import { SqliteDurableTurnRequestStore } from "@pwragent/sqlite-storage/durable-turn-request-store";
import type { DurableTurnRequestStorage } from "@pwragent/owner-core/durable-turn-request-storage";
export { outpostThreadMetadata, outpostThreadProjection } from "@pwragent/sqlite-storage/legacy-outpost-owner-data";

type OutpostOwnerStorage = { threads: ImmediateOwnerThreadRegistry; jobs: OwnerJobStorage; inventory: ProviderThreadSnapshotStorage;
  acpSessions: Pick<AcpSessionStorage, "getSession" | "listAllSessions">; claudeSessions: ClaudeProfileThreadStorage;
  retainedOwners: RetainedOwnerThreadStorage; durableTurnRequests: DurableTurnRequestStorage };

/** Outpost's private host binding. Application code receives only storage ports. */
export function openOutpostProfileRuntime(params: {
  stateDirectory: string;
  profileName: string;
  cwd: string;
}): { close(): void; openOwnerStorage(directory: string, identity: { version: 1; workspace: string; codexHome: string }): OutpostOwnerStorage } {
  if (!path.isAbsolute(params.stateDirectory) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(params.profileName)) {
    throw new Error("Outpost requires an absolute profile state directory and a valid profile name");
  }
  const systemBootedAt = Date.now() - os.uptime() * 1_000;
  const db = StateDb.open(path.join(params.stateDirectory, "state.db"), { profileName: params.profileName });
  const identity = getProcessRuntimeIdentity();
  const markerDir = path.join(params.stateDirectory, "runtime-instances");
  let heartbeat: ReturnType<typeof startProfileRuntimeHeartbeat> | undefined;
  const manager = new RuntimeLeaseManager({
    ...identity,
    profileName: params.profileName,
    processId: process.pid,
    cwd: params.cwd,
    store: new AppRuntimeInstanceStore(db),
    systemBootedAt,
    runtimeIdentityIsAlive: owner => isProfileRuntimeIdentityLive(owner.profileName, owner, { markerDir }),
  });
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      try { manager.release("messaging"); } finally { manager.release("federation"); }
    } finally {
      try { manager.markExited(); } finally {
        try { heartbeat?.stop(); } finally { db.close(); }
      }
    }
  };
  try {
    heartbeat = startProfileRuntimeHeartbeat(params.profileName, { ...identity, markerDir });
    for (const kind of ["federation", "messaging"] as const) {
      const result = manager.acquire(kind);
      if (!result.acquired) {
        throw new Error(`Profile ${kind} lease is held by another runtime (${result.holder.instanceId}); stop that owner before starting Outpost`);
      }
    }
    return { close, openOwnerStorage(directory, ownerIdentity) {
      if (closed) throw new Error("Outpost profile storage is closed");
      if (path.resolve(directory) !== path.join(params.stateDirectory, "headless") || ownerIdentity.workspace !== params.cwd) {
        throw new Error("Outpost owner storage must belong to the admitted profile and workspace");
      }
      const storage = adoptOutpostOwnerData(db, directory, ownerIdentity);
      const inventory = new ProviderThreadSnapshotStore(db);
      const retainedOwners = new RetainedOwnerThreadStore(db, directory);
      const acpSessions = new AcpSessionStore(db);
      const durableTurnRequests = new SqliteDurableTurnRequestStore(db);
      const claudeSessions = new ClaudeSessionMetadataStore(path.join(params.stateDirectory, "claude"));
      // Do not expose concrete stores, constructors or the database indirectly.
      return {
        threads: {
          getThreadMetadata: identity => storage.threads.readOwnerThreadMetadata(identity),
          listThreadMetadata: () => storage.threads.readOwnerThreadMetadataList(),
          updateThreadMetadata: (identity, patch) => storage.threads.mergeOwnerThreadMetadata(identity, patch),
          readUnreadBaseline: () => storage.threads.readUnreadBaseline(),
        },
        jobs: {
          get: id => storage.jobs.get(id), list: () => storage.jobs.list(), count: () => storage.jobs.count(),
          save: job => storage.jobs.save(job),
        },
        inventory: { list: () => inventory.list(), replace: (snapshot, retiredThreadIds) => inventory.replace(snapshot, retiredThreadIds) },
        retainedOwners: { list: () => retainedOwners.list(), confirmNativeThreads: ids => retainedOwners.confirmNativeThreads(ids) },
        durableTurnRequests: {
          transaction: work => durableTurnRequests.transaction(work),
          read: (scope, id) => durableTurnRequests.read(scope, id),
          write: (scope, receipt) => durableTurnRequests.write(scope, receipt),
          pruneExpired: now => durableTurnRequests.pruneExpired(now),
          count: scope => durableTurnRequests.count(scope),
          insert: (scope, receipt) => durableTurnRequests.insert(scope, receipt),
          readQueueReceipt: id => durableTurnRequests.readQueueReceipt(id),
          findQueueReceipt: id => durableTurnRequests.findQueueReceipt(id),
        },
        acpSessions: { getSession: (backend, id) => acpSessions.getSession(backend, id), listAllSessions: params => acpSessions.listAllSessions(params) },
        claudeSessions: { listThreads: async () => {
          return (await claudeSessions.list({ requireComplete: true })).filter(session => !session.ephemeral)
            .map(session => projectProviderThreadSummary(projectClaudeSessionThread(session)));
        } },
      };
    } };
  } catch (error) {
    close();
    throw error;
  }
}
