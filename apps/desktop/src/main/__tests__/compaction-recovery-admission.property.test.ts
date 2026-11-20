import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { AppServerThreadMessageOrigin } from "@pwragent/shared/contracts/normalized-app-server";
import type { SteerTurnRequest } from "@pwragent/shared/contracts/agent";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { CodexAppServerClient } from "@pwragent/owner-core/codex-app-server/client";
import { buildPwrAgentThreadToolDefinitions } from "../agent-tools/pwragent-thread-agent-tools";

const request: SteerTurnRequest = {
  backend: "codex", threadId: "worker", expectedTurnId: "assignment", requestId: "hook:compaction",
  input: [{ type: "text", text: "Read the authorized instruction file; preserve the current assignment." }],
};
const origin: AppServerThreadMessageOrigin = { kind: "pwragent", systemReason: "compaction-recovery", dependencyId: request.requestId };

// Use real registry admission, client preparation, lifecycle admission and
// setup replay. Only provider I/O and owner state are stubs.
function runtime(change: string, boundary: string) {
  let active: string | undefined = "assignment";
  let permitted = true;
  let locked = false;
  let restarting = false;
  let reads = 0;
  const registry = Object.create(DesktopBackendRegistry.prototype) as DesktopBackendRegistry;
  const provider = vi.fn(async (_params) => ({ threadId: "worker", turnId: "assignment" }));
  const mutate = (at: string) => {
    if (at !== boundary) return;
    if (change === "stop") void registry.interruptTurn({ backend: "codex", threadId: "worker", turnId: "assignment" });
    if (change === "archive" || change === "pause" || change === "cancel") permitted = false;
    if (change === "end") active = undefined;
    if (change === "replace") active = "new-assignment";
    if (change === "lock") locked = true;
    if (change === "restart") restarting = true;
  };
  const client = Object.create(CodexAppServerClient.prototype) as CodexAppServerClient;
  let resumes = 0;
  Object.assign(client, {
    options: {}, initialized: true, pendingCloses: 0, closeGeneration: 0, serverGeneration: 0,
    threadUnloadGenerations: new Map(), activeRequests: new Set(), now: () => 0,
    ensureInitialized: async () => { mutate("initialize"); },
    getProtocolCompatibility: () => ({}),
    rawConnection: { request: async (method: string, params: unknown) => {
      if (method === "turn/steer") return await provider(params);
      if (method === "thread/resume") {
        mutate(++resumes === 1 ? "resume" : "resume-replay");
        if (resumes === 1 && boundary === "resume-replay") Object.assign(client, { serverGeneration: 1 });
      }
      return {};
    } },
  });
  Object.assign(registry, {
    compactionRecoveryStops: new Map(), compactionRecoveryAdmissions: new Map(),
    threadInterruption: { interruptTurn: vi.fn(async (target) => target) },
    getActiveTurnForThread: () => active ? { turnId: active } : undefined,
    isRestartGateClosed: () => restarting,
    isThreadLocked: async () => { mutate(++reads === 1 ? "initial-lock" : reads === 2 ? "final-lock" : "rpc-lock"); return locked; },
    registerPendingThreadMessageContext: async () => { mutate("prepare"); return "message"; },
    updatePendingThreadMessageText: () => {
      mutate("input");
      if (boundary === "rpc-barrier") Object.assign(client, { lifecycleBarrier: Promise.resolve().then(() => {
        mutate("rpc-barrier"); Object.assign(client, { lifecycleBarrier: null });
      }) });
    },
    withActiveCodexThreadClient: async (_threadId: string, callback: (client: CodexAppServerClient) => Promise<unknown>) => { mutate("client"); return await callback(client); },
    steerTurn: async (params: SteerTurnRequest, messageOrigin: AppServerThreadMessageOrigin) => {
      const methods = registry as unknown as { prepareCodexSteer(params: SteerTurnRequest, input: SteerTurnRequest["input"], origin: AppServerThreadMessageOrigin): Promise<{ submit(): Promise<{ threadId: string; turnId: string }> }> };
      const prepared = await methods.prepareCodexSteer(params, params.input, messageOrigin);
      return { ...await prepared.submit(), backend: "codex", disposition: "steered" };
    },
  });
  mutate("before");
  return { registry, provider, canSubmit: () => permitted };
}

// Rule: revocation before provider admission cannot steer, start or queue work.
it("stop, cancellation, pause, archive and assignment changes win before provider admission", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("stop", "cancel", "pause", "archive", "end", "replace", "lock", "restart"),
    fc.constantFrom("before", "initial-lock", "prepare", "client", "final-lock", "initialize", "resume", "input", "rpc-barrier", "resume-replay", "rpc-lock"),
    async (change, boundary) => {
      const { registry, provider, canSubmit } = runtime(change, boundary);
      const result = await registry.steerCompactionRecovery(request, origin, canSubmit);
      expect(provider).not.toHaveBeenCalled();
      expect(["busy", "discarded"]).toContain(result.status);
    },
  ));
});

it.each(["pause", "lock"])("a %s during resume cannot pass the actual steer RPC boundary", async (change) => {
  const { registry, provider, canSubmit } = runtime(change, "resume");
  expect(["busy", "discarded"]).toContain((await registry.steerCompactionRecovery(request, origin, canSubmit)).status);
  expect(provider).not.toHaveBeenCalled();
});

it("steers only the compacted turn using the protocol expectedTurnId", async () => {
  const { registry, provider, canSubmit } = runtime("none", "none");
  expect(await registry.steerCompactionRecovery(request, origin, canSubmit)).toEqual({ status: "steered", turnId: "assignment" });
  expect(provider).toHaveBeenCalledExactlyOnceWith({ threadId: "worker", input: [{ ...request.input[0], text_elements: [] }], expectedTurnId: "assignment" });
});

it.each([true, false])("admits the durable dispatch slot exactly at the RPC boundary: %s", async (available) => {
  const { registry, provider, canSubmit } = runtime("none", "none");
  const admit = vi.fn(() => { expect(provider).not.toHaveBeenCalled(); return available; });
  const result = await registry.steerCompactionRecovery(request, origin, canSubmit, admit);
  expect(admit).toHaveBeenCalledTimes(1);
  expect(result.status).toBe(available ? "steered" : "discarded");
  expect(provider).toHaveBeenCalledTimes(available ? 1 : 0);
});

it("keeps compaction discovery and guidance distinct from wait barriers", () => {
  const tool = buildPwrAgentThreadToolDefinitions(undefined).find((candidate) => candidate.name === "manage_thread_dependencies")!;
  expect(JSON.stringify(tool.inputSchema)).toContain("compaction_completed");
  expect(JSON.stringify(tool.inputSchema)).toContain('"repeat"');
  expect(JSON.stringify(tool.inputSchema)).not.toContain("rearm_compaction");
  expect(tool.description).toContain("keep the ongoing authorized task running after registration");
  expect(tool.description).toContain("After creating a wait barrier");
  expect(tool.description).not.toContain("After creation, end this turn");
});
