import { describe, expect, it, vi } from "vitest";
import type { FederationCapability, FederationProtocolEnvelope } from "@pwragent/shared";
import { createOwnerRoutedForgeReadHandler } from "../federation/federated-forge-read-service";
import { ForgeReadError, type ForgeReadRequest } from "../pr-status/forge-tool-contract";
import { FederationRouter } from "../federation/federation-router";
import { FederationRpcEndpoint } from "../federation/federation-rpc";
import { FederationRemoteBackendClient, registerFederationBackendHandlers, FEDERATION_BACKEND_METHOD_CAPABILITIES, type FederationBackendOperations } from "../federation/federation-backend-bridge";
import type { FederatedThreadTargetRuntime } from "../federation/federated-thread-target-service";

const context = { backend: "codex" as const, threadId: "local", transport: "mcp" as const };
function fixture(capabilities: FederationCapability[] = ["thread_navigation", "thread_detail"]) {
  const readForge = vi.fn(async (_request: ForgeReadRequest, _options?: unknown) => ({ source: "provider", runs: [{ id: 9 }] }));
  const resolveThread = vi.fn(async () => ({ thread: { source: "codex", id: "remote", title: "fixture" } }));
  const backend = { readForge, resolveThread } as unknown as FederationBackendOperations;
  const runtime: FederatedThreadTargetRuntime = {
    connectedPeerTargets: () => [{ target: { scope: "remote", instanceId: "owner" }, label: "Owner", capabilities }],
    remoteBackend: () => backend,
    health: vi.fn() as FederatedThreadTargetRuntime["health"],
  };
  const local = vi.fn(async () => { throw new ForgeReadError("thread_not_found", "not local"); });
  const store = { listRemoteThreadTargets: vi.fn(async () => []), rememberRemoteThreadTarget: vi.fn() };
  return { readForge, resolveThread, local, store, runtime, handler: createOwnerRoutedForgeReadHandler({ local, runtime: () => runtime, targetStore: store }) };
}
describe("forge owner routing", () => {
  it.each(["get_commit_checks", "list_ci_artifacts", "download_ci_artifact"] as const)("routes %s to the owner without local credential access", async (operation) => {
    const h = fixture();
    const args = operation === "get_commit_checks" ? { headSha: "a".repeat(40) } : operation === "download_ci_artifact" ? { runId: 9, artifactId: 12, directory: "/owner/project", destination: ".local/report.zip" } : { runId: 9 };
    const response = await h.handler(operation, { ...args, threadId: "remote", instanceId: "owner" }, context);
    if (operation === "download_ci_artifact") expect(response).toMatchObject({ ownerInstanceId: "owner", archiveAvailableLocally: false });
    expect(h.local).not.toHaveBeenCalled();
    expect(h.readForge).toHaveBeenCalledWith({ operation, backend: "codex", threadId: "remote", args: { ...args, backend: "codex", threadId: "remote" } }, { signal: undefined, deadlineAt: expect.any(Number) });
  });
  it("uses the owner backend with its scope/auth, forwards cancellation and makes no routing writes", async () => {
    const h = fixture();
    const signal = new AbortController().signal;
    expect(await h.handler("list_ci_runs", { threadId: "remote" }, { ...context, signal })).toMatchObject({ ownerInstanceId: "owner", result: { runs: [{ id: 9 }] } });
    expect(h.readForge).toHaveBeenCalledWith({ operation: "list_ci_runs", backend: "codex", threadId: "remote", args: { backend: "codex", threadId: "remote" } }, { signal, deadlineAt: expect.any(Number) });
    expect(h.store.rememberRemoteThreadTarget).not.toHaveBeenCalled();
  });
  it("explicit owner skips the local handler even when thread ids collide", async () => {
    const h = fixture();
    await h.handler("get_forge_status", { threadId: "remote", instanceId: "owner" }, context);
    expect(h.local).not.toHaveBeenCalled();
    expect(h.readForge.mock.calls[0]?.[0]).not.toHaveProperty("args.instanceId");
  });
  it("never falls back to a peer after local permission/provider errors", async () => {
    const h = fixture();
    h.local.mockRejectedValue(new ForgeReadError("forbidden", "outside scope"));
    await expect(h.handler("get_forge_status", {}, context)).rejects.toMatchObject({ code: "forbidden" });
    expect(h.resolveThread).not.toHaveBeenCalled(); expect(h.readForge).not.toHaveBeenCalled();
  });
  it("requires detail permission and does not run a remote request after cancellation", async () => {
    const h = fixture(["thread_navigation"]);
    await expect(h.handler("list_ci_runs", { threadId: "remote", instanceId: "owner" }, context)).rejects.toMatchObject({ code: "forbidden" });
    expect(h.readForge).not.toHaveBeenCalled();
    await expect(h.handler("get_forge_status", { instanceId: "owner" }, { ...context, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(h.readForge).not.toHaveBeenCalled();
  });
});

describe("forge RPC permission boundary", () => {
  it.each([true, false])("enforces thread_detail on the owner (allowed=%s)", async (allowed) => {
    const readForge = vi.fn(async () => ({ observations: [], error: { code: "cache_miss" } }));
    const router = new FederationRouter({ localInstanceId: "owner", methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES });
    const sent: FederationProtocolEnvelope[] = [];
    const rpc = new FederationRpcEndpoint({ localInstanceId: "viewer", remoteInstanceId: "owner", sendEnvelope: (envelope) => { sent.push(envelope); void router.routeEnvelope({ envelope, sourcePeerId: "viewer" }); } });
    router.registerConnection({ peerId: "viewer", capabilities: allowed ? ["thread_detail"] : ["thread_navigation"], sendEnvelope: (envelope) => { rpc.receiveEnvelope(envelope); } });
    registerFederationBackendHandlers({ router, backend: { readForge } as unknown as FederationBackendOperations });
    const request: ForgeReadRequest = { operation: "get_forge_status", backend: "codex", threadId: "remote", args: {} };
    const client = new FederationRemoteBackendClient(rpc);
    if (allowed) {
      await expect(client.readForge(request)).resolves.toMatchObject({ error: { code: "cache_miss" } });
      expect(readForge).toHaveBeenCalledWith(request, { deadlineAt: expect.any(Number) });
      expect(sent[0]).toMatchObject({ method: "backend.readForge", params: request });
      readForge.mockRejectedValueOnce(new ForgeReadError("provider_disabled", "GitLab is disabled in Settings → Git."));
      await expect(client.readForge(request)).rejects.toMatchObject({ code: "provider_disabled", message: expect.stringContaining("Settings") });
    } else {
      await expect(client.readForge(request)).rejects.toThrow(); expect(readForge).not.toHaveBeenCalled();
    }
  });
});
