import { describe, expect, it, vi } from "vitest";
import type { JsonRpcObserverEvent } from "../codex-app-server/json-rpc";
import {
  createCompositeJsonRpcObserver,
  createProtocolLogObserver,
} from "../app-server/protocol-log-observer";

function createEvent(
  envelope: JsonRpcObserverEvent["envelope"],
  direction: JsonRpcObserverEvent["direction"] = "inbound",
  diagnostics?: JsonRpcObserverEvent["diagnostics"],
): JsonRpcObserverEvent {
  return {
    direction,
    envelope,
    diagnostics,
    raw: JSON.stringify(envelope),
  };
}

describe("protocol log observer", () => {
  it("logs protocol message summaries without dumping raw payloads", () => {
    const info = vi.fn();
    const observer = createProtocolLogObserver({
      backend: "codex",
      logger: { info },
    });

    observer.onMessage(
      createEvent({
        jsonrpc: "2.0",
        method: "turn/started",
        params: {
          turnId: "turn-1",
          threadId: "thread-1",
        },
      }),
    );

    expect(info).toHaveBeenCalledWith("message", {
      backend: "codex",
      direction: "in",
      kind: "notification",
      method: "turn/started",
      paramKeys: ["turnId", "threadId"],
      turnId: "turn-1",
      threadId: "thread-1",
    });
  });

  it("includes caller diagnostics on requests and attributed responses", () => {
    const info = vi.fn();
    const observer = createProtocolLogObserver({
      backend: "grok",
      logger: { info },
    });

    observer.onMessage(
      createEvent(
        {
          id: "rpc-1",
          jsonrpc: "2.0",
          method: "model/list",
          params: {},
        },
        "outbound",
        {
          callerReason: "backend-summary",
          ownerId: "model-catalog-1",
        },
      ),
    );
    observer.onMessage(
      createEvent({
        id: "rpc-1",
        jsonrpc: "2.0",
        result: { data: [] },
      }),
    );

    expect(info).toHaveBeenNthCalledWith(1, "message", {
      backend: "grok",
      callerReason: "backend-summary",
      direction: "out",
      id: "rpc-1",
      kind: "request",
      method: "model/list",
      ownerId: "model-catalog-1",
    });
    expect(info).toHaveBeenNthCalledWith(2, "message", {
      backend: "grok",
      callerReason: "backend-summary",
      direction: "in",
      id: "rpc-1",
      kind: "response",
      method: "model/list",
      ownerId: "model-catalog-1",
    });
  });

  it("omits absent ids and attributes responses to their request method", () => {
    const info = vi.fn();
    const observer = createProtocolLogObserver({
      backend: "codex",
      logger: { info },
    });

    observer.onMessage(
      createEvent(
        {
          id: "rpc-1",
          jsonrpc: "2.0",
          method: "thread/list",
          params: {
            archived: false,
            limit: 100,
            sortKey: "recent",
          },
        },
        "outbound",
      ),
    );
    observer.onMessage(
      createEvent({
        id: "rpc-1",
        jsonrpc: "2.0",
        result: { threads: [] },
      }),
    );

    expect(info).toHaveBeenNthCalledWith(1, "message", {
      backend: "codex",
      direction: "out",
      id: "rpc-1",
      kind: "request",
      method: "thread/list",
      paramKeys: ["archived", "limit", "sortKey"],
    });
    expect(info).toHaveBeenNthCalledWith(2, "message", {
      backend: "codex",
      direction: "in",
      id: "rpc-1",
      kind: "response",
      method: "thread/list",
    });
  });

  it("logs ACP session update summaries with session and update kind", () => {
    const info = vi.fn();
    const observer = createProtocolLogObserver({
      backend: "acp:gemini",
      logger: { info },
    });

    observer.onMessage(
      createEvent({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call_update",
            tool_call_id: "tool-1",
            status: "in_progress",
          },
        },
      }),
    );

    expect(info).toHaveBeenCalledWith("message", {
      backend: "acp:gemini",
      direction: "in",
      kind: "notification",
      method: "session/update",
      paramKeys: ["sessionId", "update"],
      sessionId: "session-1",
      status: "in_progress",
      toolCallId: "tool-1",
      updateKind: "tool_call_update",
    });
  });

  it("coalesces repeated ACP tool call update summaries", () => {
    let now = 1_000;
    const info = vi.fn();
    const observer = createProtocolLogObserver({
      backend: "acp:kimi",
      coalescedMessageLogIntervalMs: 500,
      logger: { info },
      now: () => now,
    });

    for (const title of ["Shell: p", "Shell: pn", "Shell: pnpm"]) {
      observer.onMessage(
        createEvent({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: {
              sessionUpdate: "tool_call_update",
              status: "in_progress",
              title,
              toolCallId: "tool-1",
            },
          },
        }),
      );
      now += 100;
    }

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenLastCalledWith(
      "message",
      expect.objectContaining({
        backend: "acp:kimi",
        status: "in_progress",
        title: "Shell: p",
        toolCallId: "tool-1",
        updateKind: "tool_call_update",
      }),
    );

    now = 1_600;
    observer.onMessage(
      createEvent({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call_update",
            status: "in_progress",
            title: "Shell: pnpm build",
            toolCallId: "tool-1",
          },
        },
      }),
    );

    expect(info).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenLastCalledWith(
      "message coalesced",
      expect.objectContaining({
        backend: "acp:kimi",
        coalescedDurationMs: 600,
        status: "in_progress",
        suppressedCount: 3,
        title: "Shell: pnpm build",
        toolCallId: "tool-1",
        updateKind: "tool_call_update",
      }),
    );

    observer.onMessage(
      createEvent({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call_update",
            status: "completed",
            title: "Shell: pnpm build",
            toolCallId: "tool-1",
          },
        },
      }),
    );

    expect(info).toHaveBeenCalledTimes(3);
    expect(info).toHaveBeenLastCalledWith(
      "message",
      expect.objectContaining({
        status: "completed",
        toolCallId: "tool-1",
      }),
    );
  });

  it("coalesces ACP streaming session update chunks", () => {
    let now = 1_000;
    const info = vi.fn();
    const observer = createProtocolLogObserver({
      backend: "acp:kimi",
      logger: { info },
      now: () => now,
      streamLogIntervalMs: 500,
    });

    for (const text of ["a", " ", "c"]) {
      observer.onMessage(
        createEvent({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: {
              session_update: "agent_thought_chunk",
              content: {
                type: "text",
                text,
              },
            },
          },
        }),
      );
      now += 100;
    }

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenLastCalledWith(
      "stream delta",
      expect.objectContaining({
        backend: "acp:kimi",
        chars: 1,
        count: 1,
        reason: "interval",
        streamKey: expect.stringContaining("session:session-1"),
        text: "a",
      }),
    );
  });

  it("logs response error codes and messages", () => {
    const info = vi.fn();
    const observer = createProtocolLogObserver({
      backend: "acp:gemini",
      logger: { info },
    });

    observer.onMessage(
      createEvent(
        {
          id: "rpc-1",
          jsonrpc: "2.0",
          method: "session/prompt",
          params: {
            sessionId: "session-1",
          },
        },
        "outbound",
      ),
    );
    observer.onMessage(
      createEvent({
        id: "rpc-1",
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal error",
        },
      }),
    );

    expect(info).toHaveBeenNthCalledWith(2, "message", {
      backend: "acp:gemini",
      direction: "in",
      errorCode: -32603,
      errorMessage: "Internal error",
      id: "rpc-1",
      kind: "response",
      method: "session/prompt",
    });
  });

  it("coalesces streaming deltas and flushes the final chunk", () => {
    let now = 1_000;
    const info = vi.fn();
    const observer = createProtocolLogObserver({
      backend: "codex",
      logger: { info },
      now: () => now,
      streamLogIntervalMs: 500,
    });

    for (const delta of ["a", " ", "c"]) {
      observer.onMessage(
        createEvent({
          jsonrpc: "2.0",
          method: "item/agentMessage/delta",
          params: {
            delta,
            itemId: "item-1",
            turnId: "turn-1",
            threadId: "thread-1",
          },
        }),
      );
      now += 100;
    }

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenLastCalledWith(
      "stream delta",
      expect.objectContaining({
        chars: 1,
        count: 1,
        reason: "interval",
        text: "a",
      }),
    );

    observer.onMessage(
      createEvent({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          item: {
            id: "item-1",
            type: "assistantMessage",
          },
          turnId: "turn-1",
          threadId: "thread-1",
        },
      }),
    );

    expect(info).toHaveBeenCalledTimes(3);
    expect(info).toHaveBeenNthCalledWith(
      2,
      "stream delta",
      expect.objectContaining({
        chars: 3,
        count: 3,
        reason: "final",
        text: "a c",
      }),
    );
    expect(info).toHaveBeenLastCalledWith(
      "message",
      expect.objectContaining({
        itemId: "item-1",
        method: "item/completed",
      }),
    );
  });

  it("fans out composite observer events even when an observer fails", async () => {
    const first = vi.fn();
    const failure = new Error("capture failed");
    const failing = vi.fn(async () => {
      throw failure;
    });
    const second = vi.fn();
    const observer = createCompositeJsonRpcObserver([
      { onMessage: first },
      { onMessage: failing },
      { onMessage: second },
    ]);
    const event = createEvent({
      id: "rpc-1",
      jsonrpc: "2.0",
      result: {},
    });

    await expect(observer?.onMessage(event)).rejects.toThrow(failure);

    expect(first).toHaveBeenCalledWith(event);
    expect(failing).toHaveBeenCalledWith(event);
    expect(second).toHaveBeenCalledWith(event);
  });
});
