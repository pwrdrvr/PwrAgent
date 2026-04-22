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

type StreamToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

function createStreamTextMock(params: {
  text?: string;
  responseId?: string;
  toolCalls?: StreamToolCall[];
  sources?: unknown[];
}) {
  return vi.fn((options: any) => {
    const run = async () => {
      for (const call of params.toolCalls ?? []) {
        const aiTool = options.tools?.[call.name];
        if (!aiTool?.execute) {
          throw new Error(`Missing AI SDK tool: ${call.name}`);
        }
        await aiTool.execute(call.input, {
          toolCallId: call.id,
          messages: options.messages,
          abortSignal: options.abortSignal,
        });
      }
      return params.text ?? "Done.";
    };
    const text = run();
    return {
      text,
      response: text.then(() => ({ id: params.responseId ?? "resp_123" })),
      sources: Promise.resolve(params.sources ?? []),
      providerMetadata: Promise.resolve(undefined),
    };
  });
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
  it("wraps local tools as AI SDK tools and emits app-server item events", async () => {
    const streamTextImpl = createStreamTextMock({
      text: "Needle located.",
      responseId: "resp_final_1",
      toolCalls: [{ id: "call_search", name: "search_code", input: { query: "needle" } }],
    });
    const { executor, calls } = createStubToolExecutor();
    const provider = new GrokProvider({
      apiKey: "test-key",
      streamTextImpl,
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
      sources: [],
      providerMetadata: undefined,
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
          data: { matches: 1 },
          sources: undefined,
          commandAction: "search",
          command: undefined,
        },
      },
    ]);
    expect(streamTextImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Find the needle." }],
          },
        ],
        tools: expect.objectContaining({
          search_code: expect.any(Object),
          search_web: expect.any(Object),
          search_x: expect.any(Object),
        }),
      }),
    );
  });

  it("includes thread history when starting a chat-model turn", async () => {
    const streamTextImpl = createStreamTextMock({ text: "With context." });
    const provider = new GrokProvider({
      apiKey: "test-key",
      streamTextImpl,
    });

    const activeTurn = provider.startTurn({
      thread: {
        threadId: "thread-123",
        model: "grok-4.20-reasoning",
      },
      history: [
        { role: "user", text: "Remember this." },
        { role: "assistant", text: "Remembered." },
      ],
      input: [{ type: "text", text: "What did I say?" }],
    });

    await expect(activeTurn.result).resolves.toMatchObject({
      assistantText: "With context.",
    });
    expect(streamTextImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "user", content: "Remember this." },
          { role: "assistant", content: "Remembered." },
          {
            role: "user",
            content: [{ type: "text", text: "What did I say?" }],
          },
        ],
      }),
    );
  });

  it("routes approval requests through provider events before completing the tool call", async () => {
    const streamTextImpl = createStreamTextMock({
      text: "Shell step complete.",
      responseId: "resp_shell_final",
      toolCalls: [
        {
          id: "call_shell",
          name: "shell_command",
          input: { command: "touch created.txt" },
        },
      ],
    });
    const provider = new GrokProvider({
      apiKey: "test-key",
      streamTextImpl,
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

    await expect(activeTurn.result).resolves.toMatchObject({
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
          data: undefined,
          sources: undefined,
          commandAction: "unknown",
          command: "touch created.txt",
        },
      },
    ]);
  });

  it("emits command output deltas from shell tool execution", async () => {
    const streamTextImpl = createStreamTextMock({
      text: "Done.",
      responseId: "resp_shell_delta_final",
      toolCalls: [
        {
          id: "call_shell_delta",
          name: "shell_command",
          input: { command: "echo live" },
        },
      ],
    });
    const provider = new GrokProvider({
      apiKey: "test-key",
      streamTextImpl,
    });
    const tools: ToolDescriptor[] = [
      {
        name: "shell_command",
        description: "Run a shell command.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
          },
          required: ["command"],
          additionalProperties: false,
        },
        readOnly: false,
      },
    ];
    const executor: ToolExecutor = {
      listTools: () => tools,
      getTool: (name) => tools.find((tool) => tool.name === name),
      executeTool: async (invocation, context) => {
        context.onOutputDelta?.({
          stream: "stdout",
          text: "live output",
          bytes: 11,
        });
        return {
          toolName: invocation.name,
          arguments: invocation.arguments ?? {},
          success: true,
          output: "live output",
          data: {
            exitCode: 0,
            stdoutTruncated: false,
          },
          commandAction: "unknown",
          item: {
            type: "commandExecution",
            text: "live output",
            toolName: invocation.name,
            success: true,
            arguments: invocation.arguments ?? {},
            commandAction: "unknown",
            command: "echo live",
            data: {
              exitCode: 0,
              stdoutTruncated: false,
            },
          },
        };
      },
    };

    const activeTurn = provider.startTurn({
      thread: {
        threadId: "thread-123",
        cwd: "/repo/workspace",
        model: "grok-4.20-reasoning",
      },
      input: [{ type: "text", text: "Run shell." }],
      tools: executor,
    });
    const { events } = collectSubscribedEvents(activeTurn.subscribe);

    await expect(activeTurn.result).resolves.toEqual({
      assistantText: "Done.",
      providerResponseId: "resp_shell_delta_final",
      sources: [],
      providerMetadata: undefined,
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "item_started",
        item: expect.objectContaining({
          id: "call_shell_delta",
          type: "commandExecution",
        }),
      }),
      {
        type: "item_command_output_delta",
        itemId: "call_shell_delta",
        delta: "live output",
        stream: "stdout",
        bytes: 11,
      },
      expect.objectContaining({
        type: "item_completed",
        item: expect.objectContaining({
          id: "call_shell_delta",
          type: "commandExecution",
          data: {
            exitCode: 0,
            stdoutTruncated: false,
          },
        }),
      }),
    ]);
  });

  it("preserves AI SDK sources returned by the model call", async () => {
    const streamTextImpl = createStreamTextMock({
      text: "Search complete.",
      responseId: "resp_sources",
      sources: [
        {
          id: "src_1",
          sourceType: "url",
          url: "https://example.com/post",
          title: "Example post",
        },
      ],
    });
    const provider = new GrokProvider({
      apiKey: "test-key",
      streamTextImpl,
    });

    const activeTurn = provider.startTurn({
      thread: { threadId: "thread-123", model: "grok-4.20-reasoning" },
      input: [{ type: "text", text: "Search for this." }],
    });

    await expect(activeTurn.result).resolves.toEqual({
      assistantText: "Search complete.",
      providerResponseId: "resp_sources",
      sources: [
        {
          id: "src_1",
          sourceType: "url",
          url: "https://example.com/post",
          title: "Example post",
          providerMetadata: undefined,
        },
      ],
      providerMetadata: undefined,
    });
  });
});
