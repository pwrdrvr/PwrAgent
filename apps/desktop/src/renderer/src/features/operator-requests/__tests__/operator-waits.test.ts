import { describe, expect, it } from "vitest";
import type { AppServerPendingRequestNotification, OperatorServerRequest } from "@pwragent/shared";
import {
  OPERATOR_WAIT_LABELS,
  buildOperatorWaits,
  isBlockingWait,
  leadingOperatorWait,
} from "../operator-waits";

function serverRequest(
  method: string,
  params: Record<string, unknown>,
  createdAt = 1_000,
): OperatorServerRequest {
  return {
    backend: "codex",
    createdAt,
    notification: {
      method,
      params: { threadId: "thread-a", turnId: "turn-1", requestId: `req-${createdAt}`, ...params },
    } as unknown as AppServerPendingRequestNotification,
  };
}

function mcpRequest(params: Record<string, unknown>, createdAt?: number): OperatorServerRequest {
  return serverRequest("mcpServer/elicitation/request", {
    serverName: "playwright",
    mode: "form",
    _meta: null,
    message: "Allow the playwright MCP server to run tool \"browser_tabs\"?",
    requestedSchema: { type: "object", properties: {} },
    ...params,
  }, createdAt);
}

function waitsFor(serverRequests: OperatorServerRequest[]) {
  return buildOperatorWaits({ serverRequests, questions: [], seenKeys: [] });
}

describe("buildOperatorWaits", () => {
  it("titles a command approval by its command", () => {
    const [wait] = waitsFor([serverRequest("item/commandExecution/requestApproval", {
      command: "/bin/zsh -lc 'pnpm test'",
    })]);
    expect(wait).toMatchObject({
      kind: "approval",
      key: "request:codex:thread-a:req-1000",
      threadKey: "codex:thread-a",
      title: "Run pnpm test",
      detail: "command",
    });
  });

  it("titles a file-change approval", () => {
    const [wait] = waitsFor([serverRequest("item/fileChange/requestApproval", {})]);
    expect(wait).toMatchObject({ kind: "approval", title: "Apply file changes" });
  });

  it("tells an MCP approval from an MCP form and a sign-in link", () => {
    const waits = waitsFor([
      mcpRequest({}, 1),
      mcpRequest({
        message: "Pick a branch",
        requestedSchema: { type: "object", properties: { branch: { type: "string" } } },
      }, 2),
      mcpRequest({
        mode: "url",
        message: "Authorize GitHub access.",
        requestedSchema: undefined,
        url: "https://example.test/oauth/start",
        elicitationId: "login",
      }, 3),
    ]);
    expect(waits.map((wait) => [wait.kind, wait.title, wait.detail])).toEqual([
      ["mcp-approval", "Allow the playwright MCP server to run tool \"browser_tabs\"?", "playwright"],
      ["mcp-input", "Authorize GitHub access.", "opens example.test"],
      ["mcp-input", "Pick a branch", "playwright · 1 field"],
    ]);
  });

  it("names a questionnaire by its first question", () => {
    const [wait] = waitsFor([serverRequest("item/tool/requestUserInput", {
      questions: [
        { id: "q1", header: "Scope", question: "Which packages?" },
        { id: "q2", header: "Tests", question: "Run them?" },
      ],
    })]);
    expect(wait).toMatchObject({ kind: "questionnaire", title: "Which packages?", detail: "2 questions" });
  });

  it("orders paused turns first and leaves a question last", () => {
    const waits = buildOperatorWaits({
      serverRequests: [
        serverRequest("item/tool/requestUserInput", { questions: [{ question: "Why?" }] }, 5),
        serverRequest("item/commandExecution/requestApproval", { command: "ls" }, 1),
      ],
      questions: [{
        backend: "codex",
        threadId: "thread-a",
        messageId: "msg-1",
        questions: [{ title: "Ship it?", options: null }],
        createdAt: 9,
      }],
      seenKeys: [],
    });
    expect(waits.map((wait) => wait.kind)).toEqual(["approval", "questionnaire", "question"]);
    expect(waits.map(isBlockingWait)).toEqual([true, true, false]);
    expect(leadingOperatorWait([...waits].reverse())?.kind).toBe("approval");
    expect(OPERATOR_WAIT_LABELS[waits[2]!.kind]).toBe("Question");
    expect(waits[2]!.key).toBe("question:codex:thread-a:msg-1");
  });

  it("skips a request without a thread or request id", () => {
    expect(waitsFor([{
      backend: "codex",
      createdAt: 1,
      notification: {
        method: "item/commandExecution/requestApproval",
        params: { command: "ls" },
      } as unknown as AppServerPendingRequestNotification,
    }])).toEqual([]);
  });
});
