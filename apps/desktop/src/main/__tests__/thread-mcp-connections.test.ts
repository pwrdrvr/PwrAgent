import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { ThreadExecutionMode, ThreadOverlayState } from "@pwragent/shared";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import type { TaskMonitorDelegationRecord } from "../app-server/backend-registry-types";
import { buildCodexConnectionMcpServerName } from "../app-server/codex-thread-config";
import type { ForgeToolBridge } from "../app-server/forge-tool-bridge";
import type { RegistryContext } from "../app-server/registry-context";
import { ThreadMcpConnections, type ThreadMcpConnectionsHost } from "../app-server/thread-mcp-connections";

const EXECUTION_MODES: ThreadExecutionMode[] = ["default", "auto", "full-access"];
const connectionId = fc.constantFrom("pwrsnap", "pwrgit", "sandboxer", "datadog", "linear");
const connectionIds = fc.uniqueArray(connectionId, { maxLength: 5 });

function createConnections(options: {
  host?: Partial<ThreadMcpConnectionsHost>;
  overlays?: Record<string, Partial<ThreadOverlayState>>;
  acp?: Record<string, unknown>;
} = {}) {
  const getThreadOverlayState = vi.fn(async ({ threadId }: { threadId: string }) => options.overlays?.[threadId]);
  const context = {
    stores: { threads: { getThreadOverlayState } },
    providers: { acp: options.acp ?? { getSession: () => undefined, getInstalledAgent: () => undefined } },
    lifecycle: { closed: false },
    emit: async () => {},
  } as unknown as RegistryContext;
  const host = {
    mcpConnectionService: undefined,
    taskMonitorForThread: () => undefined,
    findHeadlessAutomationForThread: () => undefined,
    dynamicToolPermissionDenied: async () => null,
    ...options.host,
  } as unknown as ThreadMcpConnectionsHost;
  const connections = new ThreadMcpConnections(context, { forgeToolBridge: {} as ForgeToolBridge }, () => host);
  return { connections, getThreadOverlayState };
}

const callContext: AgentToolCallContext = { backend: "codex", threadId: "agent", turnId: "turn-1", transport: "codex_dynamic_tool" };

function monitorRecord(overrides: Partial<TaskMonitorDelegationRecord>): TaskMonitorDelegationRecord {
  return {
    parentBackend: "codex", parentThreadId: "parent", parentTurnId: "parent-turn",
    ...overrides,
  } as TaskMonitorDelegationRecord;
}

describe("ThreadMcpConnections", () => {
  it("reads neither its host nor its stores until a tool runs", async () => {
    let bound = false;
    const context = {
      get stores() {
        if (!bound) throw new Error("store read while constructing");
        return { threads: { getThreadOverlayState: async () => ({ mcpConnectionIds: ["pwrgit"] }) } };
      },
    } as unknown as RegistryContext;
    const connections = new ThreadMcpConnections(context, { forgeToolBridge: {} as ForgeToolBridge }, () => {
      if (!bound) throw new Error("host read while constructing");
      return {} as ThreadMcpConnectionsHost;
    });
    bound = true;
    await expect(connections.readThreadMcpConnections({ backend: "codex", threadId: "agent" }))
      .resolves.toMatchObject({ connectionIds: ["pwrgit"] });
  });

  it("gives a task monitor only its delegated connections that its owner still selects or was granted", async () => {
    await fc.assert(fc.asyncProperty(
      connectionIds, connectionIds, connectionIds,
      fc.constantFrom("live", "cancelled", "finalizing", "no-access"),
      async (delegated, selected, granted, state) => {
        const monitor = monitorRecord({
          ...(state === "no-access" ? {} : { mcpAccess: {
            connectionIds: delegated,
            selectionOwner: { backend: "codex", threadId: "owner" },
            automation: { grantedConnectionIds: granted },
          } }),
          ...(state === "cancelled" ? { cancellation: { requestedAt: 1 } } : {}),
          ...(state === "finalizing" ? { finalizationStarted: true } : {}),
        } as Partial<TaskMonitorDelegationRecord>);
        const { connections } = createConnections({
          host: { taskMonitorForThread: () => monitor },
          overlays: { owner: { mcpConnectionIds: selected } },
        });
        const oracle = state === "live"
          ? delegated.filter((id) => selected.includes(id) || granted.includes(id))
          : [];
        expect(await connections.readMcpGatewaySelection(callContext)).toEqual(oracle);
      },
    ));
  });

  it("refuses a task monitor's gateway selection when its delegating actor lacks permission", async () => {
    const dynamicToolPermissionDenied = vi.fn(async () => "thread.mcp.call");
    const { connections, getThreadOverlayState } = createConnections({ host: {
      taskMonitorForThread: () => monitorRecord({}),
      dynamicToolPermissionDenied,
    } });
    await expect(connections.readMcpGatewaySelection(callContext)).rejects.toThrow(/lacks permission for MCP gateway tools \(thread\.mcp\.call\)/);
    expect(dynamicToolPermissionDenied).toHaveBeenCalledWith("codex", "mcp_connections", {
      threadId: "parent", turnId: "parent-turn", tool: "call_mcp_tool",
    });
    expect(getThreadOverlayState).not.toHaveBeenCalled();
  });

  it("gives an automation turn only its allowed connections that its Agent selects or the automation granted", async () => {
    await fc.assert(fc.asyncProperty(
      connectionIds, connectionIds, connectionIds, connectionIds,
      async (allowed, selected, granted, executionThreadSelection) => {
        const { connections } = createConnections({
          host: { findHeadlessAutomationForThread: () => ({
            agentThreadId: "automation-agent", backend: "codex", automationRunId: "run", executionMode: "default",
            executionThreadId: "agent", queueEntryId: "entry", mcpConnectionIds: allowed, mcpGrantedConnectionIds: granted,
          }) },
          overlays: { "automation-agent": { mcpConnectionIds: selected }, agent: { mcpConnectionIds: executionThreadSelection } },
        });
        expect(await connections.readMcpGatewaySelection(callContext))
          .toEqual(allowed.filter((id) => selected.includes(id) || granted.includes(id)));
      },
    ));
  });

  it("gives an ordinary thread its own selection", async () => {
    await fc.assert(fc.asyncProperty(connectionIds, async (selected) => {
      const { connections } = createConnections({ overlays: { agent: { mcpConnectionIds: selected } } });
      expect(await connections.readMcpGatewaySelection(callContext)).toEqual(selected);
    }));
  });

  it("treats only Full Access as Full Access for the MCP gateway, per backend", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("codex", "claude", "acp:fixture", "unknown"),
      fc.option(fc.constantFrom(...EXECUTION_MODES), { nil: undefined }),
      fc.option(fc.constantFrom(...EXECUTION_MODES), { nil: undefined }),
      async (backend, resolvedMode, automationMode) => {
        const resolveCodexToolCallExecutionMode = vi.fn(async () => resolvedMode);
        const resolveClaudeToolCallExecutionMode = vi.fn(async () => resolvedMode);
        const { connections } = createConnections({
          host: { resolveCodexToolCallExecutionMode, resolveClaudeToolCallExecutionMode },
          acp: {
            getSession: () => (resolvedMode ? { executionMode: resolvedMode } : undefined),
            getInstalledAgent: () => undefined,
          },
        });
        const context = { ...callContext, backend } as AgentToolCallContext;
        const fullAccess = await connections.isMcpGatewayFullAccess(context, automationMode);
        expect(fullAccess).toBe(backend !== "unknown" && resolvedMode === "full-access");
        if (backend === "codex") expect(resolveCodexToolCallExecutionMode).toHaveBeenCalledWith(context, automationMode);
        if (backend === "claude") expect(resolveClaudeToolCallExecutionMode).toHaveBeenCalledWith("agent", automationMode);
      },
    ));
  });

  it("names a connection in the Agent as each backend receives it", () => {
    const bridge = { name: "pwragent-pwrgit-bridge", command: "/fixture/bridge", args: ["--connection", "pwrgit"], env: { TOKEN: "fixture" } };
    const peekThreadBridge = vi.fn((id: string) => (id === "pwrgit" ? bridge : undefined));
    const { connections } = createConnections({ host: { mcpConnectionService: { peekThreadBridge } as never } });
    expect(connections.threadMcpServerNameInAgent("pwrgit", { backend: "acp:fixture", threadId: "agent" })).toBe(bridge.name);
    for (const backend of ["codex", "claude"] as const) {
      expect(connections.threadMcpServerNameInAgent("pwrgit", { backend, threadId: "agent" }))
        .toBe(buildCodexConnectionMcpServerName(bridge as never));
    }
    expect(connections.threadMcpServerNameInAgent("linear", { backend: "codex", threadId: "agent" })).toBeUndefined();
    expect(peekThreadBridge).toHaveBeenCalledWith("linear", "agent");
  });
});
