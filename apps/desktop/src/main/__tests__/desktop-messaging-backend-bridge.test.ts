import { describe, expect, it, vi } from "vitest";
import type {
  AppServerReadThreadResponse,
  AppServerThreadReplay,
} from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { DesktopMessagingBackendBridge } from "../messaging/desktop-backend-bridge";

describe("DesktopMessagingBackendBridge", () => {
  it("preserves enriched messaging provenance when starting a turn", async () => {
    const submitTurn = vi.fn(async (request) => ({
      status: "started" as const,
      entry: {
        ...request,
        id: "queue-entry-1",
        createdAt: 1_000,
      },
      turnId: "turn-1",
    }));
    const bridge = new DesktopMessagingBackendBridge({
      submitTurn,
    } as unknown as DesktopBackendRegistry);
    const messageOrigin = {
      kind: "messaging" as const,
      messaging: {
        platform: "slack" as const,
        surface: {
          id: "thread-1",
          kind: "thread" as const,
          title: "api-search circuit breaker timeout",
          parentTitle: "signals-chat",
          ancestorTitle: "PwrAgent",
        },
        actor: {
          platformUserId: "U012345",
          displayName: "Hunter",
          username: "huntharo",
        },
      },
    };

    await bridge.startTurn({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "Go for it." }],
      messageOrigin,
    });

    expect(submitTurn).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "Go for it." }],
      messageOrigin,
      origin: "messaging",
    });
  });

  it("reads active turns from the registry", async () => {
    const bridge = createBridge({
      entries: [],
      messages: [],
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
    });

    await expect(
      bridge.readActiveTurn({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toEqual({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-live",
    });
  });

  it("prefers newer transcript assistant entries over stale replay messages", async () => {
    const bridge = createBridge({
      entries: [
        {
          type: "message",
          id: "newer-entry",
          role: "assistant",
          text: "Actually latest bot reply.",
          createdAt: 3_000,
        },
      ],
      messages: [
        {
          id: "stale-message",
          role: "assistant",
          text: "Stale nested response item.",
          createdAt: 1_000,
        },
      ],
      lastAssistantMessage: "Stale nested response item.",
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
    });

    await expect(
      bridge.readThreadLastAssistantReply({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toEqual({
      text: "Actually latest bot reply.",
      createdAt: 3_000,
    });
  });

  it("prefers the latest replay message over older transcript entries", async () => {
    const bridge = createBridge({
      entries: [
        {
          type: "message",
          id: "older-entry",
          role: "assistant",
          text: "Older transcript entry.",
          createdAt: 1_000,
        },
      ],
      messages: [
        {
          id: "older-message",
          role: "assistant",
          text: "Older transcript entry.",
        },
        {
          id: "newer-nested-message",
          role: "assistant",
          text: "Newer nested response item.",
          createdAt: 2_000,
        },
      ],
      lastAssistantMessage: "Newer nested response item.",
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
    });

    await expect(
      bridge.readThreadLastAssistantReply({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toEqual({
      text: "Newer nested response item.",
      createdAt: 2_000,
    });
  });

  it("uses matching transcript entry timestamps when replay messages lack one", async () => {
    const bridge = createBridge({
      entries: [
        {
          type: "message",
          id: "entry-final",
          role: "assistant",
          text: "Final turn-shaped answer.",
          createdAt: 3_000,
        },
      ],
      messages: [
        {
          id: "message-final",
          role: "assistant",
          text: "Final turn-shaped answer.",
        },
      ],
      lastAssistantMessage: "Final turn-shaped answer.",
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
    });

    await expect(
      bridge.readThreadLastAssistantReply({
        backend: "codex",
        threadId: "thread-1",
      }),
    ).resolves.toEqual({
      text: "Final turn-shaped answer.",
      createdAt: 3_000,
    });
  });

  it("resolves and shares final assistant images across messaging controllers", async () => {
    const response: AppServerReadThreadResponse = {
      backend: "codex",
      fetchedAt: 1,
      threadId: "thread-1",
      replay: {
        entries: [],
        messages: [
          {
            id: "assistant-final",
            role: "assistant",
            text: "Final screenshot.",
            parts: [
              { type: "text", text: "Final screenshot." },
              {
                type: "image",
                url: "https://example.com/final.png",
                alt: "Final screenshot",
              },
            ],
          },
        ],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    };
    const readThread = vi.fn(async () => response);
    const bridge = new DesktopMessagingBackendBridge({
      getThreadTranscriptImageRoots: vi.fn(async () => []),
      readThread,
    } as unknown as DesktopBackendRegistry);
    const request = {
      backend: "codex" as const,
      text: "Final screenshot.",
      threadId: "thread-1",
      turnId: "turn-1",
    };

    await expect(Promise.all([
      bridge.resolveAssistantMessageImages(request),
      bridge.resolveAssistantMessageImages(request),
    ])).resolves.toEqual([
      [
        {
          type: "image",
          url: "https://example.com/final.png",
          alt: "Final screenshot",
          source: "assistant",
        },
      ],
      [
        {
          type: "image",
          url: "https://example.com/final.png",
          alt: "Final screenshot",
          source: "assistant",
        },
      ],
    ]);
    expect(readThread).toHaveBeenCalledTimes(1);
  });
});

function createBridge(replay: AppServerThreadReplay): DesktopMessagingBackendBridge {
  const response: AppServerReadThreadResponse = {
    backend: "codex",
    fetchedAt: 1,
    threadId: "thread-1",
    replay,
  };
  const registry = {
    getActiveTurnForThread: vi.fn(async () => ({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-live",
    })),
    readThread: vi.fn(async () => response),
  } as unknown as DesktopBackendRegistry;
  return new DesktopMessagingBackendBridge(registry);
}
