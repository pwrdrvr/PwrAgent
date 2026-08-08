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
    const resolveInstance = vi.fn((instanceId: string) =>
      instanceId === "owner_one"
        ? { label: "Owner Mac", celestialIcon: "moon" as const }
        : { label: "Viewer Mac", celestialIcon: "sun" as const }
    );

    const hydrated = await hydrateFederatedThreadMessageOrigins({
      localInstanceId: "viewer_one",
      ownerInstanceId: "owner_one",
      response,
      resolveInstance,
      resolveThread,
    });

    expect(resolveThread).toHaveBeenCalledTimes(2);
    expect(hydrated.replay.entries).toMatchObject([
      {
        origin: {
          sourceThread: {
            backend: "codex",
            instanceId: "owner_one",
            instanceLabel: "Owner Mac",
            celestialIcon: "moon",
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
            instanceLabel: "Owner Mac",
            celestialIcon: "moon",
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
      resolveInstance: () => ({
        label: "Remote Mac",
        celestialIcon: "ringed-planet",
      }),
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
          instanceLabel: "Remote Mac",
          celestialIcon: "ringed-planet",
          threadId: "legacy-remote-parent",
          title: "Remote parent thread",
        },
      },
    });
  });

  it("preserves a later fallback title when a deduplicated lookup fails", async () => {
    const response: AppServerReadThreadResponse = {
      backend: "codex",
      fetchedAt: 1_000,
      threadId: "remote-child",
      replay: {
        entries: [{
          type: "message",
          id: "source-without-title",
          role: "user",
          text: "First occurrence has no title.",
          origin: {
            kind: "agent",
            sourceThread: {
              backend: "codex",
              instanceId: "remote_one",
              instanceLabel: "Remembered Remote Mac",
              celestialIcon: "moon",
              threadId: "remote-parent",
            },
          },
        }],
        messages: [{
          id: "source-with-fallback-title",
          role: "user",
          text: "Later occurrence retains a useful title.",
          origin: {
            kind: "agent",
            sourceThread: {
              backend: "codex",
              instanceId: "remote_one",
              threadId: "remote-parent",
              title: "Remote parent fallback",
            },
          },
        }],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    };
    const resolveThread = vi.fn(async () => {
      throw new Error("peer disconnected");
    });

    const hydrated = await hydrateFederatedThreadMessageOrigins({
      localInstanceId: "viewer_one",
      ownerInstanceId: "owner_one",
      response,
      resolveInstance: () => {
        throw new Error("peer metadata unavailable");
      },
      resolveThread,
    });

    expect(resolveThread).toHaveBeenCalledTimes(1);
    expect(hydrated.replay.entries[0]).toMatchObject({
      origin: {
        sourceThread: {
          instanceId: "remote_one",
          instanceLabel: "Remembered Remote Mac",
          celestialIcon: "moon",
          threadId: "remote-parent",
          title: "Remote parent fallback",
        },
      },
    });
    expect(hydrated.replay.messages[0]).toMatchObject({
      origin: {
        sourceThread: {
          instanceId: "remote_one",
          instanceLabel: "Remembered Remote Mac",
          celestialIcon: "moon",
          threadId: "remote-parent",
          title: "Remote parent fallback",
        },
      },
    });
  });
});
