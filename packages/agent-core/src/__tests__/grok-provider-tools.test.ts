import { describe, expect, it, vi } from "vitest";
import { GrokProvider } from "../providers/grok-provider.js";
import type {
  ProviderTurnEvent,
  ProviderTurnEventListener,
} from "../providers/provider-contract.js";
import { createShellCommandTool } from "../tools/shell-command-tool.js";
import { LocalToolExecutor } from "../tools/tool-execution.js";
import type {
  ToolDescriptor,
  ToolExecutionContext,
  ToolExecutor,
  ToolInvocation,
} from "../tools/tool-contract.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import {
  makeXaiFunctionCallResponse,
  makeXaiResponse,
} from "../testing/xai-fixtures.js";

function createFetchSequence(responses: unknown[]) {
  let index = 0;
  return vi.fn(async (_url: string, init?: RequestInit) => ({
    ok: true,
    json: async () => responses[index++],
    text: async () => JSON.stringify({ body: init?.body ?? null }),
  }));
}

function parseRequestBodies(fetchImpl: ReturnType<typeof createFetchSequence>) {
  return fetchImpl.mock.calls.map(([, init]) =>
    JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
  );
}

function collectSubscribedEvents(
  subscribe: ProviderActiveTurnLike["subscribe"],
  onRequestInput?: (event: Extract<ProviderTurnEvent, { type: "request_input" }>) => void,
) {
  const events: ProviderTurnEvent[] = [];
  const unsubscribe = subscribe?.(async (event) => {
    events.push(event);
    if (event.type === "request_input") {
      onRequestInput?.(event);
    }
  });
  return { events, unsubscribe };
}

type ProviderActiveTurnLike = {
  subscribe?: (listener: ProviderTurnEventListener) => () => void;
};

function createStubToolExecutor(): {
  executor: ToolExecutor;
  calls: Array<{ invocation: ToolInvocation; context: ToolExecutionContext }>;
} {
  const calls: Array<{ invocation: ToolInvocation; context: ToolExecutionContext }> = [];
  const tools: ToolDescriptor[] = [
    {
      name: "search_code",
      description: "Search the repository for code matches.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string" as const,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      readOnly: true,
    },
    {
      name: "list_files",
      description: "List files in the repository.",
      inputSchema: {
        type: "object" as const,
        properties: {
          path: {
            type: "string" as const,
          },
        },
        additionalProperties: false,
      },
      readOnly: true,
    },
  ];

  return {
    calls,
    executor: {
      listTools: () => tools,
      getTool: (name) => tools.find((tool) => tool.name === name),
      executeTool: async (invocation, context) => {
        calls.push({ invocation, context });
        if (invocation.name === "search_code") {
          return {
            toolName: "search_code",
            arguments: invocation.arguments ?? {},
            success: true,
            output: `Found ${(invocation.arguments?.query as string) ?? "query"}.`,
            data: { matches: 1 },
            commandAction: "search",
            item: {
              type: "dynamicToolCall",
              text: `Found ${(invocation.arguments?.query as string) ?? "query"}.`,
              toolName: "search_code",
              success: true,
              arguments: invocation.arguments ?? {},
              commandAction: "search",
            },
          };
        }
        return {
          toolName: "list_files",
          arguments: invocation.arguments ?? {},
          success: true,
          output: "Listed files.",
          data: { count: 2 },
          commandAction: "listFiles",
          item: {
            type: "dynamicToolCall",
            text: "Listed files.",
            toolName: "list_files",
            success: true,
            arguments: invocation.arguments ?? {},
            commandAction: "listFiles",
          },
        };
      },
    },
  };
}

describe("GrokProvider tool loop", () => {
  it("continues with function_call_output and previous_response_id after a tool call", async () => {
    const fetchImpl = createFetchSequence([
      makeXaiFunctionCallResponse({
        id: "resp_tool_1",
        calls: [
          {
            callId: "call_search",
            name: "search_code",
            argumentsText: JSON.stringify({ query: "needle" }),
          },
        ],
      }),
      makeXaiResponse({ id: "resp_final_1", text: "Needle located." }),
    ]);
    const { executor, calls } = createStubToolExecutor();
    const provider = new GrokProvider({
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const activeTurn = provider.startTurn({
      thread: {
        threadId: "thread-123",
        cwd: "/repo/workspace",
        model: "grok-4.20-reasoning",
        approvalPolicy: "never",
        sandbox: "workspace-write",
      },
      input: [{ type: "text", text: "Find the needle." }],
      tools: executor,
    });
    const { events } = collectSubscribedEvents(activeTurn.subscribe);

    await expect(activeTurn.result).resolves.toEqual({
      assistantText: "Needle located.",
      providerResponseId: "resp_final_1",
    });

    expect(calls).toEqual([
      expect.objectContaining({
        invocation: {
          name: "search_code",
          arguments: { query: "needle" },
        },
      }),
    ]);
    expect(events).toEqual([
      {
        type: "item_started",
        item: {
          id: "call_search",
          type: "dynamicToolCall",
          text: "search_code",
          toolName: "search_code",
          arguments: { query: "needle" },
          command: undefined,
        },
      },
      {
        type: "item_completed",
        item: {
          id: "call_search",
          type: "dynamicToolCall",
          text: "Found needle.",
          toolName: "search_code",
          success: true,
          arguments: { query: "needle" },
          commandAction: "search",
          command: undefined,
        },
      },
    ]);

    expect(parseRequestBodies(fetchImpl)).toEqual([
      {
        model: "grok-4.20-reasoning",
        input: [{ role: "user", content: [{ type: "input_text", text: "Find the needle." }] }],
        tools: [
          {
            type: "function",
            name: "search_code",
            description: "Search the repository for code matches.",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              additionalProperties: false,
            },
          },
          {
            type: "function",
            name: "list_files",
            description: "List files in the repository.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              additionalProperties: false,
            },
          },
        ],
        stream: false,
      },
      {
        model: "grok-4.20-reasoning",
        input: [
          {
            type: "function_call_output",
            call_id: "call_search",
            output:
              "{\"toolName\":\"search_code\",\"success\":true,\"output\":\"Found needle.\",\"data\":{\"matches\":1},\"errorCode\":null}",
          },
        ],
        previous_response_id: "resp_tool_1",
        tools: [
          {
            type: "function",
            name: "search_code",
            description: "Search the repository for code matches.",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
              required: ["query"],
              additionalProperties: false,
            },
          },
          {
            type: "function",
            name: "list_files",
            description: "List files in the repository.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              additionalProperties: false,
            },
          },
        ],
        stream: false,
      },
    ]);
  });

  it("emits multiple tool calls in order before producing the final assistant output", async () => {
    const fetchImpl = createFetchSequence([
      makeXaiFunctionCallResponse({
        id: "resp_tool_batch",
        calls: [
          {
            callId: "call_search",
            name: "search_code",
            argumentsText: JSON.stringify({ query: "alpha" }),
          },
          {
            callId: "call_list",
            name: "list_files",
            argumentsText: JSON.stringify({ path: "src" }),
          },
        ],
      }),
      makeXaiResponse({ id: "resp_final_batch", text: "Done." }),
    ]);
    const { executor } = createStubToolExecutor();
    const provider = new GrokProvider({
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const activeTurn = provider.startTurn({
      thread: {
        threadId: "thread-123",
        cwd: "/repo/workspace",
        model: "grok-4.20-reasoning",
      },
      input: [{ type: "text", text: "Inspect the repo." }],
      tools: executor,
    });
    const { events } = collectSubscribedEvents(activeTurn.subscribe);

    await expect(activeTurn.result).resolves.toEqual({
      assistantText: "Done.",
      providerResponseId: "resp_final_batch",
    });

    expect(
      events.map((event) => {
        if (event.type === "request_input") {
          return `${event.type}:${event.requestId}`;
        }
        if (event.type === "item_started" || event.type === "item_completed") {
          return `${event.type}:${event.item.id}`;
        }
        return event.type;
      }),
    ).toEqual([
      "item_started:call_search",
      "item_completed:call_search",
      "item_started:call_list",
      "item_completed:call_list",
    ]);
  });

  it("routes approval requests through provider events before completing the tool call", async () => {
    const fetchImpl = createFetchSequence([
      makeXaiFunctionCallResponse({
        id: "resp_shell_1",
        calls: [
          {
            callId: "call_shell",
            name: "shell_command",
            argumentsText: JSON.stringify({ command: "touch created.txt" }),
          },
        ],
      }),
      makeXaiResponse({ id: "resp_shell_final", text: "Shell step complete." }),
    ]);
    const provider = new GrokProvider({
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const executor = new LocalToolExecutor(new ToolRegistry([createShellCommandTool()]));

    const activeTurn = provider.startTurn({
      thread: {
        threadId: "thread-123",
        cwd: "/repo/workspace",
        model: "grok-4.20-reasoning",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
      input: [{ type: "text", text: "Touch a file." }],
      tools: executor,
    });
    const { events } = collectSubscribedEvents(activeTurn.subscribe, (event) => {
      void event.respond({ decision: "decline" });
    });

    await expect(activeTurn.result).resolves.toEqual({
      assistantText: "Shell step complete.",
      providerResponseId: "resp_shell_final",
    });

    expect(events).toEqual([
      {
        type: "item_started",
        item: {
          id: "call_shell",
          type: "commandExecution",
          text: "shell_command",
          toolName: "shell_command",
          arguments: { command: "touch created.txt" },
          command: "touch created.txt",
        },
      },
      {
        type: "request_input",
        requestId: expect.stringMatching(/^shell_command-/),
        method: "turn/requestApproval",
        params: {
          kind: "commandExecution",
          reason: "command requires approval: touch",
          path: undefined,
          command: "touch created.txt",
          commandAction: "unknown",
        },
        respond: expect.any(Function),
      },
      {
        type: "item_completed",
        item: {
          id: "call_shell",
          type: "commandExecution",
          text: "Approval declined for shell_command: touch created.txt",
          toolName: "shell_command",
          success: false,
          arguments: { command: "touch created.txt" },
          commandAction: "unknown",
          command: "touch created.txt",
        },
      },
    ]);
  });

  it("turns malformed tool arguments into a failed tool item instead of crashing", async () => {
    const fetchImpl = createFetchSequence([
      makeXaiFunctionCallResponse({
        id: "resp_bad_args",
        calls: [
          {
            callId: "call_bad",
            name: "search_code",
            argumentsText: "{",
          },
        ],
      }),
      makeXaiResponse({ id: "resp_bad_args_final", text: "Recovered." }),
    ]);
    const { executor, calls } = createStubToolExecutor();
    const provider = new GrokProvider({
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const activeTurn = provider.startTurn({
      thread: {
        threadId: "thread-123",
        cwd: "/repo/workspace",
        model: "grok-4.20-reasoning",
      },
      input: [{ type: "text", text: "Run the tool." }],
      tools: executor,
    });
    const { events } = collectSubscribedEvents(activeTurn.subscribe);

    await expect(activeTurn.result).resolves.toEqual({
      assistantText: "Recovered.",
      providerResponseId: "resp_bad_args_final",
    });

    expect(calls).toEqual([]);
    expect(events).toEqual([
      {
        type: "item_started",
        item: {
          id: "call_bad",
          type: "dynamicToolCall",
          text: "search_code",
          toolName: "search_code",
          arguments: undefined,
          command: undefined,
        },
      },
      {
        type: "item_completed",
        item: {
          id: "call_bad",
          type: "dynamicToolCall",
          text: expect.stringMatching(/arguments must be valid JSON/),
          toolName: "search_code",
          success: false,
          arguments: {},
          command: undefined,
        },
      },
    ]);
  });

  it("fails deterministically when the tool loop exceeds the configured round limit", async () => {
    const fetchImpl = createFetchSequence([
      makeXaiFunctionCallResponse({
        id: "resp_round_1",
        calls: [
          {
            callId: "call_1",
            name: "search_code",
            argumentsText: JSON.stringify({ query: "first" }),
          },
        ],
      }),
      makeXaiFunctionCallResponse({
        id: "resp_round_2",
        calls: [
          {
            callId: "call_2",
            name: "search_code",
            argumentsText: JSON.stringify({ query: "second" }),
          },
        ],
      }),
    ]);
    const { executor } = createStubToolExecutor();
    const provider = new GrokProvider({
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxToolRounds: 1,
    });

    const activeTurn = provider.startTurn({
      thread: {
        threadId: "thread-123",
        cwd: "/repo/workspace",
        model: "grok-4.20-reasoning",
      },
      input: [{ type: "text", text: "Loop forever." }],
      tools: executor,
    });

    await expect(activeTurn.result).rejects.toThrow(
      "Grok tool loop exceeded the maximum round limit (1)",
    );
  });
});
