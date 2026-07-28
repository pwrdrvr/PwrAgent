import { describe, expect, it, vi } from "vitest";
import type { AcpBackendId } from "@pwragent/shared";
import { AcpThreadTitleGenerator } from "../app-server/acp-thread-title-generator";

describe("AcpThreadTitleGenerator", () => {
  it("extracts title JSON even when streamed chunks left raw newlines in the string", async () => {
    const backend = "acp:qwen" as AcpBackendId;
    const sendControlPrompt = vi.fn(async () => ({
      text: '{"title": "\nFavorite cereal question\n"}',
      model: "qwen3.6-plus",
      tokenUsage: {
        inputTokens: 120,
        cachedInputTokens: 20,
        outputTokens: 8,
        totalTokens: 128,
      },
    }));
    const startSession = vi.fn(async () => ({
      backendId: backend,
      sessionId: "qwen-title-helper",
      title: "Name this thread",
      createdAt: 1001,
      updatedAt: 1001,
      executionMode: "default" as const,
      hidden: true,
      status: "idle" as const,
    }));
    const configureHelperSession = vi.fn(async () => undefined);
    const generator = new AcpThreadTitleGenerator({
      backend,
      configureHelperSession,
      helperSession: {
        mcpServers: "none",
        reasoningEffort: "low",
        sessionMeta: {
          systemPromptOverride: "Return only the requested result.",
        },
      },
      getClient: async () => ({
        cancelSession: vi.fn(),
        dispose: vi.fn(),
        ensureSession: vi.fn(),
        initialize: vi.fn(),
        loadSession: vi.fn(),
        readReplay: vi.fn(),
        refreshSession: vi.fn(),
        sendControlPrompt,
        startPrompt: vi.fn(),
        startSession,
      }),
      getSession: () => ({
        backendId: backend,
        sessionId: "qwen-session-1",
        title: "ACP session",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "default",
        status: "idle",
      }),
    });

    await expect(
      generator.generateTitle({
        backend,
        prompt: "Name this thread",
        promptVersion: "thread-title-v1",
        schema: { type: "object" },
        schemaName: "thread_title",
        threadId: "qwen-session-1",
        timeoutMs: 20_000,
      }),
    ).resolves.toMatchObject({
      status: "ok",
      object: { title: " Favorite cereal question " },
      helperThreadId: "qwen-title-helper",
      model: "qwen3.6-plus",
      reasoningEffort: "low",
      tokenUsage: {
        inputTokens: 120,
        cachedInputTokens: 20,
        outputTokens: 8,
        totalTokens: 128,
      },
    });
    expect(startSession).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: "default",
        hidden: true,
        mcpServers: "none",
        sessionMeta: {
          systemPromptOverride: "Return only the requested result.",
        },
        title: "Name this thread",
      }),
    );
    expect(configureHelperSession).toHaveBeenCalledWith(
      expect.objectContaining({
        reasoningEffort: "low",
      }),
    );
    expect(sendControlPrompt).toHaveBeenCalledWith({
      sessionId: "qwen-title-helper",
      prompt: "Name this thread",
    });
  });
});
