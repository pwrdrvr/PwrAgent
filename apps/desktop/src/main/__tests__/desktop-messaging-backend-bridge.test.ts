import { describe, expect, it, vi } from "vitest";
import type {
  AppServerReadThreadResponse,
  AppServerThreadReplay,
} from "@pwragent/shared";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { DesktopMessagingBackendBridge } from "../messaging/desktop-backend-bridge";

describe("DesktopMessagingBackendBridge", () => {
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
});

function createBridge(replay: AppServerThreadReplay): DesktopMessagingBackendBridge {
  const response: AppServerReadThreadResponse = {
    backend: "codex",
    fetchedAt: 1,
    threadId: "thread-1",
    replay,
  };
  const registry = {
    readThread: vi.fn(async () => response),
  } as unknown as DesktopBackendRegistry;
  return new DesktopMessagingBackendBridge(registry);
}
