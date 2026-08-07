import { describe, expect, it, vi } from "vitest";
import type { AppServerReadThreadResponse } from "@pwragent/shared";
import { hydrateFederatedThreadMessageOrigins } from "../federation/federated-thread-origin-hydrator";

describe("federated thread origin hydration", () => {
  it("hydrates unmounted source names and scopes legacy origins to the owner", async () => {
    const response: AppServerReadThreadResponse = {
      backend: "codex",
      fetchedAt: 1_000,
      threadId: "remote-child",
      replay: {
        entries: [
          {
            type: "message",
            id: "legacy-owner-message",
            role: "user",
            text: "Continue from the sibling thread.",
            origin: {
              kind: "agent",
              sourceThread: {
                backend: "codex",
                threadId: "remote-parent",
                title: "Stale remote title",
              },
            },
          },
          {
            type: "message",
            id: "local-viewer-message",
            role: "user",
            text: "Report back to the viewer.",
            origin: {
              kind: "agent",
              sourceThread: {
                backend: "codex",
                instanceId: "viewer_one",
                threadId: "viewer-parent",
              },
            },
          },
        ],
        messages: [
          {
            id: "legacy-owner-message",
            role: "user",
            text: "Continue from the sibling thread.",
            origin: {
              kind: "agent",
              sourceThread: {
                backend: "codex",
                threadId: "remote-parent",
                title: "Stale remote title",
              },
            },
          },
          {
            id: "local-viewer-message",
            role: "user",
            text: "Report back to the viewer.",
            origin: {
              kind: "agent",
              sourceThread: {
                backend: "codex",
                instanceId: "viewer_one",
                threadId: "viewer-parent",
              },
            },
          },
        ],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    };
    const resolveThread = vi.fn(async (ref: {
      instanceId: string;
      threadId: string;
    }) => ({
      instanceId: ref.instanceId,
      thread: {
        id: ref.threadId,
        title:
          ref.instanceId === "owner_one"
            ? "Remote pagination audit"
            : "Viewer parent thread",
        titleSource: "explicit" as const,
        linkedDirectories: [],
        source: "codex" as const,
      },
    }));

    const hydrated = await hydrateFederatedThreadMessageOrigins({
      localInstanceId: "viewer_one",
      ownerInstanceId: "owner_one",
      response,
      resolveThread,
    });

    expect(resolveThread).toHaveBeenCalledTimes(2);
    expect(hydrated.replay.entries).toMatchObject([
      {
        origin: {
          sourceThread: {
            backend: "codex",
            instanceId: "owner_one",
            threadId: "remote-parent",
            title: "Remote pagination audit",
          },
        },
      },
      {
        origin: {
          sourceThread: {
            backend: "codex",
            threadId: "viewer-parent",
            title: "Viewer parent thread",
          },
        },
      },
    ]);
    expect(hydrated.replay.messages).toMatchObject([
      {
        origin: {
          sourceThread: {
            instanceId: "owner_one",
            title: "Remote pagination audit",
          },
        },
      },
      {
        origin: {
          sourceThread: {
            title: "Viewer parent thread",
          },
        },
      },
    ]);
  });

  it("accepts a uniquely discovered owner for a legacy remote origin", async () => {
    const response: AppServerReadThreadResponse = {
      backend: "codex",
      fetchedAt: 1_000,
      threadId: "local-child",
      replay: {
        entries: [{
          type: "message",
          id: "legacy-remote-message",
          role: "user",
          text: "Please report back.",
          origin: {
            kind: "agent",
            sourceThread: {
              backend: "codex",
              threadId: "legacy-remote-parent",
            },
          },
        }],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    };
    const resolveThread = vi.fn(async () => ({
      instanceId: "remote_one",
      thread: {
        id: "legacy-remote-parent",
        title: "Remote parent thread",
        titleSource: "explicit" as const,
        linkedDirectories: [],
        source: "codex" as const,
      },
    }));

    const hydrated = await hydrateFederatedThreadMessageOrigins({
      localInstanceId: "viewer_one",
      ownerInstanceId: "viewer_one",
      response,
      resolveThread,
    });

    expect(resolveThread).toHaveBeenCalledWith({
      backend: "codex",
      discoverAcrossInstances: true,
      instanceId: "viewer_one",
      threadId: "legacy-remote-parent",
    });
    expect(hydrated.replay.entries[0]).toMatchObject({
      origin: {
        sourceThread: {
          backend: "codex",
          instanceId: "remote_one",
          threadId: "legacy-remote-parent",
          title: "Remote parent thread",
        },
      },
    });
  });
});
