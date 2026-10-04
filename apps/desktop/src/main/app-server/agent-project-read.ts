import type { FederationRemoteTarget, MarkProjectReadResult, MarkProjectReadToolArgs } from "@pwragent/shared";
import type { FederationBackendOperations } from "../federation/federation-backend-bridge";

type ProjectReadBackend = Pick<FederationBackendOperations, "markNavigationDirectorySeen">;

/** Use the owner's guarded directory action, including its atomic watermark write. */
export async function markAgentProjectRead(
  runtime: {
    localFederationInstanceId(): string;
    localBackend(): ProjectReadBackend;
    remoteBackend(target: FederationRemoteTarget): ProjectReadBackend;
  },
  args: MarkProjectReadToolArgs,
): Promise<MarkProjectReadResult> {
  const localInstanceId = runtime.localFederationInstanceId();
  const instanceId = args.instanceId ?? localInstanceId;
  const isLocal = instanceId === localInstanceId;
  const backend = isLocal
    ? runtime.localBackend()
    : runtime.remoteBackend({ scope: "remote", instanceId });
  if (!backend.markNavigationDirectorySeen) {
    throw new Error("Project mark-read is unavailable on this instance. Upgrade the owning instance.");
  }
  const result = await backend.markNavigationDirectorySeen({ directoryKey: args.projectKey });
  return { projectKey: result.directoryKey, instanceId, isLocal, changedCount: result.changedCount };
}
