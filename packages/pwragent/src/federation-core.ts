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

/** Outpost's private host binding. Application code receives only shutdown. */
export function openOutpostProfileRuntime(params: {
  stateDirectory: string;
  profileName: string;
  cwd: string;
}): { close(): void } {
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
    return { close };
  } catch (error) {
    close();
    throw error;
  }
}
