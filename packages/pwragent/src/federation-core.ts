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

export { NavigationQueryStore } from "@pwragent/owner-core/navigation-query-store";
export { buildThreadIdentityKey, NAVIGATION_QUERY_MAX_RESULT_BYTES } from "@pwragent/shared";

export { CodexAppServerClient } from "@pwragent/owner-core/codex-app-server/client";
export { patchOwnerThreadMetadata } from "@pwragent/owner-core/thread-storage";

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
export { outpostThreadMetadata, outpostThreadProjection } from "@pwragent/sqlite-storage/legacy-outpost-owner-data";

type OutpostOwnerStorage = { threads: ImmediateOwnerThreadRegistry; jobs: OwnerJobStorage; inventory: ProviderThreadSnapshotStorage };

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
      // Do not expose concrete stores, constructors or the database indirectly.
      return {
        threads: {
          getThreadMetadata: identity => storage.threads.readOwnerThreadMetadata(identity),
          listThreadMetadata: () => storage.threads.readOwnerThreadMetadataList(),
          updateThreadMetadata: (identity, patch) => storage.threads.mergeOwnerThreadMetadata(identity, patch),
        },
        jobs: {
          get: id => storage.jobs.get(id), list: () => storage.jobs.list(), count: () => storage.jobs.count(),
          save: job => storage.jobs.save(job),
        },
        inventory: { list: () => inventory.list(), replace: snapshot => inventory.replace(snapshot) },
      };
    } };
  } catch (error) {
    close();
    throw error;
  }
}
