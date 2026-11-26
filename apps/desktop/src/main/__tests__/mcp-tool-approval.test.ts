import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import type { AcpSessionMetadata } from "@pwragent/owner-core/acp-storage";
import type { AppServerPendingRequestNotification } from "@pwragent/shared/contracts/normalized-app-server";
import {
  buildPendingRequestActions,
  buildPendingRequestResponse,
} from "@pwragent/shared/pending-request-response";
import {
  ACP_THREAD_TOOL_GRANT_OPTION_ID,
  AcpAgentClient,
  type AcpJsonRpcTransport,
} from "../acp/acp-client";
import { pwragentToolSkipsAgentApproval } from "../app-server/acp-host-tool-approval";
import { CLAUDE_MCP_GATEWAY_TOOL, createClaudePermissionHandler } from "../claude/claude-permissions";
import { buildApprovalIntent } from "../messaging/core/messaging-approval-renderer";
import { redactSecretStringValue } from "../util/redact-mcp-tool-args";
import { buildOperatorWaits } from "../../renderer/src/features/operator-requests/operator-waits";
import { buildApprovalNotices } from "../../renderer/src/features/operator-requests/approval-notices";
import { approvalChoices } from "../../renderer/src/features/operator-requests/approval-choices";

class DummyAcpTransport implements AcpJsonRpcTransport {
  private requestHandler?: (
    method: string,
    params: Record<string, unknown>,
    id?: number | string,
  ) => Promise<unknown> | unknown;
  private readonly notificationListeners = new Set<
    (method: string, params: Record<string, unknown>) => void
  >();
  private sessionSeq = 0;

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (method === "initialize") {
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } },
      };
    }
    if (method === "session/new") {
      this.sessionSeq += 1;
      return { sessionId: `proto-${this.sessionSeq}` };
    }
    if (method === "session/load") {
      return { sessionId: params?.sessionId ?? "proto-1" };
    }
    return {};
  }

  onNotification(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onRequest(
    listener: (
      method: string,
      params: Record<string, unknown>,
      id?: number | string,
    ) => Promise<unknown> | unknown,
  ): () => void {
    this.requestHandler = listener;
    return () => {
      if (this.requestHandler === listener) this.requestHandler = undefined;
    };
  }

  async emitRequest(
    method: string,
    params: Record<string, unknown>,
    id: number | string,
  ): Promise<unknown> {
    if (!this.requestHandler) throw new Error("No request handler");
    return await this.requestHandler(method, params, id);
  }
}

function makeMemoryStore() {
  const map = new Map<string, AcpSessionMetadata>();
  return {
    getSession(backendId: string, sessionId: string) {
      return map.get(`${backendId}:${sessionId}`);
    },
    listSessions(backendId?: string) {
      return [...map.values()].filter((s) => !backendId || s.backendId === backendId);
    },
    upsertSession(meta: AcpSessionMetadata) {
      map.set(`${meta.backendId}:${meta.sessionId}`, meta);
    },
  };
}

const OWN_TOOLS = [
  { name: "list_ci_runs", annotations: { readOnlyHint: true } },
  { name: "call_mcp_tool", annotations: { readOnlyHint: false } },
  { name: "update_review_item", annotations: { readOnlyHint: false } },
  { name: "add_todo", annotations: { readOnlyHint: false } },
] as const;

function federationRoundTrip(
  request: AppServerPendingRequestNotification,
): AppServerPendingRequestNotification {
  return JSON.parse(JSON.stringify(request)) as AppServerPendingRequestNotification;
}

describe("MCP tool approval unwrapping and conversation grant scoping", () => {
  it("unwraps Antigravity call_pwragent_tool across all surfaces and scopes conversation grants to the wrapped tool", async () => {
    const store = makeMemoryStore();
    const transport = new DummyAcpTransport();
    let serverNames = ["pwragent", "linear"];
    const asked: AppServerPendingRequestNotification[] = [];
    let pickConversationGrant = true;

    const client = new AcpAgentClient({
      backendId: "acp:antigravity",
      agentDisplayName: "Antigravity",
      store,
      transport,
      mcpServers: () => ({
        servers: serverNames.map((name) => ({
          name,
          type: "http" as const,
          url: `http://127.0.0.1/${name}`,
          headers: [],
        })),
        hostApprovesToolCall: async (serverName, toolName, args) => {
          if (serverName !== "pwragent") return false;
          if (toolName === "call_pwragent_tool") {
            const target = (args as { toolName?: string } | undefined)?.toolName;
            return pwragentToolSkipsAgentApproval(OWN_TOOLS.find((t) => t.name === target));
          }
          return pwragentToolSkipsAgentApproval(OWN_TOOLS.find((t) => t.name === toolName));
        },
      }),
      onRequest: (raw) => {
        const req = federationRoundTrip(raw);
        asked.push(req);
        const actions = buildPendingRequestActions(req);
        const chosen = pickConversationGrant
          ? actions.find((a) => a.decision === "accept_for_session") ?? actions[0]!
          : actions.find((a) => a.decision === "accept") ?? actions[0]!;
        return buildPendingRequestResponse(req, chosen);
      },
    });

    try {
      await client.initialize();
      const session = await client.startSession({ cwd: "/repo", executionMode: "default" });

      // First wrapped call to update_review_item (even if Antigravity offers native allow_always).
      const firstOutcome = await transport.emitRequest("session/request_permission", {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "tc-1",
          kind: "other",
          name: "mcp_pwragent_call_pwragent_tool",
          title: "Run mcp_pwragent_call_pwragent_tool",
          rawInput: {
            toolName: "update_review_item",
            toolSummary: "Settle finding 1 as addressed",
            arguments: {
              id: "review-1",
              itemId: "finding-1",
              status: "addressed",
              apiKey: "sk-SECRET-SHOULD-NOT-LEAK",
            },
          },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "always", name: "Always allow", kind: "allow_always" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }, 1);

      // Must send allow_once (never native allow_always!) to Antigravity.
      expect(firstOutcome).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
      expect(asked).toHaveLength(1);
      const req = asked[0]!;
      expect(req.params.acpMcpToolName).toBe("update_review_item");
      expect(req.params.acpMcpToolDetail).toContain("\"status\": \"addressed\"");
      expect(req.params.acpMcpToolDetail).toContain("\"[redacted]\"");
      expect(JSON.stringify(req)).not.toContain("sk-SECRET-SHOULD-NOT-LEAK");
      expect(req.params.prompt).toContain("update_review_item");
      expect(req.params.prompt).toContain("Settle finding 1 as addressed");
      expect(buildPendingRequestActions(req).map((a) => a.label)).toEqual([
        "Allow",
        "Allow update_review_item for this conversation",
        "Deny",
        "Cancel turn",
      ]);

      // Verify all downstream surfaces (To-dos, Approval Notices, Messaging) unwrap cleanly.
      const [wait] = buildOperatorWaits({
        serverRequests: [{ backend: "acp:antigravity", notification: req, createdAt: 1 }],
        questions: [],
        seenKeys: [],
      });
      expect(wait?.title).toBe("Use update_review_item");
      const choices = wait ? approvalChoices(wait) : undefined;
      expect(choices?.alternatives.some((c) => c.label === "Allow update_review_item for this conversation")).toBe(true);

      const notices = buildApprovalNotices({
        waits: wait ? [wait] : [],
        hiddenKeys: new Set(),
        threadTitleForKey: () => "Research runs over Federation",
        onReview: () => {},
        onHide: () => {},
        onHideAll: () => {},
      });
      expect(notices[0]?.facts).toEqual([{ label: "MCP tool", value: "update_review_item" }]);

      const intent = buildApprovalIntent({ createdAt: 1, id: "msg-1", request: req });
      expect(intent.body).toContain("update_review_item");
      expect(intent.body).not.toContain("mcp_pwragent_call_pwragent_tool");
      expect(intent.body).not.toContain("sk-SECRET-SHOULD-NOT-LEAK");

      // Second wrapped call to update_review_item: auto-approved via PwrAgent's scoped grant.
      const secondOutcome = await transport.emitRequest("session/request_permission", {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "tc-2",
          kind: "other",
          name: "mcp_pwragent_call_pwragent_tool",
          title: "Run mcp_pwragent_call_pwragent_tool",
          rawInput: { toolName: "update_review_item", arguments: { id: "review-1", itemId: "finding-2", status: "addressed" } },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }, 2);
      expect(secondOutcome).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
      expect(asked).toHaveLength(1);

      // Different wrapped tool (add_todo) MUST still ask!
      pickConversationGrant = false;
      await transport.emitRequest("session/request_permission", {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "tc-3",
          kind: "other",
          name: "mcp_pwragent_call_pwragent_tool",
          rawInput: { toolName: "add_todo", arguments: { title: "Follow up" } },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }, 3);
      expect(asked).toHaveLength(2);
      expect(asked[1]!.params.acpMcpToolName).toBe("add_todo");

      // Same tool name on a different server (`mcp_linear_update_review_item`) MUST still ask!
      await transport.emitRequest("session/request_permission", {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "tc-4",
          kind: "other",
          name: "mcp_linear_update_review_item",
          rawInput: { id: "lin-1" },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }, 4);
      expect(asked).toHaveLength(3);
      expect(asked[2]!.params.acpMcpToolName).toBe("linear / update_review_item");

      // Reloading with a colliding server (`pwragent_call`) drops grants and fails closed in display.
      await client.closeSessionForTransfer(session.sessionId);
      serverNames = ["pwragent", "linear", "pwragent_call"];
      await client.loadSession(session);

      await transport.emitRequest("session/request_permission", {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "tc-5",
          kind: "other",
          name: "mcp_pwragent_call_pwragent_tool",
          rawInput: { toolName: "update_review_item", arguments: { id: "review-1" } },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "always", name: "Always allow", kind: "allow_always" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }, 5);
      expect(asked).toHaveLength(4);
      expect(asked[3]!.params.acpMcpToolName).toBe("mcp_pwragent_call_pwragent_tool");
      expect(buildPendingRequestActions(asked[3]!).some((a) => a.decision === "accept_for_session")).toBe(false);
    } finally {
      await client.dispose();
    }
  });

  it("never grants call_mcp_tool or malformed wrappers and fails closed on spoofed conversation grants", async () => {
    const store = makeMemoryStore();
    const transport = new DummyAcpTransport();
    const asked: AppServerPendingRequestNotification[] = [];

    const client = new AcpAgentClient({
      backendId: "acp:antigravity",
      agentDisplayName: "Antigravity",
      store,
      transport,
      mcpServers: () => ({
        servers: [{ name: "pwragent", type: "http", url: "http://127.0.0.1/pwragent", headers: [] }],
        hostApprovesToolCall: async () => {
          throw new Error("simulated host check failure");
        },
      }),
      onRequest: (raw) => {
        const req = federationRoundTrip(raw);
        asked.push(req);
        // Simulate a spoofed conversation-grant response even when none was offered.
        return { decision: ACP_THREAD_TOOL_GRANT_OPTION_ID };
      },
    });

    try {
      await client.initialize();
      const session = await client.startSession({ cwd: "/repo", executionMode: "default" });

      const gatewayOutcome = await transport.emitRequest("session/request_permission", {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "tc-gw",
          kind: "other",
          name: "mcp_pwragent_call_mcp_tool",
          rawInput: {
            connectionId: "linear",
            toolName: "create_issue",
            schemaRevision: "rev-1",
            arguments: { title: "Bug", authorization: "Bearer TOP-SECRET" },
          },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "always", name: "Always allow", kind: "allow_always" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }, 1);

      // Stripped native allow_always, offered no thread grant, failed closed on spoofed grant.
      expect(gatewayOutcome).toEqual({ outcome: { outcome: "cancelled" } });
      expect(asked).toHaveLength(1);
      expect(asked[0]!.params.acpMcpToolName).toBe("linear / create_issue");
      expect(JSON.stringify(asked[0])).not.toContain("TOP-SECRET");
      expect(buildPendingRequestActions(asked[0]!).map((a) => a.label)).toEqual([
        "Allow",
        "Deny",
        "Cancel turn",
      ]);

      // Nested call_pwragent_tool -> call_mcp_tool must also never offer a grant.
      const nestedOutcome = await transport.emitRequest("session/request_permission", {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "tc-nested",
          kind: "other",
          name: "mcp_pwragent_call_pwragent_tool",
          rawInput: { toolName: "call_mcp_tool", arguments: { connectionId: "linear", toolName: "create_issue", arguments: {} } },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "always", name: "Always allow", kind: "allow_always" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }, 2);
      expect(nestedOutcome).toEqual({ outcome: { outcome: "cancelled" } });
      expect(buildPendingRequestActions(asked[1]!).some((a) => a.decision === "accept_for_session")).toBe(false);

      // Title-only `Run mcp_pwragent_call_pwragent_tool` without toolCall.name still unwraps.
      await transport.emitRequest("session/request_permission", {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "tc-title-only",
          kind: "other",
          title: "Run mcp_pwragent_call_pwragent_tool",
          rawInput: { toolName: "update_review_item", arguments: { id: "r1" } },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }, 3);
      expect(asked[2]!.params.acpMcpToolName).toBe("update_review_item");
    } finally {
      await client.dispose();
    }
  });

  it("does not offer a thread grant when a session has no registered MCP servers", async () => {
    const store = makeMemoryStore();
    const transport = new DummyAcpTransport();
    const asked: AppServerPendingRequestNotification[] = [];
    const client = new AcpAgentClient({
      backendId: "acp:antigravity",
      store,
      transport,
      onRequest: (req) => {
        asked.push(req);
        return { decision: "accept" };
      },
    });
    try {
      await client.initialize();
      const session = await client.startSession({ cwd: "/repo", executionMode: "default" });
      await transport.emitRequest("session/request_permission", {
        sessionId: session.sessionId,
        toolCall: { toolCallId: "tc-1", kind: "other", name: "mcp_linear_create_issue" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }, 1);
      expect(buildPendingRequestActions(asked[0]!).map((a) => a.label)).toEqual([
        "Allow",
        "Deny",
        "Cancel turn",
      ]);
    } finally {
      await client.dispose();
    }
  });

  it("unwraps Grok use_tool permissions, strips native allow_always, and scopes conversation grants per target", async () => {
    const store = makeMemoryStore();
    const transport = new DummyAcpTransport();
    const asked: AppServerPendingRequestNotification[] = [];

    const client = new AcpAgentClient({
      backendId: "acp:grok",
      agentDisplayName: "Grok",
      store,
      transport,
      mcpServers: () => ({
        servers: [{ name: "pwragent", type: "http", url: "http://127.0.0.1/pwragent", headers: [] }],
        hostApprovesToolCall: async (serverName, toolName) =>
          serverName === "pwragent" && pwragentToolSkipsAgentApproval(OWN_TOOLS.find((t) => t.name === toolName)),
      }),
      onRequest: (raw) => {
        const req = federationRoundTrip(raw);
        asked.push(req);
        const actions = buildPendingRequestActions(req);
        const conv = actions.find((a) => a.decision === "accept_for_session") ?? actions[0]!;
        return buildPendingRequestResponse(req, conv);
      },
    });

    try {
      await client.initialize();
      const session = await client.startSession({ cwd: "/repo", executionMode: "default" });

      // Read-only PwrAgent tool via Grok use_tool is auto-approved without asking the operator.
      const readOutcome = await transport.emitRequest("session/request_permission", {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "g-1",
          kind: "other",
          title: "use_tool",
          _meta: { "x.ai/tool": { name: "use_tool" } },
          rawInput: { variant: "UseTool", tool_name: "pwragent__list_ci_runs", tool_input: {} },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "always", name: "Always allow", kind: "allow_always" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }, 1);
      expect(readOutcome).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
      expect(asked).toHaveLength(0);

      // Mutating tool via Grok use_tool strips native allow_always and offers scoped conversation grant.
      const mutOutcome = await transport.emitRequest("session/request_permission", {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "g-2",
          kind: "other",
          title: "use_tool",
          _meta: { "x.ai/tool": { name: "use_tool" } },
          rawInput: {
            variant: "UseTool",
            tool_name: "pwragent__update_review_item",
            tool_input: { id: "r1", itemId: "f1", status: "addressed" },
          },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "always", name: "Always allow", kind: "allow_always" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }, 2);
      expect(mutOutcome).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
      expect(asked).toHaveLength(1);
      expect(asked[0]!.params.acpMcpToolName).toBe("update_review_item");
      expect(buildPendingRequestActions(asked[0]!).map((a) => a.label)).toEqual([
        "Allow",
        "Allow update_review_item for this conversation",
        "Deny",
        "Cancel turn",
      ]);

      // Repeating update_review_item auto-approves; calling add_todo still asks.
      await transport.emitRequest("session/request_permission", {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "g-3",
          kind: "other",
          title: "use_tool",
          _meta: { "x.ai/tool": { name: "use_tool" } },
          rawInput: { variant: "UseTool", tool_name: "pwragent__update_review_item", tool_input: { id: "r1", itemId: "f2" } },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }, 3);
      expect(asked).toHaveLength(1);

      await transport.emitRequest("session/request_permission", {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "g-4",
          kind: "other",
          title: "use_tool",
          _meta: { "x.ai/tool": { name: "use_tool" } },
          rawInput: { variant: "UseTool", tool_name: "pwragent__add_todo", tool_input: { title: "Next" } },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }, 4);
      expect(asked).toHaveLength(2);
      expect(asked[1]!.params.acpMcpToolName).toBe("add_todo");
    } finally {
      await client.dispose();
    }
  });

  it("unwraps Claude MCP approvals, redacts secrets, and scopes in-memory conversation grants safely", async () => {
    let planTurn = false;
    let nextDecision: "accept" | "accept_for_session" | "decline" = "accept_for_session";
    const asked: AppServerPendingRequestNotification[] = [];
    const handler = createClaudePermissionHandler({
      threadId: "claude-thread",
      turnId: () => "turn-1",
      planTurn: () => planTurn,
      request: async (raw) => {
        asked.push(federationRoundTrip(raw));
        return { decision: nextDecision };
      },
      cancelRequest: async () => {},
    });

    const sdkPwrAgent: Parameters<CanUseTool>[2] = {
      signal: new AbortController().signal,
      toolUseID: "tu-1",
      requestId: "req-1",
      mcpServer: { name: "pwragent", source: "sdk" },
    };

    // 1. call_mcp_tool unwraps wrapped tool for display, redacts secrets, and NEVER accepts conversation grant.
    const gatewayInput = {
      connectionId: "linear",
      toolName: "create_issue",
      schemaRevision: "rev-1",
      arguments: { title: "Bug", apiKey: "sk-CLAUDE-SECRET" },
    };
    const gwResult = await handler(CLAUDE_MCP_GATEWAY_TOOL, gatewayInput, {
      ...sdkPwrAgent,
      matchedAskRule: { source: "user", toolName: CLAUDE_MCP_GATEWAY_TOOL },
    });
    expect(gwResult).toMatchObject({ behavior: "deny" });
    expect(asked[0]!.params.acpMcpToolName).toBe("linear / create_issue");
    expect(JSON.stringify(asked[0])).not.toContain("sk-CLAUDE-SECRET");
    expect(buildPendingRequestActions(asked[0]!).some((a) => a.decision === "accept_for_session")).toBe(false);

    // 2. Direct PwrAgent tool offers conversation grant, returns original unredacted input, no updatedPermissions.
    const reviewInput = { id: "r1", itemId: "f1", status: "addressed", token: "tok-SECRET" };
    const firstReview = await handler("mcp__pwragent__update_review_item", reviewInput, sdkPwrAgent);
    expect(firstReview).toEqual({ behavior: "allow", updatedInput: reviewInput });
    expect(firstReview).not.toHaveProperty("updatedPermissions");
    expect(asked[1]!.params.acpMcpToolName).toBe("update_review_item");
    expect(JSON.stringify(asked[1])).not.toContain("tok-SECRET");
    expect(buildPendingRequestActions(asked[1]!).map((a) => a.label)).toEqual([
      "Approve once",
      "Allow update_review_item for this conversation",
      "Decline",
      "Cancel turn",
    ]);

    // 3. Second call to the same verified tool is auto-approved in memory.
    const secondReview = await handler("mcp__pwragent__update_review_item", reviewInput, sdkPwrAgent);
    expect(secondReview).toEqual({ behavior: "allow", updatedInput: reviewInput });
    expect(asked).toHaveLength(2);

    // 4. Untrusted namesake server, matchedAskRule, and planTurn MUST NOT inherit the grant.
    nextDecision = "decline";
    await expect(
      handler("mcp__pwragent__update_review_item", reviewInput, {
        ...sdkPwrAgent,
        mcpServer: { name: "pwragent", source: "user" },
      }),
    ).resolves.toMatchObject({ behavior: "deny" });
    expect(asked).toHaveLength(3);
    expect(asked[2]!.params.acpMcpToolName).toBe("mcp__pwragent__update_review_item");

    await expect(
      handler("mcp__pwragent__update_review_item", reviewInput, {
        ...sdkPwrAgent,
        matchedAskRule: { source: "user", toolName: "mcp__pwragent__update_review_item" },
      }),
    ).resolves.toMatchObject({ behavior: "deny" });
    expect(asked).toHaveLength(4);

    planTurn = true;
    await expect(
      handler("mcp__pwragent__update_review_item", reviewInput, sdkPwrAgent),
    ).resolves.toMatchObject({ behavior: "deny" });
    expect(asked).toHaveLength(5);

    // 5. Absent context.mcpServer metadata on mcp__pwragent__* is unverified: raw name, no grant.
    planTurn = false;
    nextDecision = "accept_for_session";
    const { mcpServer: _omitted, ...withoutMcpServer } = sdkPwrAgent;
    const unverifiedResult = await handler("mcp__pwragent__update_review_item", reviewInput, withoutMcpServer);
    expect(unverifiedResult).toMatchObject({ behavior: "deny" });
    expect(asked).toHaveLength(6);
    expect(asked[5]!.params.acpMcpToolName).toBe("mcp__pwragent__update_review_item");
    expect(buildPendingRequestActions(asked[5]!).some((a) => a.decision === "accept_for_session")).toBe(false);
  });

  it("invalidates Claude sessionMcpGrants when mcpKey changes mid-session", async () => {
    let currentMcpKey = "mcp-v1";
    const asked: AppServerPendingRequestNotification[] = [];
    const handler = createClaudePermissionHandler({
      threadId: "claude-reconfig",
      turnId: () => "turn-1",
      mcpKey: () => currentMcpKey,
      request: async (raw) => {
        asked.push(federationRoundTrip(raw));
        return { decision: "accept_for_session" };
      },
      cancelRequest: async () => {},
    });
    const ctx: Parameters<CanUseTool>[2] = {
      signal: new AbortController().signal,
      toolUseID: "tu-crm",
      requestId: "req-crm",
      mcpServer: { name: "crm", source: "user" },
    };

    await expect(handler("mcp__crm__search", { q: "a" }, ctx)).resolves.toMatchObject({ behavior: "allow" });
    expect(asked).toHaveLength(1);

    // Same mcpKey reuses conversation grant.
    await expect(handler("mcp__crm__search", { q: "b" }, ctx)).resolves.toMatchObject({ behavior: "allow" });
    expect(asked).toHaveLength(1);

    // Reconfiguring MCP servers clears prior grants.
    currentMcpKey = "mcp-v2";
    await expect(handler("mcp__crm__search", { q: "c" }, ctx)).resolves.toMatchObject({ behavior: "allow" });
    expect(asked).toHaveLength(2);
  });

  it("blocks Grok bare call_mcp_tool/call_pwragent_tool auto-approval with multiple servers and keeps bare vs namespaced grants distinct", async () => {
    const store = makeMemoryStore();
    const transport = new DummyAcpTransport();
    const asked: AppServerPendingRequestNotification[] = [];
    let servers = ["pwragent", "other"];

    const client = new AcpAgentClient({
      backendId: "acp:grok",
      agentDisplayName: "Grok",
      store,
      transport,
      mcpServers: () => ({
        servers: servers.map((name) => ({ name, type: "http" as const, url: `http://127.0.0.1/${name}`, headers: [] })),
        hostApprovesToolCall: async (serverName, toolName, args) => {
          if (serverName !== "pwragent") return false;
          if (toolName === "call_pwragent_tool") {
            const target = (args as { toolName?: string } | undefined)?.toolName;
            return pwragentToolSkipsAgentApproval(OWN_TOOLS.find((t) => t.name === target));
          }
          return pwragentToolSkipsAgentApproval(OWN_TOOLS.find((t) => t.name === toolName));
        },
      }),
      onRequest: (raw) => {
        const req = federationRoundTrip(raw);
        asked.push(req);
        const actions = buildPendingRequestActions(req);
        const conv = actions.find((a) => a.decision === "accept_for_session")
          ?? actions.find((a) => a.decision === "accept")!;
        return buildPendingRequestResponse(req, conv);
      },
    });

    try {
      await client.initialize();
      const session = await client.startSession({ cwd: "/repo", executionMode: "default" });

      // Multi-server session: bare call_mcp_tool and bare call_pwragent_tool MUST ask, NOT unwrap, and offer NO grant.
      await transport.emitRequest("session/request_permission", {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "gm-1",
          kind: "other",
          title: "use_tool",
          _meta: { "x.ai/tool": { name: "use_tool" } },
          rawInput: {
            variant: "UseTool",
            tool_name: "call_mcp_tool",
            tool_input: { connectionId: "linear", toolName: "delete_all", arguments: {} },
          },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }, 1);
      expect(asked).toHaveLength(1);
      expect(asked[0]!.params.acpMcpToolName).toBe("call_mcp_tool");
      expect(buildPendingRequestActions(asked[0]!).some((a) => a.decision === "accept_for_session")).toBe(false);

      await transport.emitRequest("session/request_permission", {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "gm-2",
          kind: "other",
          title: "use_tool",
          _meta: { "x.ai/tool": { name: "use_tool" } },
          rawInput: {
            variant: "UseTool",
            tool_name: "call_pwragent_tool",
            tool_input: { toolName: "list_ci_runs", arguments: {} },
          },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }, 2);
      expect(asked).toHaveLength(2);
      expect(asked[1]!.params.acpMcpToolName).toBe("call_pwragent_tool");
      expect(buildPendingRequestActions(asked[1]!).some((a) => a.decision === "accept_for_session")).toBe(false);

      // Single-server session: bare vs namespaced call_pwragent_tool keep distinct grant keys.
      await client.closeSessionForTransfer(session.sessionId);
      servers = ["pwragent"];
      await client.loadSession(session);

      await transport.emitRequest("session/request_permission", {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "gm-3",
          kind: "other",
          title: "use_tool",
          _meta: { "x.ai/tool": { name: "use_tool" } },
          rawInput: {
            variant: "UseTool",
            tool_name: "call_pwragent_tool",
            tool_input: { toolName: "update_review_item", arguments: { id: "r1" } },
          },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }, 3);
      expect(asked).toHaveLength(3);
      expect(asked[2]!.params.acpMcpToolName).toBe("update_review_item");

      // Namespaced call_pwragent_tool must not inherit bare grant key.
      await transport.emitRequest("session/request_permission", {
        sessionId: session.sessionId,
        toolCall: {
          toolCallId: "gm-4",
          kind: "other",
          title: "use_tool",
          _meta: { "x.ai/tool": { name: "use_tool" } },
          rawInput: {
            variant: "UseTool",
            tool_name: "pwragent__call_pwragent_tool",
            tool_input: { toolName: "update_review_item", arguments: { id: "r1" } },
          },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }, 4);
      expect(asked).toHaveLength(4);
    } finally {
      await client.dispose();
    }
  });

  it("gates Grok UseTool classification on backendId and kind, rejects non-MCP toolCall.name title spoofing, and blocks Grok grants with zero servers", async () => {
    const store = makeMemoryStore();
    const antigravityTransport = new DummyAcpTransport();
    const antigravityAsked: AppServerPendingRequestNotification[] = [];
    const antigravity = new AcpAgentClient({
      backendId: "acp:antigravity",
      agentDisplayName: "Antigravity",
      store,
      transport: antigravityTransport,
      mcpServers: () => ({
        servers: [{ name: "pwragent", type: "http", url: "http://127.0.0.1/pwragent", headers: [] }],
        hostApprovesToolCall: async (serverName, toolName) =>
          serverName === "pwragent" && pwragentToolSkipsAgentApproval(OWN_TOOLS.find((t) => t.name === toolName)),
      }),
      onRequest: (raw) => {
        antigravityAsked.push(federationRoundTrip(raw));
        return { decision: "accept" };
      },
    });

    const grokTransport = new DummyAcpTransport();
    const grokAsked: AppServerPendingRequestNotification[] = [];
    const grokNoServers = new AcpAgentClient({
      backendId: "acp:grok",
      agentDisplayName: "Grok",
      store,
      transport: grokTransport,
      onRequest: (raw) => {
        grokAsked.push(federationRoundTrip(raw));
        return { decision: "accept" };
      },
    });

    try {
      await antigravity.initialize();
      const agSession = await antigravity.startSession({ cwd: "/repo", executionMode: "default" });

      // Non-Grok backend with UseTool rawInput must NOT be misclassified or auto-approved.
      await antigravityTransport.emitRequest("session/request_permission", {
        sessionId: agSession.sessionId,
        toolCall: {
          toolCallId: "spoof-1",
          kind: "execute",
          title: "run_shell",
          rawInput: { variant: "UseTool", tool_name: "pwragent__list_ci_runs", tool_input: {} },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }, 1);
      expect(antigravityAsked).toHaveLength(1);
      expect(antigravityAsked[0]!.params.acpMcpToolName).toBeUndefined();

      // Explicit non-MCP toolCall.name must NOT fall back to title "Run mcp_pwragent_list_ci_runs".
      await antigravityTransport.emitRequest("session/request_permission", {
        sessionId: agSession.sessionId,
        toolCall: {
          toolCallId: "spoof-2",
          kind: "other",
          name: "custom_runner",
          title: "Run mcp_pwragent_list_ci_runs",
          rawInput: {},
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }, 2);
      expect(antigravityAsked).toHaveLength(2);
      expect(antigravityAsked[1]!.params.acpMcpToolName).toBeUndefined();

      // Dotted double-underscore MCP tool name IS accepted and unwrapped.
      await antigravityTransport.emitRequest("session/request_permission", {
        sessionId: agSession.sessionId,
        toolCall: {
          toolCallId: "dot-1",
          kind: "other",
          name: "mcp__crm__v1.list_items",
          rawInput: { page: 1 },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }, 3);
      expect(antigravityAsked).toHaveLength(3);
      expect(antigravityAsked[2]!.params.acpMcpToolName).toBe("crm / v1.list_items");

      // Grok execute tool with UseTool rawInput must NOT be classified as MCP; zero-server Grok offers NO grant.
      await grokNoServers.initialize();
      const grokSession = await grokNoServers.startSession({ cwd: "/repo", executionMode: "default" });

      await grokTransport.emitRequest("session/request_permission", {
        sessionId: grokSession.sessionId,
        toolCall: {
          toolCallId: "g-exec",
          kind: "execute",
          title: "run_terminal_command",
          rawInput: { variant: "UseTool", tool_name: "pwragent__list_ci_runs", tool_input: {} },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }, 1);
      expect(grokAsked).toHaveLength(1);
      expect(grokAsked[0]!.params.acpMcpToolName).toBeUndefined();

      await grokTransport.emitRequest("session/request_permission", {
        sessionId: grokSession.sessionId,
        toolCall: {
          toolCallId: "g-zero",
          kind: "other",
          title: "use_tool",
          _meta: { "x.ai/tool": { name: "use_tool" } },
          rawInput: { variant: "UseTool", tool_name: "linear__create_issue", tool_input: { title: "Hi" } },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      }, 2);
      expect(grokAsked).toHaveLength(2);
      expect(buildPendingRequestActions(grokAsked[1]!).some((a) => a.decision === "accept_for_session")).toBe(false);
    } finally {
      await antigravity.dispose();
      await grokNoServers.dispose();
    }
  });

  it("redacts Authorization headers and embedded Bearer tokens, and fences triple backticks in messaging approval cards", () => {
    expect(redactSecretStringValue("Authorization: Bearer sk-live-123")).toBe("Authorization: [redacted]");
    expect(redactSecretStringValue("api-key: sk-live-456")).toBe("api-key: [redacted]");
    expect(redactSecretStringValue("Use Bearer sk-live-789 when calling API")).toBe(
      "Use Bearer [redacted] when calling API",
    );
    expect(redactSecretStringValue("{\"header\": \"Authorization: Bearer sk-live-999\"}")).toBe(
      "{\"header\": \"Authorization: [redacted]\"}",
    );

    const intent = buildApprovalIntent({
      createdAt: 1,
      id: "msg-fence",
      request: {
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          requestId: "r1",
          prompt: "Antigravity wants to use update_review_item.",
          acpMcpToolName: "update_review_item",
          acpMcpToolDetail: "{\n  \"note\": \"```ts\\nconst x = 1;\\n```\"\n}",
        },
      },
    });
    expect(intent.body.startsWith("````\nupdate_review_item\n")).toBe(true);
    expect(intent.body).toContain("\n````\n\nAntigravity wants to use update_review_item.");
  });
});
