import { homedir } from "node:os";
import { parse } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AcpBackendId } from "@pwragent/shared";
import { AcpThreadTitleGenerator } from "../app-server/acp-thread-title-generator";

describe("AcpThreadTitleGenerator", () => {
  it.each([undefined, "", "relative/path", homedir(), parse(homedir()).root])(
    "does not launch a helper with an unscoped workspace: %s",
    async (cwd) => {
      const getClient = vi.fn();
      const generator = new AcpThreadTitleGenerator({
        backend: "acp:qwen",
        getClient,
        getSession: () => ({
          backendId: "acp:qwen",
          sessionId: "parent",
          title: "ACP session",
          cwd,
          createdAt: 1,
          updatedAt: 1,
          executionMode: "default",
          status: "idle",
        }),
      });
      await expect(generator.generateTitle({
        threadId: "parent",
        prompt: "Name this thread",
        promptVersion: "thread-title-v3",
        schema: {},
        schemaName: "thread_title",
        timeoutMs: 20_000,
      })).resolves.toEqual({
        status: "unavailable",
        reason: "acp:qwen_title_generator_workspace_missing",
      });
      expect(getClient).not.toHaveBeenCalled();
    },
  );
  it.each([
    {
      name: "repairs raw newlines inside title JSON",
      text: '{"title": "\nFavorite cereal question\n"}',
      object: { title: " Favorite cereal question " },
    },
    {
      name: "rejects an answer to the embedded task",
      text: "There's no PwrGit MCP server configured in this session. Want me to help with that?",
      object: {},
    },
    {
      name: "accepts a title describing the requested work",
      text: '{"title":"PwrGit MCP recent repositories"}',
      object: { title: "PwrGit MCP recent repositories" },
    },
  ])("$name", async ({ text, object }) => {
    const backend = "acp:qwen" as AcpBackendId;
    const sendControlPrompt = vi.fn(async () => ({
      text,
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
        cwd: "/repo/project",
        title: "ACP session",
        createdAt: 1000,
        updatedAt: 1000,
        executionMode: "full-access",
        acpRuntime: {
          currentModelId: "qwen3.6-plus",
          currentModeId: "yolo",
          configValues: { approval_mode: "yolo", model: "qwen3.6-plus" },
        },
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
      object,
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
        approvalPolicy: "deny-all",
        cwd: "/repo/project",
        acpRuntime: { currentModelId: "qwen3.6-plus" },
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
