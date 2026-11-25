import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat } from "node:fs/promises";
import { release } from "node:os";
import { dirname } from "node:path";
import fc from "fast-check";
import { expect, inject, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AgentToolMcpServer, type CodexAgentToolMcpRegistration } from "../agent-tools/agent-tool-mcp-server";
import { AgentToolRouter } from "../agent-tools/agent-tool-router";
import { bindCodexAgentToolRuntime, matchesCodexRelayAncestry } from "../agent-tools/codex-agent-tool-ipc";
import { buildCurrentTurnInputSourceTool } from "../agent-tools/current-turn-input-source-tool";
import { buildCodexAgentToolsMcpConfig } from "../app-server/codex-thread-config";

it("requires the exact pinned process identity within four parent hops", () => {
  // A reused numeric PID and the connector's own PID grant no authority.
  fc.assert(fc.property(
    fc.uniqueArray(fc.integer({ min: 2, max: 20_000 }), { minLength: 6, maxLength: 6 }),
    fc.integer({ min: 0, max: 5 }),
    fc.integer({ min: 1, max: 100 }),
    (pids, hops, generation) => {
      const root = `${pids[hops]}:${generation}`;
      const observed = pids.map((pid) => `${pid}:${generation}`);
      expect(matchesCodexRelayAncestry(root, observed.slice(0, 5))).toBe(hops >= 1 && hops <= 4);
      expect(matchesCodexRelayAncestry(`${pids[hops]}:${generation + 1}`, observed.slice(0, 5))).toBe(false);
      expect(matchesCodexRelayAncestry(root, observed)).toBe(false);
    },
  ));
});

const [kernel, minor] = release().split(".").map(Number);
const supported = process.platform === "darwin"
  || (process.platform === "linux" && (kernel > 6 || (kernel === 6 && minor >= 5)));

it.skipIf(!supported)("uses the native socket and preserves owner dispatch across a fork and runtime replacement", async () => {
  const executable = inject("nativeHelperFixtures").mcpIpc!.relay;
  const toolName = "get_current_turn_input_source";
  const dispatch = vi.fn(() => "desktop" as const);
  let activeThread: string | undefined = "parent";
  const router = new AgentToolRouter([buildCurrentTurnInputSourceTool(dispatch)]);
  const createOwner = () => new AgentToolMcpServer({
    codexRelayExecutable: () => executable,
    verifyCodexThreadId: true,
    resolveCatalogs: () => [{ id: "app_management", router }],
    resolveCallContext: ({ threadId }) => threadId && threadId === activeThread
      ? { threadId, turnId: "active-turn", backend: "codex" }
      : undefined,
  });
  const children: Array<ReturnType<typeof fixtureLauncher>> = [];
  const owner = createOwner();
  const restartedOwner = createOwner();
  const launch = async (registration: CodexAgentToolMcpRegistration) => {
    const runtime = fixtureLauncher();
    children.push(runtime);
    await bindCodexAgentToolRuntime({ config: buildCodexAgentToolsMcpConfig(registration) }, () => ({
      child: runtime.child,
      isCurrent: () => runtime.child.exitCode === null && runtime.child.signalCode === null,
    }));
    await runtime.connect(registration.server);
    return runtime;
  };
  const context = { backend: "codex" } as const;
  try {
    const parent = await owner.registerCodexClient(context);
    const endpoint = parent.server.args[1];
    expect((await lstat(endpoint)).mode & 0o777).toBe(0o600);
    expect((await lstat(dirname(endpoint))).mode & 0o777).toBe(0o700);
    const unowned = fixtureLauncher();
    children.push(unowned);
    // This is a working relay and it has the exact grant. Its parent is
    // outside the selected Codex runtime, so there is no MCP response.
    const parentRuntime = await launch(parent);
    await expect(unowned.connect(parent.server)).rejects.toThrow();
    expect((await parentRuntime.client.listTools()).tools.map(({ name }) => name)).toEqual([toolName]);
    const call = (runtime: typeof parentRuntime, threadId: string) =>
      runtime.client.callTool({ name: toolName, _meta: { threadId } });
    await expect(call(parentRuntime, "parent")).resolves.toMatchObject({ isError: true });
    expect(dispatch).not.toHaveBeenCalled();
    parent.bindThread("parent");
    await expect(call(parentRuntime, "fork")).resolves.toMatchObject({ isError: true });
    await expect(call(parentRuntime, "parent")).resolves.toMatchObject({ structuredContent: { source: "desktop" } });
    expect(dispatch).toHaveBeenCalledTimes(1);
    activeThread = undefined;
    await expect(call(parentRuntime, "parent")).resolves.toMatchObject({ isError: true });
    expect(dispatch).toHaveBeenCalledTimes(1);

    const fork = await owner.registerCodexClient(context);
    fork.bindThread("fork");
    const forkRuntime = await launch(fork);
    activeThread = "fork";
    await expect(call(parentRuntime, "fork")).resolves.toMatchObject({ isError: true });
    await expect(call(forkRuntime, "fork")).resolves.toMatchObject({ structuredContent: { source: "desktop" } });

    // Rebinding a loaded thread to a replacement App Server revokes the old
    // stream even when the old App Server process is still live.
    const oldForkClosed = once(forkRuntime.child, "exit");
    const replacement = await launch(await owner.registerCodexClient({ ...context, threadId: "fork" }));
    await oldForkClosed;
    await expect(call(replacement, "fork")).resolves.toMatchObject({ structuredContent: { source: "desktop" } });
    await owner.close();
    await expect(lstat(dirname(endpoint))).rejects.toMatchObject({ code: "ENOENT" });
    const fresh = await restartedOwner.registerCodexClient({ ...context, threadId: "fork" });
    expect(fresh.server.args[1]).not.toBe(endpoint);
    expect(fresh.server.env).not.toEqual(fork.server.env);
    await expect(call(await launch(fresh), "fork")).resolves.toMatchObject({ structuredContent: { source: "desktop" } });
    expect(dispatch).toHaveBeenCalledTimes(4);
  } finally {
    await Promise.all([owner.close(), restartedOwner.close()]);
    for (const { child } of children) child.kill();
  }
}, 20_000);

function fixtureLauncher() {
  // Keep a real intermediate launcher in the tree, waiting for the owner to
  // pin its incarnation before the relay gets its stdio and registration.
  const child = spawn(process.execPath, ["-e", `
    process.once("message", ({ command, args, env }) => {
      const { spawn } = require("node:child_process");
      const relay = spawn(command, args, { env, stdio: "inherit" });
      relay.once("close", () => process.exit());
      relay.once("error", () => process.exit(1));
    });
  `], { stdio: ["pipe", "pipe", "ignore", "ipc"] });
  const client = new Client({ name: "fixture", version: "1" });
  return {
    child,
    client,
    async connect(config: CodexAgentToolMcpRegistration["server"]) {
      // The SDK's stdio framing is symmetric. Its server transport accepts
      // inherited streams and lets the fixture launch the relay itself.
      const transport = new StdioServerTransport(child.stdout!, child.stdin!);
      child.once("exit", () => { void transport.close(); });
      child.send(config);
      await client.connect(transport, { timeout: 3000 });
    },
  };
}
