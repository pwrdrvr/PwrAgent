import { isAppServerBackendKind } from "@pwragent/shared";
import type { ForgeReadHandler } from "../agent-tools/pwragent-forge-agent-tools";
import { ForgeReadError, type ForgeReadRequest } from "../pr-status/forge-tool-contract";
import type { RemoteThreadTargetStore } from "../state/remote-thread-target-store";
import { resolveFederatedThreadTarget, type FederatedThreadTargetRuntime } from "./federated-thread-target-service";

export function createOwnerRoutedForgeReadHandler(options: {
  local: ForgeReadHandler;
  runtime: () => FederatedThreadTargetRuntime;
  targetStore?: RemoteThreadTargetStore;
}): ForgeReadHandler {
  return async (operation, args, context) => {
    const backend = args.backend ?? context.backend;
    const threadId = args.threadId ?? context.threadId;
    if (!isAppServerBackendKind(backend)) throw new ForgeReadError("invalid_arguments", "Unknown PwrAgent backend.");
    if (!args.instanceId) {
      try { return await options.local(operation, { ...args, backend, threadId }, context); }
      catch (error) { if (!(error instanceof ForgeReadError) || error.code !== "thread_not_found") throw error; }
    }
    context.signal?.throwIfAborted();
    const match = await resolveFederatedThreadTarget({ runtime: options.runtime(), targetStore: options.targetStore, remember: false, request: { backend, threadId, instanceId: args.instanceId } });
    if (!match) throw new ForgeReadError("not_found", "Thread was not found locally or on a connected Federation owner.");
    if (!match.peer.capabilities.includes("thread_detail")) throw new ForgeReadError("forbidden", "The owning instance does not grant thread_detail for forge reads.");
    context.signal?.throwIfAborted();
    const { instanceId: _instanceId, ...localArgs } = args;
    const request: ForgeReadRequest = { operation, backend, threadId, args: { ...localArgs, backend, threadId } };
    const result = await match.backend.readForge(request, { signal: context.signal, deadlineAt: Date.now() + 60_000 });
    return { ownerInstanceId: match.peer.target.instanceId, result,
      ...(operation === "download_ci_artifact" ? { archiveAvailableLocally: false } : {}),
    };
  };
}
