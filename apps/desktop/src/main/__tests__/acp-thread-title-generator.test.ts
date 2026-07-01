import { describe, expect, it, vi } from "vitest";
import type { AcpBackendId } from "@pwragent/shared";
import { AcpThreadTitleGenerator } from "../app-server/acp-thread-title-generator";

describe("AcpThreadTitleGenerator", () => {
  it("extracts title JSON even when streamed chunks left raw newlines in the string", async () => {
    const backend = "acp:qwen" as AcpBackendId;
    const sendControlPrompt = vi.fn(async () => ({
      text: '{"title": "\nFavorite cereal question\n"}',
    }));
    const generator = new AcpThreadTitleGenerator({
      backend,
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
        startSession: vi.fn(),
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
    });
  });
});
