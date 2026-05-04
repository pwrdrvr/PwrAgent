import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessagingController } from "../messaging/core/messaging-controller";
import { MessagingStore } from "../messaging/core/messaging-store";
import type {
  MessagingInboundEvent,
  MessagingSurfaceIntent,
} from "@pwragnt/messaging-interface";
import type {
  NavigationSnapshot,
  StartTurnRequest,
} from "@pwragnt/shared";
import { DiscordAdapter } from "@pwragnt/messaging-provider-discord";
import type {
  DiscordApi,
  DiscordApplicationCommand,
  DiscordCreateMessageRequest,
  DiscordInteractionResponseRequest,
} from "@pwragnt/messaging-provider-discord";
import { DISCORD_COMPONENT_CUSTOM_ID_LIMIT_BYTES } from "@pwragnt/messaging-provider-discord";
import type {
  DiscordGatewayConnection,
  DiscordGatewayEvent,
  DiscordGatewayListener,
} from "@pwragnt/messaging-provider-discord";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (tempDir) => {
      await rm(tempDir, { recursive: true, force: true });
    }),
  );
});

describe("DiscordAdapter", () => {
  it("reconciles Discord slash commands without recreating unchanged commands", async () => {
    const api = createApi({
      applicationCommands: [
        createApplicationCommand("cmd-resume", {
          description: "Choose a PwrAgnt thread to control from this conversation.",
          name: "resume",
          options: [
            {
              description: "Optional resume flags, such as --projects or --new.",
              name: "args",
              type: 3,
            },
          ],
        }),
        createApplicationCommand("cmd-status", {
          description: "Show the current PwrAgnt thread binding and controls.",
          name: "status",
        }),
        createApplicationCommand("cmd-detach", {
          description: "Detach this conversation from its current PwrAgnt thread.",
          name: "detach",
        }),
      ],
    });
    const adapter = new DiscordAdapter({
      api: api as unknown as DiscordApi,
      config: {
        applicationId: "app-1",
        channel: "discord",
        botToken: "discord-token",
        authorizedActorIds: ["42"],
      },
      gateway: createGateway(),
    });

    await adapter.start(async () => {});

    expect(api.listApplicationCommands).toHaveBeenCalledWith("app-1");
    expect(api.createApplicationCommand).not.toHaveBeenCalled();
    expect(api.updateApplicationCommand).not.toHaveBeenCalled();
    expect(api.deleteApplicationCommand).not.toHaveBeenCalled();
  });

  it("patches changed Discord slash commands and creates only missing commands", async () => {
    const api = createApi({
      applicationCommands: [
        createApplicationCommand("cmd-resume", {
          description: "Old resume description.",
          name: "resume",
        }),
        createApplicationCommand("cmd-status", {
          description: "Show the current PwrAgnt thread binding and controls.",
          name: "status",
        }),
        createApplicationCommand("cmd-legacy", {
          description: "Remove me.",
          name: "legacy",
        }),
      ],
    });
    const adapter = new DiscordAdapter({
      api: api as unknown as DiscordApi,
      config: {
        applicationId: "app-1",
        channel: "discord",
        botToken: "discord-token",
        authorizedActorIds: ["42"],
      },
      gateway: createGateway(),
    });

    await adapter.start(async () => {});

    expect(api.deleteApplicationCommand).toHaveBeenCalledWith("app-1", "cmd-legacy");
    expect(api.updateApplicationCommand).toHaveBeenCalledWith(
      "app-1",
      "cmd-resume",
      expect.objectContaining({
        name: "resume",
      }),
    );
    expect(api.createApplicationCommand).toHaveBeenCalledTimes(1);
    expect(api.createApplicationCommand).toHaveBeenCalledWith(
      "app-1",
      expect.objectContaining({
        name: "detach",
      }),
    );
  });

  it("creates missing Discord slash commands without bulk overwriting", async () => {
    const api = createApi();
    const adapter = new DiscordAdapter({
      api: api as unknown as DiscordApi,
      config: {
        applicationId: "app-1",
        channel: "discord",
        botToken: "discord-token",
        authorizedActorIds: ["42"],
      },
      gateway: createGateway(),
    });

    await adapter.start(async () => {});

    expect(api.listApplicationCommands).toHaveBeenCalledWith("app-1");
    expect(api.createApplicationCommand).toHaveBeenCalledTimes(3);
    expect(api.createApplicationCommand).toHaveBeenCalledWith(
      "app-1",
      expect.objectContaining({
        name: "resume",
      }),
    );
    expect(api.updateApplicationCommand).not.toHaveBeenCalled();
  });

  it("normalizes Discord slash command interactions", async () => {
    const events: MessagingInboundEvent[] = [];
    const api = createApi();
    const gateway = createGateway();
    const adapter = new DiscordAdapter({
      api: api as unknown as DiscordApi,
      config: {
        channel: "discord",
        botToken: "discord-token",
        authorizedActorIds: ["42"],
      },
      gateway,
      now: () => 1000,
    });

    await adapter.start(async (event) => {
      events.push(event);
    });
    await gateway.emit({
      d: {
        channel_id: "channel-1",
        data: {
          name: "resume",
          options: [
            {
              name: "args",
              value: "--projects",
            },
          ],
        },
        guild_id: "guild-1",
        id: "interaction-command-1",
        member: {
          nick: "Ada",
          user: {
            id: "42",
            username: "ada",
          },
        },
        token: "interaction-token",
        type: 2,
      },
      op: 0,
      s: 1,
      t: "INTERACTION_CREATE",
    });

    expect(api.createInteractionResponse).toHaveBeenCalledWith(
      "interaction-command-1",
      "interaction-token",
      {
        type: 5,
      },
    );
    expect(events.at(-1)).toMatchObject({
      args: ["--projects"],
      command: "resume",
      kind: "command",
      rawText: "/resume --projects",
    });
  });

  it("renders slash command responses through the deferred interaction response", async () => {
    const harness = await createControllerHarness({
      applicationId: "app-1",
    });

    await harness.adapter.start((event) => harness.controller.handleInboundEvent(event));
    await harness.gateway.emit({
      d: {
        channel_id: "channel-1",
        data: {
          name: "resume",
        },
        guild_id: "guild-1",
        id: "interaction-command-1",
        member: {
          user: {
            id: "42",
            username: "ada",
          },
        },
        token: "interaction-token",
        type: 2,
      },
      op: 0,
      s: 1,
      t: "INTERACTION_CREATE",
    });

    expect(harness.api.createInteractionResponse).toHaveBeenCalledWith(
      "interaction-command-1",
      "interaction-token",
      {
        type: 5,
      },
    );
    expect(harness.api.createMessage).not.toHaveBeenCalled();
    expect(harness.api.updateInteractionOriginalResponse).toHaveBeenCalledWith(
      "app-1",
      "interaction-token",
      expect.objectContaining({
        content: expect.stringContaining("Choose a thread to resume"),
      }),
    );
    expect(harness.api.createMessage).not.toHaveBeenCalled();
  });

  it("normalizes /resume and renders a picker with components", async () => {
    const harness = await createControllerHarness();

    await harness.adapter.start((event) => harness.controller.handleInboundEvent(event));
    await harness.gateway.emit({
      d: {
        author: {
          id: "42",
          username: "ada",
        },
        channel_id: "channel-1",
        content: "/resume",
        guild_id: "guild-1",
        id: "message-1",
      },
      op: 0,
      s: 1,
      t: "MESSAGE_CREATE",
    });

    const request = harness.api.createMessage.mock.calls.at(-1)?.[1];
    expect(harness.api.createMessage).toHaveBeenCalledWith(
      "channel-1",
      expect.objectContaining({
        allowed_mentions: {
          parse: [],
          replied_user: false,
          roles: [],
          users: [],
        },
        components: [
          {
            components: [
              expect.objectContaining({
                label: "1. Thread one",
              }),
              expect.objectContaining({
                label: "2. Thread two",
              }),
            ],
            type: 1,
          },
          {
            components: [
              expect.objectContaining({
                label: "Projects",
              }),
              expect.objectContaining({
                label: "New",
              }),
              expect.objectContaining({
                label: "Cancel",
              }),
            ],
            type: 1,
          },
        ],
      }),
    );
    const customId = request?.components?.[0]?.components[0]?.custom_id;
    const secondCustomId = request?.components?.[0]?.components[1]?.custom_id;
    expect(request?.content).toContain("Choose a thread to resume");
    expect(request?.content).not.toContain("1. Thread one");
    expect(customId).toMatch(/^dc:/);
    expect(Buffer.byteLength(customId ?? "", "utf8")).toBeLessThanOrEqual(
      DISCORD_COMPONENT_CUSTOM_ID_LIMIT_BYTES,
    );
    expect(customId).not.toContain("thread-1");
    expect(secondCustomId).toMatch(/^dc:/);
    expect(secondCustomId).not.toBe(customId);
  });

  it("discards stream updates unless streaming responses are enabled", async () => {
    const api = createApi();
    const adapter = new DiscordAdapter({
      api: api as unknown as DiscordApi,
      config: {
        channel: "discord",
        botToken: "discord-token",
        authorizedActorIds: ["42"],
      },
      gateway: createGateway(),
      now: () => 1000,
    });

    const result = await adapter.deliver({
      audit: {
        actor: {
          platformUserId: "42",
        },
        channel: {
          channel: "discord",
          conversation: {
            id: "channel-1",
            kind: "dm",
          },
        },
        occurredAt: 1000,
      },
      bindingId: "binding-1",
      createdAt: 1000,
      id: "stream-1",
      kind: "stream_update",
      role: "assistant",
      stream: {
        isFinal: false,
        key: "stream-key-1",
        sequence: 1,
      },
      text: "Hello",
    } satisfies MessagingSurfaceIntent);

    expect(result).toMatchObject({
      channel: "discord",
      outcome: "discarded",
    });
    expect(api.createMessage).not.toHaveBeenCalled();
    expect(api.updateMessage).not.toHaveBeenCalled();
  });

  it("creates and updates one Discord message for enabled stream updates", async () => {
    const api = createApi();
    const adapter = new DiscordAdapter({
      api: api as unknown as DiscordApi,
      config: {
        channel: "discord",
        botToken: "discord-token",
        authorizedActorIds: ["42"],
        streamingResponses: true,
      },
      gateway: createGateway(),
      now: () => 1000,
    });

    const baseIntent = {
      audit: {
        actor: {
          platformUserId: "42",
        },
        channel: {
          channel: "discord",
          conversation: {
            id: "channel-1",
            kind: "dm",
          },
        },
        occurredAt: 1000,
      },
      bindingId: "binding-1",
      createdAt: 1000,
      id: "stream-1",
      kind: "stream_update",
      role: "assistant",
      stream: {
        isFinal: false,
        key: "stream-key-1",
        sequence: 1,
      },
      text: "Hello",
    } satisfies MessagingSurfaceIntent;

    const first = await adapter.deliver(baseIntent);
    const second = await adapter.deliver({
      ...baseIntent,
      id: "stream-2",
      stream: {
        ...baseIntent.stream,
        isFinal: true,
        sequence: 2,
      },
      text: "Hello world",
    } satisfies MessagingSurfaceIntent);

    expect(first).toMatchObject({
      outcome: "presented",
      surface: {
        id: "message-1",
      },
    });
    expect(second).toMatchObject({
      outcome: "updated",
      surface: {
        id: "message-1",
      },
    });
    expect(api.createMessage).toHaveBeenCalledTimes(1);
    expect(api.createMessage).toHaveBeenCalledWith(
      "channel-1",
      expect.objectContaining({
        allowed_mentions: {
          parse: [],
          replied_user: false,
          roles: [],
          users: [],
        },
        content: "Hello",
      }),
    );
    expect(api.updateMessage).toHaveBeenCalledWith(
      "channel-1",
      "message-1",
      expect.objectContaining({
        content: "Hello world",
      }),
    );
  });

  it("rewrites the Discord picker message when navigating pages", async () => {
    const harness = await createControllerHarness({
      navigationSnapshot: buildNavigationSnapshot(10),
    });

    await harness.adapter.start((event) => harness.controller.handleInboundEvent(event));
    await harness.gateway.emit({
      d: {
        author: {
          id: "42",
          username: "ada",
        },
        channel_id: "channel-1",
        content: "/resume",
        guild_id: "guild-1",
        id: "message-1",
      },
      op: 0,
      s: 1,
      t: "MESSAGE_CREATE",
    });

    const firstRequest = harness.api.createMessage.mock.calls.at(-1)?.[1] as
      | DiscordCreateMessageRequest
      | undefined;
    const nextCustomId = firstRequest?.components
      ?.flatMap((row) => row.components)
      .find((component) => component.label === "Next")?.custom_id;

    expect(nextCustomId).toMatch(/^dc:/);

    await harness.gateway.emit({
      d: {
        channel_id: "channel-1",
        data: {
          custom_id: nextCustomId,
        },
        guild_id: "guild-1",
        id: "interaction-1",
        member: {
          user: {
            id: "42",
            username: "ada",
          },
        },
        message: {
          id: "message-1",
        },
        token: "interaction-token",
        type: 3,
      },
      op: 0,
      s: 2,
      t: "INTERACTION_CREATE",
    });

    expect(harness.api.createMessage).toHaveBeenCalledTimes(1);
    expect(harness.api.updateMessage).toHaveBeenCalledWith(
      "channel-1",
      "message-1",
      expect.objectContaining({
        content: expect.stringContaining("Page 2/2"),
      }),
    );
    const updateRequest = harness.api.updateMessage.mock.calls.at(-1)?.[2] as
      | DiscordCreateMessageRequest
      | undefined;
    expect(updateRequest?.content).toContain("Choose a thread to resume");
    expect(updateRequest?.content).not.toContain("9. Thread 9");
    expect(
      updateRequest?.components
        ?.flatMap((row) => row.components)
        .map((component) => component.label),
    ).toEqual([
      "9. Thread 9",
      "10. Thread 10",
      "Previous",
      "Projects",
      "New",
      "Cancel",
    ]);
  });

  it("removes Discord picker buttons when cancelling", async () => {
    const harness = await createControllerHarness({
      navigationSnapshot: buildNavigationSnapshot(10),
    });

    await harness.adapter.start((event) => harness.controller.handleInboundEvent(event));
    await harness.gateway.emit({
      d: {
        author: {
          id: "42",
          username: "ada",
        },
        channel_id: "channel-1",
        content: "/resume",
        guild_id: "guild-1",
        id: "message-1",
      },
      op: 0,
      s: 1,
      t: "MESSAGE_CREATE",
    });

    const firstRequest = harness.api.createMessage.mock.calls.at(-1)?.[1] as
      | DiscordCreateMessageRequest
      | undefined;
    const cancelCustomId = firstRequest?.components
      ?.flatMap((row) => row.components)
      .find((component) => component.label === "Cancel")?.custom_id;

    await harness.gateway.emit({
      d: {
        channel_id: "channel-1",
        data: {
          custom_id: cancelCustomId,
        },
        guild_id: "guild-1",
        id: "interaction-1",
        member: {
          user: {
            id: "42",
            username: "ada",
          },
        },
        message: {
          id: "message-1",
        },
        token: "interaction-token",
        type: 3,
      },
      op: 0,
      s: 2,
      t: "INTERACTION_CREATE",
    });

    expect(harness.api.createMessage).toHaveBeenCalledTimes(1);
    expect(harness.api.updateMessage).toHaveBeenCalledWith(
      "channel-1",
      "message-1",
      expect.objectContaining({
        components: [],
        content: "Resume cancelled\n\nNo thread binding changed.",
      }),
    );
  });

  it("signals typing activity without rendering a visible Discord message", async () => {
    const api = createApi();
    const adapter = new DiscordAdapter({
      api: api as unknown as DiscordApi,
      config: {
        channel: "discord",
        botToken: "discord-token",
        authorizedActorIds: ["42"],
      },
      gateway: createGateway(),
      now: () => 1000,
    });

    const activeResult = await adapter.deliver({
      id: "activity-1",
      kind: "activity",
      activity: "typing",
      createdAt: 1000,
      state: "active",
      audit: {
        actor: {
          platformUserId: "42",
        },
        channel: {
          channel: "discord",
          conversation: {
            id: "channel-1",
            kind: "channel",
            parentId: "guild-1",
          },
        },
        occurredAt: 1000,
      },
    });
    const idleResult = await adapter.deliver({
      id: "activity-2",
      kind: "activity",
      activity: "typing",
      createdAt: 1000,
      state: "idle",
      audit: {
        actor: {
          platformUserId: "42",
        },
        channel: {
          channel: "discord",
          conversation: {
            id: "channel-1",
            kind: "channel",
            parentId: "guild-1",
          },
        },
        occurredAt: 1000,
      },
    });

    expect(activeResult.outcome).toBe("signaled");
    expect(idleResult.outcome).toBe("signaled");
    expect(api.sendTyping).toHaveBeenCalledWith("channel-1");
    expect(api.createMessage).not.toHaveBeenCalled();
  });

  it("pins and unpins Discord status surfaces when requested", async () => {
    const api = createApi();
    const adapter = new DiscordAdapter({
      api: api as unknown as DiscordApi,
      config: {
        channel: "discord",
        botToken: "discord-token",
        authorizedActorIds: ["42"],
      },
      gateway: createGateway(),
      now: () => 1000,
    });

    const pinResult = await adapter.deliver({
      id: "status-1",
      kind: "status",
      createdAt: 1000,
      status: "idle",
      text: "Binding: active",
      delivery: {
        pin: true,
      },
      audit: {
        actor: {
          platformUserId: "42",
        },
        channel: {
          channel: "discord",
          conversation: {
            id: "channel-1",
            kind: "channel",
            parentId: "guild-1",
          },
        },
        occurredAt: 1000,
      },
    });

    expect(pinResult.outcome).toBe("pinned");
    expect(api.pinMessage).toHaveBeenCalledWith("channel-1", "message-1");

    const unpinResult = await adapter.deliver({
      id: "dismiss-1",
      kind: "dismiss",
      createdAt: 1000,
      delivery: {
        unpin: true,
      },
      targetSurface: {
        channel: "discord",
        id: "message-1",
        state: {
          opaque: {
            channelId: "channel-1",
            messageId: "message-1",
          },
        },
      },
    });

    expect(unpinResult.outcome).toBe("unpinned");
    expect(api.unpinMessage).toHaveBeenCalledWith("channel-1", "message-1");
  });

  it("expires Discord typing activity when no idle signal arrives", async () => {
    vi.useFakeTimers();
    try {
      const api = createApi();
      const adapter = new DiscordAdapter({
        api: api as unknown as DiscordApi,
        config: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: ["42"],
        },
        gateway: createGateway(),
        now: () => 1000,
      });

      await adapter.deliver({
        id: "activity-1",
        kind: "activity",
        activity: "typing",
        createdAt: 1000,
        leaseMs: 1000,
        state: "active",
        audit: {
          actor: {
            platformUserId: "42",
          },
          channel: {
            channel: "discord",
            conversation: {
              id: "channel-1",
              kind: "channel",
              parentId: "guild-1",
            },
          },
          occurredAt: 1000,
        },
      });
      await adapter.deliver({
        id: "activity-2",
        kind: "activity",
        activity: "typing",
        createdAt: 1000,
        leaseMs: 1000,
        state: "active",
        audit: {
          actor: {
            platformUserId: "42",
          },
          channel: {
            channel: "discord",
            conversation: {
              id: "channel-1",
              kind: "channel",
              parentId: "guild-1",
            },
          },
          occurredAt: 1000,
        },
      });

      expect(api.sendTyping).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);

      expect(api.sendTyping).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops Discord typing renewal after an idle activity signal", async () => {
    vi.useFakeTimers();
    try {
      const api = createApi();
      const adapter = new DiscordAdapter({
        api: api as unknown as DiscordApi,
        config: {
          channel: "discord",
          botToken: "discord-token",
          authorizedActorIds: ["42"],
        },
        gateway: createGateway(),
        now: () => 1000,
      });
      const audit = {
        actor: {
          platformUserId: "42",
        },
        channel: {
          channel: "discord" as const,
          conversation: {
            id: "channel-1",
            kind: "channel" as const,
            parentId: "guild-1",
          },
        },
        occurredAt: 1000,
      };

      await adapter.deliver({
        id: "activity-1",
        kind: "activity",
        activity: "typing",
        createdAt: 1000,
        state: "active",
        audit,
      });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(api.sendTyping.mock.calls.length).toBeGreaterThan(1);

      await adapter.deliver({
        id: "activity-2",
        kind: "activity",
        activity: "typing",
        createdAt: 1000,
        state: "idle",
        audit,
      });
      const callsAfterIdle = api.sendTyping.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);

      expect(api.sendTyping).toHaveBeenCalledTimes(callsAfterIdle);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves component custom IDs and acknowledges interactions", async () => {
    const harness = await createControllerHarness();

    await harness.adapter.start((event) => harness.controller.handleInboundEvent(event));
    await harness.gateway.emit({
      d: {
        author: {
          id: "42",
          username: "ada",
        },
        channel_id: "channel-1",
        content: "/resume",
        guild_id: "guild-1",
        id: "message-1",
      },
      op: 0,
      s: 1,
      t: "MESSAGE_CREATE",
    });
    const customId =
      harness.api.createMessage.mock.calls.at(-1)?.[1].components?.[0]?.components[0]
        ?.custom_id ?? "";

    await harness.gateway.emit({
      d: {
        channel_id: "channel-1",
        data: {
          custom_id: customId,
        },
        guild_id: "guild-1",
        id: "interaction-1",
        member: {
          user: {
            id: "42",
            username: "ada",
          },
        },
        token: "interaction-token",
        type: 3,
      },
      op: 0,
      s: 2,
      t: "INTERACTION_CREATE",
    });

    expect(harness.api.createInteractionResponse).toHaveBeenCalledWith(
      "interaction-1",
      "interaction-token",
      {
        type: 6,
      },
    );
    await expect(
      harness.store.findActiveBindingForChannel({
        channel: "discord",
        conversation: {
          id: "channel-1",
          kind: "channel",
          parentId: "guild-1",
        },
      }),
    ).resolves.toMatchObject({
      backend: "codex",
      threadId: "thread-1",
    });
  });

  it("routes free-form text from a persisted binding by stable Discord user id", async () => {
    const harness = await createControllerHarness();

    await harness.store.upsertBinding({
      id: "binding:discord:channel:guild-1:channel-1:codex:thread-1",
      authorizedActorIds: ["42"],
      backend: "codex",
      channel: {
        channel: "discord",
        conversation: {
          id: "channel-1",
          kind: "channel",
          parentId: "guild-1",
        },
      },
      createdAt: 1000,
      threadId: "thread-1",
      updatedAt: 1000,
    });
    await harness.adapter.start((event) => harness.controller.handleInboundEvent(event));
    await harness.gateway.emit({
      d: {
        author: {
          global_name: "Ada New",
          id: "42",
          username: "ada_new",
        },
        channel_id: "channel-1",
        content: "run the focused tests",
        guild_id: "guild-1",
        id: "message-2",
      },
      op: 0,
      s: 3,
      t: "MESSAGE_CREATE",
    });

    expect(harness.startTurn).toHaveBeenCalledWith({
      backend: "codex",
      input: [
        {
          text: "run the focused tests",
          type: "text",
        },
      ],
      threadId: "thread-1",
    });
  });

  it("rejects matching display names with different Discord ids through the controller", async () => {
    const harness = await createControllerHarness();

    await harness.adapter.start((event) => harness.controller.handleInboundEvent(event));
    await harness.gateway.emit({
      d: {
        author: {
          global_name: "Ada",
          id: "99",
          username: "ada",
        },
        channel_id: "channel-1",
        content: "/resume",
        guild_id: "guild-1",
        id: "message-3",
      },
      op: 0,
      s: 4,
      t: "MESSAGE_CREATE",
    });

    expect(harness.getNavigationSnapshot).not.toHaveBeenCalled();
    expect(harness.api.createMessage.mock.calls.at(-1)?.[1].content).toContain(
      "Not authorized",
    );
  });

  it("normalizes inbound attachments as unsupported without downloading them", async () => {
    const events: MessagingInboundEvent[] = [];
    const api = createApi();
    const gateway = createGateway();
    const adapter = new DiscordAdapter({
      api: api as unknown as DiscordApi,
      config: {
        channel: "discord",
        botToken: "discord-token",
        authorizedActorIds: ["42"],
      },
      gateway,
    });

    await adapter.start(async (event) => {
      events.push(event);
    });
    await gateway.emit({
      d: {
        attachments: [
          {
            filename: "secret.txt",
            id: "attachment-1",
            size: 12,
            url: "https://cdn.discordapp.com/secret.txt",
          },
        ],
        author: {
          id: "42",
          username: "ada",
        },
        channel_id: "channel-1",
        guild_id: "guild-1",
        id: "message-4",
      },
      op: 0,
      s: 5,
      t: "MESSAGE_CREATE",
    });

    expect(events.at(-1)).toMatchObject({
      disposition: "available",
      kind: "media",
      attachments: [
        expect.objectContaining({
          disposition: "available",
          kind: "file",
          name: "secret.txt",
        }),
      ],
      media: {
        name: "secret.txt",
      },
    });
  });

  it("surfaces missing Discord message content as a runtime platform error", async () => {
    const gateway = createGateway();
    const adapter = new DiscordAdapter({
      api: createApi() as unknown as DiscordApi,
      config: {
        channel: "discord",
        botToken: "discord-token",
        authorizedActorIds: ["42"],
      },
      gateway,
    });

    await adapter.start(async () => {});

    await expect(
      gateway.emit({
        d: {
          author: {
            id: "42",
            username: "ada",
          },
          channel_id: "channel-1",
          guild_id: "guild-1",
          id: "message-5",
        },
        op: 0,
        s: 6,
        t: "MESSAGE_CREATE",
      }),
    ).rejects.toThrow(
      "Discord message content is unavailable; enable the privileged message content intent.",
    );
  });

  it("renders image responses with defensive allowed mentions", async () => {
    const api = createApi();
    const adapter = new DiscordAdapter({
      api: api as unknown as DiscordApi,
      config: {
        channel: "discord",
        botToken: "discord-token",
        authorizedActorIds: ["42"],
      },
      now: () => 1000,
    });

    await adapter.deliver({
      audit: {
        actor: {
          platformUserId: "42",
        },
        channel: {
          channel: "discord",
          conversation: {
            id: "channel-1",
            kind: "channel",
            parentId: "guild-1",
          },
        },
        occurredAt: 1000,
      },
      createdAt: 1000,
      id: "intent-image",
      kind: "message",
      parts: [
        {
          text: "@everyone image",
          type: "text",
        },
        {
          type: "image",
          url: "https://example.com/image.png",
        },
      ],
    });

    expect(api.createMessage).toHaveBeenCalledWith(
      "channel-1",
      expect.objectContaining({
        allowed_mentions: {
          parse: [],
          replied_user: false,
          roles: [],
          users: [],
        },
        content: "@ everyone image\n\nhttps://example.com/image.png",
        embeds: [
          {
            image: {
              url: "https://example.com/image.png",
            },
          },
        ],
      }),
    );
  });
});

async function createControllerHarness(options: {
  applicationId?: string;
  navigationSnapshot?: NavigationSnapshot;
} = {}): Promise<{
  adapter: DiscordAdapter;
  api: ReturnType<typeof createApi>;
  controller: MessagingController;
  gateway: ReturnType<typeof createGateway>;
  getNavigationSnapshot: ReturnType<typeof vi.fn>;
  startTurn: ReturnType<typeof vi.fn>;
  store: MessagingStore;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragnt-discord-"));
  tempDirs.push(tempDir);
  const store = new MessagingStore(path.join(tempDir, "messaging-state.json"));
  const api = createApi();
  const gateway = createGateway();
  const getNavigationSnapshot = vi.fn(
    async () => options.navigationSnapshot ?? buildNavigationSnapshot(),
  );
  const startTurn = vi.fn(async (request: StartTurnRequest) => ({
    backend: request.backend,
    threadId: request.threadId,
    turnId: "turn-1",
  }));
  const adapter = new DiscordAdapter({
    api: api as unknown as DiscordApi,
    config: {
      applicationId: options.applicationId,
      channel: "discord",
      botToken: "discord-token",
      authorizedActorIds: ["42"],
    },
    gateway,
    now: () => 1000,
  });
  const controller = new MessagingController({
    adapter,
    authorizedActorIds: ["42"],
    backend: {
      getNavigationSnapshot,
      startTurn,
    },
    inputDebounceMs: 0,
    now: () => 1000,
    store,
  });

  return {
    adapter,
    api,
    controller,
    gateway,
    getNavigationSnapshot,
    startTurn,
    store,
  };
}

function createApi(options: {
  applicationCommands?: DiscordApplicationCommand[];
} = {}): {
  createApplicationCommand: ReturnType<typeof vi.fn>;
  createInteractionResponse: ReturnType<typeof vi.fn>;
  createMessage: ReturnType<typeof vi.fn>;
  deleteApplicationCommand: ReturnType<typeof vi.fn>;
  listApplicationCommands: ReturnType<typeof vi.fn>;
  pinMessage: ReturnType<typeof vi.fn>;
  sendTyping: ReturnType<typeof vi.fn>;
  unpinMessage: ReturnType<typeof vi.fn>;
  updateChannelName: ReturnType<typeof vi.fn>;
  updateApplicationCommand: ReturnType<typeof vi.fn>;
  updateInteractionOriginalResponse: ReturnType<typeof vi.fn>;
  updateMessage: ReturnType<typeof vi.fn>;
} {
  let messageSequence = 0;
  let commandSequence = options.applicationCommands?.length ?? 0;
  let applicationCommands = [...(options.applicationCommands ?? [])];
  return {
    createApplicationCommand: vi.fn(
      async (applicationId: string, command: Omit<DiscordApplicationCommand, "id">) => {
        const created = {
          ...command,
          application_id: applicationId,
          id: `cmd-${++commandSequence}`,
        } as DiscordApplicationCommand;
        applicationCommands.push(created);
        return created;
      },
    ),
    createInteractionResponse: vi.fn(
      async (
        _interactionId: string,
        _interactionToken: string,
        _request: DiscordInteractionResponseRequest,
      ) => undefined,
    ),
    createMessage: vi.fn(
      async (channelId: string, request: DiscordCreateMessageRequest) => ({
        channel_id: channelId,
        content: request.content,
        id: `message-${++messageSequence}`,
      }),
    ),
    deleteApplicationCommand: vi.fn(
      async (_applicationId: string, commandId: string) => {
        applicationCommands = applicationCommands.filter(
          (command) => command.id !== commandId,
        );
      },
    ),
    listApplicationCommands: vi.fn(
      async (_applicationId: string) => applicationCommands,
    ),
    pinMessage: vi.fn(async (_channelId: string, _messageId: string) => undefined),
    sendTyping: vi.fn(async (_channelId: string) => undefined),
    unpinMessage: vi.fn(async (_channelId: string, _messageId: string) => undefined),
    updateChannelName: vi.fn(
      async (_channelId: string, _request: { name: string }) => undefined,
    ),
    updateApplicationCommand: vi.fn(
      async (
        applicationId: string,
        commandId: string,
        command: Omit<DiscordApplicationCommand, "id">,
      ) => {
        const updated = {
          ...command,
          application_id: applicationId,
          id: commandId,
        } as DiscordApplicationCommand;
        applicationCommands = applicationCommands.map((live) =>
          live.id === commandId ? updated : live,
        );
        return updated;
      },
    ),
    updateInteractionOriginalResponse: vi.fn(
      async (
        _applicationId: string,
        _interactionToken: string,
        request: DiscordCreateMessageRequest,
      ) => ({
        channel_id: "channel-1",
        content: request.content,
        id: `message-${++messageSequence}`,
      }),
    ),
    updateMessage: vi.fn(
      async (
        channelId: string,
        messageId: string,
        request: DiscordCreateMessageRequest,
      ) => ({
        channel_id: channelId,
        content: request.content,
        id: messageId,
      }),
    ),
  };
}

function createApplicationCommand(
  id: string,
  command: Omit<DiscordApplicationCommand, "id" | "type"> & { type?: number },
): DiscordApplicationCommand {
  return {
    contexts: [0, 1, 2],
    integration_types: [0, 1],
    type: 1,
    ...command,
    application_id: "app-1",
    id,
    version: "1",
  };
}

function createGateway(): DiscordGatewayConnection & {
  emit: (event: DiscordGatewayEvent) => Promise<void>;
} {
  const listeners = new Set<DiscordGatewayListener>();
  return {
    close: vi.fn(async () => {}),
    emit: async (event: DiscordGatewayEvent) => {
      await Promise.all([...listeners].map(async (listener) => listener(event)));
    },
    onEvent: vi.fn((listener: DiscordGatewayListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    start: vi.fn(async () => {}),
  };
}

function buildNavigationSnapshot(threadCount = 2): NavigationSnapshot {
  return {
    backend: "all",
    directories: [],
    fetchedAt: 1000,
    inboxThreadKeys: [],
    launchpadDefaults: {
      backend: "codex",
      executionMode: "default",
    },
    threads: Array.from({ length: threadCount }, (_, index) => ({
      id: `thread-${index + 1}`,
      inbox: {
        inInbox: false,
      },
      linkedDirectories: [],
      source: "codex",
      title:
        index === 0
          ? "Thread one"
          : index === 1
            ? "Thread two"
            : `Thread ${index + 1}`,
      titleSource: "explicit",
    })),
    unchanged: false,
  };
}
