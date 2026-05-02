import { describe, expect, it } from "vitest";
import {
  MESSAGING_DELIVERY_OUTCOMES,
  MESSAGING_INBOUND_EVENT_KINDS,
  MESSAGING_SURFACE_INTENT_KINDS,
  MESSAGING_TOOL_UPDATE_MODES,
  layoutMessagingActionRows,
  type MessagingApprovalIntent,
  type MessagingBindingRecord,
  type MessagingBrowseSessionRecord,
  type MessagingCallbackHandleRecord,
  type MessagingInboundMediaEvent,
  type MessagingMessageIntent,
  type MessagingThreadPickerIntent,
} from "../index";

describe("messaging surface contract", () => {
  it("enumerates the first-release semantic intent and inbound event kinds", () => {
    expect(MESSAGING_SURFACE_INTENT_KINDS).toEqual([
      "activity",
      "message",
      "status",
      "progress",
      "thread_picker",
      "project_picker",
      "single_select",
      "multi_select",
      "questionnaire",
      "approval",
      "confirmation",
      "error",
      "dismiss",
    ]);
    expect(MESSAGING_INBOUND_EVENT_KINDS).toEqual([
      "text",
      "command",
      "callback",
      "media",
      "lifecycle",
    ]);
    expect(MESSAGING_DELIVERY_OUTCOMES).toContain("presented_new");
    expect(MESSAGING_DELIVERY_OUTCOMES).toContain("signaled");
    expect(MESSAGING_DELIVERY_OUTCOMES).toContain("pinned");
    expect(MESSAGING_DELIVERY_OUTCOMES).toContain("unpinned");
    expect(MESSAGING_DELIVERY_OUTCOMES).toContain("unsupported");
    expect(MESSAGING_TOOL_UPDATE_MODES).toEqual([
      "show_none",
      "show_less",
      "show_some",
      "show_more",
      "show_all",
    ]);
  });

  it("describes a thread picker without platform payload fields", () => {
    const intent = {
      id: "intent-thread-picker",
      kind: "thread_picker",
      bindingId: "binding-1",
      createdAt: 1000,
      actionLayout: {
        columns: 2,
      },
      fallbackText: "Reply with a number, Next, Back, or Cancel.",
      prompt: "Choose a thread.",
      navigation: {
        backend: "codex",
        fetchedAt: 1000,
        unchanged: false,
      },
      page: {
        pageIndex: 0,
        pageSize: 5,
        totalItems: 1,
        items: [
          {
            id: "thread-1",
            title: "Messaging plan",
            titleSource: "explicit",
            linkedDirectories: [],
            source: "codex",
            inbox: {
              inInbox: false,
            },
          },
        ],
        actions: [
          {
            id: "bind:thread-1",
            label: "Bind",
            style: "primary",
            fallbackText: "1",
          },
          {
            id: "page:next",
            label: "Next",
            style: "navigation",
            fallbackText: "next",
          },
        ],
      },
    } satisfies MessagingThreadPickerIntent;

    expect(JSON.stringify(intent)).not.toMatch(/telegram|discord|callback_data|custom_id/);
  });

  it("lays out actions with channel-neutral row hints", () => {
    const rows = layoutMessagingActionRows(
      [
        {
          action: { id: "1", label: "One" },
          component: "one",
        },
        {
          action: { id: "2", label: "Two" },
          component: "two",
        },
        {
          action: {
            id: "next",
            label: "Next",
            layout: { rowBreakBefore: true },
          },
          component: "next",
        },
        {
          action: { id: "cancel", label: "Cancel" },
          component: "cancel",
        },
      ],
      {
        maxColumns: 5,
      },
    );

    expect(rows).toEqual([["one", "two"], ["next", "cancel"]]);
  });

  it("describes mixed markdown and image message parts", () => {
    const intent = {
      id: "intent-message",
      kind: "message",
      createdAt: 1000,
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "Use `pnpm test` after the change.\n\n```ts\nexpect(ok).toBe(true)\n```",
          markdown: "markdown",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
          alt: "Generated screenshot",
          source: "assistant",
        },
      ],
    } satisfies MessagingMessageIntent;

    expect(intent.parts).toHaveLength(2);
    expect(intent.parts[0]).toMatchObject({ markdown: "markdown" });
  });

  it("keeps approval audit data separate from adapter action payloads", () => {
    const intent = {
      id: "intent-approval",
      kind: "approval",
      createdAt: 1000,
      title: "Allow command",
      body: "Run test command?",
      fallbackText: "Reply yes, no, cancel, or yes for this session.",
      audit: {
        actor: {
          platformUserId: "telegram-user-1",
          username: "display-only",
        },
        channel: {
          channel: "telegram",
          conversation: {
            id: "chat-1",
            kind: "dm",
          },
        },
        backend: "codex",
        threadId: "thread-1",
        action: "approval.requested",
        occurredAt: 1000,
      },
      decisions: [
        {
          id: "approval:accept",
          label: "Allow",
          decision: "accept",
          style: "primary",
          fallbackText: "yes",
        },
        {
          id: "approval:decline",
          label: "Decline",
          decision: "decline",
          style: "danger",
          fallbackText: "no",
        },
      ],
    } satisfies MessagingApprovalIntent;

    expect(intent.audit?.actor.platformUserId).toBe("telegram-user-1");
    expect(JSON.stringify(intent.decisions)).not.toContain("telegram-user-1");
  });

  it("marks inbound media as unsupported by default", () => {
    const event = {
      id: "event-media",
      kind: "media",
      actor: {
        platformUserId: "discord-user-1",
      },
      channel: {
        channel: "discord",
        conversation: {
          id: "channel-1",
          kind: "channel",
        },
      },
      receivedAt: 1000,
      media: {
        type: "file",
        name: "voice.m4a",
        mimeType: "audio/mp4",
      },
      disposition: "unsupported",
    } satisfies MessagingInboundMediaEvent;

    expect(event.disposition).toBe("unsupported");
  });

  it("describes restart-safe bindings, browse sessions, and callback handles", () => {
    const binding = {
      id: "binding-1",
      channel: {
        channel: "telegram",
        conversation: {
          id: "chat-1",
          kind: "dm",
        },
      },
      backend: "codex",
      threadId: "thread-1",
      authorizedActorIds: ["telegram-user-1"],
      createdAt: 1000,
      updatedAt: 1000,
      preferences: {
        executionMode: "full-access",
        fastMode: true,
        model: "gpt-5.4",
        permissionsMode: "full-access",
        reasoningEffort: "high",
        toolUpdateMode: "show_all",
        updatedAt: 1000,
      },
      statusSurface: {
        channel: "telegram",
        id: "message-1",
        state: {
          opaque: {
            chatId: 777,
            messageId: 123,
          },
        },
      },
    } satisfies MessagingBindingRecord;
    const browseSession = {
      id: "browse-1",
      allowedActorIds: ["telegram-user-1"],
      bindingId: "binding-1",
      channel: binding.channel,
      createdAt: 1000,
      updatedAt: 1000,
      expiresAt: 2000,
      launchAction: "resume_thread",
      mode: "project_threads",
      pageIndex: 1,
      pageSize: 8,
      selectedProject: {
        directoryKey: "dir:pwragnt",
        label: "PwrAgnt",
      },
      surface: binding.statusSurface,
    } satisfies MessagingBrowseSessionRecord;
    const callbackHandle = {
      id: "callback-1",
      actionId: "browse:select:2",
      allowedActorIds: ["telegram-user-1"],
      bindingId: "binding-1",
      browseSessionId: "browse-1",
      channel: binding.channel,
      createdAt: 1000,
      updatedAt: 1000,
      expiresAt: 2000,
      handle: "tg:short-handle",
      surface: binding.statusSurface,
      value: {
        threadId: "thread-1",
      },
    } satisfies MessagingCallbackHandleRecord;

    expect(callbackHandle.handle).not.toContain("thread-1");
    expect(browseSession.selectedProject?.label).toBe("PwrAgnt");
    expect(binding.preferences?.permissionsMode).toBe("full-access");
  });
});
