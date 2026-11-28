import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FACTORY_BUILDER_ISOLATION } from "@pwragent/shared/contracts/durable-turn-requests";
import { expect, it, vi } from "vitest";
import type { AgentToolMcpServerLike } from "../agent-tools/agent-tool-mcp-server";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import type { BackendClient } from "../app-server/backend-registry-types";
import { getOwnerHostServices, installOwnerHostServices } from "../owner-host";
import { createOutpostRuntimePolicy } from "../owner-runtime-policy";
import { readCurrentGitHubOrigin } from "../pr-status/git-remote";
import { createOverlayStoreMock, emitCompletedTurn, MockBackendClient } from "./helpers/backend-registry-fixture";

const { hasAutomation } = vi.hoisted(() => ({ hasAutomation: vi.fn(() => false) }));
vi.mock("../storage/desktop-automation-storage", () => ({ getAutomationStorage: () => ({ hasNonDeletedThreadAutomation: hasAutomation }) }));
vi.mock(import("../pr-status/git-remote"), async (load) => ({ ...await load(), readCurrentGitHubOrigin: vi.fn() }));

it("enforces Factory scope at owner ingress and gives a subsequent manual turn its own authority", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pwragent-factory-worker-"));
  const cwd = path.join(root, "worktree");
  await mkdir(cwd);
  const worker = { backend: "codex" as const, threadId: "builder" };
  const other = { backend: "codex" as const, threadId: "manual" };
  const owner = getOwnerHostServices();
  const preparedRoot = await realpath(root);
  const policy = { ...createOutpostRuntimePolicy({ PWRAGENT_OUTPOST_FEDERATION_ROLE: "full" }), factoryBuilderWorkspaceRoot: preparedRoot };
  installOwnerHostServices({ ...owner, runtimePolicy: policy });
  const input = [{ type: "text" as const, text: "Implement the approved change." }];
  const overlay = { ...worker, mcpProviderServersEnabled: false, extraLinkedDirectories: [] };
  const overlays = createOverlayStoreMock({ overlays: { "codex:builder": overlay } });
  vi.mocked(readCurrentGitHubOrigin).mockResolvedValue({ host: "github.com", owner: "pwrdrvr", repo: "fixture" });
  const codexClient = new MockBackendClient({ threads: [worker, other].map(({ threadId }) => ({
    id: threadId, source: "codex", title: "Fixture", titleSource: "explicit", threadStatus: "idle",
    linkedDirectories: [{ id: cwd, kind: "worktree", label: "Fixture", path: root, worktreePath: cwd }],
  })) });
  const call = (threadId: string, turnId: string, tool: string) => codexClient.emitRequest({
    method: "item/tool/call", params: { threadId, turnId, requestId: tool, callId: tool,
      namespace: "pwragent", tool, arguments: {} },
  });
  let approvedTurns = 0;
  const restrict = vi.fn<NonNullable<BackendClient["startFactoryBuilderTurn"]>>(async (request) => {
    expect(request.cwd).toBe(cwd);
    expect(await request.onBeforeStart()).toBe(true);
    const turnId = `factory-${++approvedTurns}`;
    expect(await call(worker.threadId, turnId, "handoff_task")).toMatchObject({ success: false });
    await writeFile(path.join(request.cwd, "implementation.txt"), "implementation fixture\n");
    return { threadId: worker.threadId, turnId };
  });
  Object.assign(codexClient, { startFactoryBuilderTurn: restrict });
  const registry = createDesktopBackendRegistry({ codexClient, overlayStore: overlays, threadTitleGenerationService: null });
  const mcp = new Client({ name: "factory-worker-fixture", version: "1.0.0" });
  try {
    await registry.resolveThread(worker);
    await registry.resolveThread(other);
    const request = {
      ...worker, input, queueEntryId: "durable-factory-1", delivery: "new_turn" as const,
      executionMode: "auto" as const, approvalPolicy: "never", sandbox: "workspace-write",
      boundedStart: { before: Date.now() + 60_000, worktreePath: cwd, repository: "pwrdrvr/fixture" },
    };
    const isolation = { factoryBuilderIsolation: FACTORY_BUILDER_ISOLATION };
    await expect(registry.submitTurn(request)).rejects.toThrow("request_start_refused");
    policy.agentNetwork = true;
    await expect(registry.submitTurn({ ...request, ...isolation })).rejects.toThrow("request_start_refused");
    policy.agentNetwork = false;
    policy.factoryBuilderWorkspaceRoot = path.join(preparedRoot, "other-workspace");
    await expect(registry.submitTurn({ ...request, ...isolation })).rejects.toThrow("request_start_refused");
    policy.factoryBuilderWorkspaceRoot = preparedRoot;
    hasAutomation.mockReturnValueOnce(true);
    await expect(registry.submitTurn({ ...request, ...isolation })).rejects.toThrow("request_start_refused");
    Object.assign(overlay, { prAutoDispatchEnabled: true });
    await expect(registry.submitTurn({ ...request, ...isolation })).rejects.toThrow("request_start_refused");
    Object.assign(overlay, { prAutoDispatchEnabled: false });
    Object.assign(overlay, { mcpConnectionIds: ["github"] });
    await expect(registry.submitTurn({ ...request, ...isolation })).rejects.toThrow("request_start_refused");
    Object.assign(overlay, { mcpConnectionIds: [] });
    expect(restrict).not.toHaveBeenCalled();

    for (const bounds of [
      { ...request.boundedStart, before: Date.now() - 1 },
      { ...request.boundedStart, worktreePath: root },
      { ...request.boundedStart, repository: "other/fixture" },
    ]) {
      await expect(registry.submitTurn({ ...request, ...isolation, boundedStart: bounds })).rejects.toThrow("request_start_refused");
    }
    expect(restrict).not.toHaveBeenCalled();
    restrict.mockImplementationOnce(async (packet) => {
      vi.mocked(readCurrentGitHubOrigin).mockResolvedValueOnce({ host: "github.com", owner: "other", repo: "fixture" });
      expect(await packet.onBeforeStart()).toBe(false);
      throw new Error("request_start_refused");
    });
    await expect(registry.submitTurn({ ...request, ...isolation })).rejects.toThrow("request_start_refused");

    const start = await registry.submitTurn({ ...request, ...isolation });
    expect(start).toMatchObject({ status: "started", turnId: "factory-1" });
    expect(await readFile(path.join(cwd, "implementation.txt"), "utf8")).toBe("implementation fixture\n");
    await registry.publishLocalEvent({ backend: "codex", notification: { method: "turn/started",
      params: { threadId: worker.threadId, turnId: "factory-1", turn: { id: "factory-1" } } } });
    await expect(registry.submitTurn({ ...request, ...isolation, queueEntryId: "another-outcome" })).rejects.toThrow("request_start_refused");
    expect(Object.values(registry.getQueuedTurnsSnapshot()).flat()).toHaveLength(0);
    for (const tool of ["manage_pwragent", "merge_pull_request", "search_mcp_tools", "call_mcp_tool"]) {
      expect(await call(worker.threadId, "factory-1", tool)).toMatchObject({ success: false,
        contentItems: [expect.objectContaining({ text: expect.stringContaining("Factory builders") })] });
    }
    expect(await call(worker.threadId, "stale-turn", "call_mcp_tool")).toMatchObject({ success: false,
      contentItems: [expect.objectContaining({ text: expect.stringContaining("Factory builders") })] });
    const { agentToolMcpServer: server } = registry as unknown as { agentToolMcpServer: AgentToolMcpServerLike };
    const registration = await server.registerClient(worker);
    await mcp.connect(new StreamableHTTPClientTransport(new URL(registration.server.url), {
      requestInit: { headers: Object.fromEntries(registration.server.headers.map(({ name, value }) => [name, value])) },
    }));
    expect(await mcp.callTool({ name: "get_current_turn_input_source", arguments: {} })).toMatchObject({ isError: true });
    const unrelated = await registry.startTurn({ ...other, input });
    await registry.publishLocalEvent({ backend: "codex", notification: { method: "turn/started",
      params: { threadId: other.threadId, turnId: unrelated.turnId, turn: { id: unrelated.turnId } } } });
    expect(await call(other.threadId, unrelated.turnId, "get_current_turn_input_source")).toMatchObject({ success: true });

    await emitCompletedTurn(registry, "codex", worker.threadId, "factory-1");
    const second = await registry.submitTurn({ ...request, ...isolation, queueEntryId: "durable-factory-2" });
    expect(second).toMatchObject({ status: "started", turnId: "factory-2" });
    await emitCompletedTurn(registry, "codex", worker.threadId, "factory-2");
    const next = await registry.submitTurn({ ...worker, input });
    expect(next).toMatchObject({ status: "started", turnId: "turn-1" });
    await registry.publishLocalEvent({ backend: "codex", notification: { method: "turn/started",
      params: { threadId: worker.threadId, turnId: "turn-1", turn: { id: "turn-1" } } } });
    expect(await call(worker.threadId, "turn-1", "get_current_turn_input_source")).toMatchObject({ success: true });
    expect(restrict).toHaveBeenCalledTimes(3);
  } finally {
    await mcp.close();
    await registry.close();
    installOwnerHostServices(owner);
    await rm(root, { recursive: true, force: true });
  }
});
