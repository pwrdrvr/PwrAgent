import { describe, expect, it } from "vitest";
import {
  MESSAGING_DELIVERY_OUTCOMES,
  MESSAGING_INBOUND_EVENT_KINDS,
  MESSAGING_CALLBACK_HANDLE_TTL_MS,
  MESSAGING_SURFACE_INTENT_KINDS,
  MESSAGING_TOOL_UPDATE_MODES,
  layoutMessagingActionRows,
  type MessagingDeliveryScope,
  type MessagingPlatformStatus,
  type MessagingRateLimitInfo,
  type MessagingApprovalIntent,
  type MessagingBindingRecord,
  type MessagingBrowseSessionRecord,
  type MessagingCallbackHandleRecord,
  type MessagingInboundMediaEvent,
  type MessagingMessageIntent,
  type MessagingMonitorSubscriptionRecord,
  type MessagingSingleSelectIntent,
  type MessagingStreamUpdateIntent,
  type MessagingThreadPickerIntent,
} from "../index";

describe("messaging surface contract", () => {
  it("enumerates the first-release semantic intent and inbound event kinds", () => {
    expect(MESSAGING_SURFACE_INTENT_KINDS).toEqual([
      "activity",
      "message",
      "stream_update",
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
    expect(MESSAGING_DELIVERY_OUTCOMES).toContain("discarded");
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

  it("interleaves explicit-row groups with automatic items in document order", () => {
    const rows = layoutMessagingActionRows(
      [
        { action: { id: "a", label: "A" }, component: "a" },
        { action: { id: "b", label: "B" }, component: "b" },
        { action: { id: "c", label: "C" }, component: "c" },
        {
          action: { id: "prev", label: "Prev", layout: { row: 1 } },
          component: "prev",
        },
        {
          action: { id: "next", label: "Next", layout: { row: 1 } },
          component: "next",
        },
        {
          action: { id: "cancel", label: "Cancel", layout: { row: 2 } },
          component: "cancel",
        },
      ],
      { defaultColumns: 1, maxColumns: 8 },
    );

    expect(rows).toEqual([
      ["a"],
      ["b"],
      ["c"],
      ["prev", "next"],
      ["cancel"],
    ]);
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

  it("describes assistant stream updates without backend protocol names", () => {
    const intent = {
      id: "intent-stream-1",
      kind: "stream_update",
      createdAt: 1000,
      bindingId: "binding-1",
      role: "assistant",
      markdown: "plain",
      delta: "world",
      text: "hello world",
      stream: {
        key: "codex:thread-1:turn-1:item-1:text",
        turnId: "turn-1",
        itemId: "item-1",
        sequence: 2,
        isFinal: false,
      },
      policy: "inherit",
    } satisfies MessagingStreamUpdateIntent;

    expect(intent.text).toBe("hello world");
    expect(JSON.stringify(intent)).not.toMatch(/agentMessage\/delta|telegram|discord/);
  });

  it("describes degraded platform health and provider-neutral rate scopes", () => {
    const scope = {
      platform: "telegram",
      id: "telegram:supergroup:-1003841603622",
      kind: "group",
      label: "Telegram supergroup",
      budget: {
        limit: 20,
        intervalMs: 60_000,
        reserved: 5,
      },
    } satisfies MessagingDeliveryScope;
    const rateLimit = {
      scope,
      retryAfterMs: 16_000,
      observedAt: 1_000,
    } satisfies MessagingRateLimitInfo;
    const status = {
      platform: "telegram",
      health: "degraded",
      changedAt: 1_000,
      degradationReasons: [
        {
          kind: "rate-limited",
          key: "rate-limited:telegram:supergroup:-1003841603622",
          scope: rateLimit.scope,
          retryAfterMs: rateLimit.retryAfterMs,
          startedAt: 1_000,
          expiresAt: 17_000,
        },
      ],
    } satisfies MessagingPlatformStatus;

    expect(status.health).toBe("degraded");
    expect(status.degradationReasons?.[0]).toMatchObject({
      kind: "rate-limited",
      expiresAt: 17_000,
    });
    expect(JSON.stringify(status)).not.toMatch(/callback_data|custom_id/);
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

  it("describes workspace handoff as generic single-select actions", () => {
    const intent = {
      id: "handoff-overview-1",
      kind: "single_select",
      createdAt: 1000,
      bindingId: "binding-1",
      prompt: "Workspace Handoff\nRepository: /repo/pwragent\nBranch: feature/handoff",
      fallbackText: "Reply with 1, Back, Refresh, or Cancel.",
      audit: {
        actor: {
          platformUserId: "telegram-user-1",
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
        action: "handoff.overview",
        occurredAt: 1000,
      },
      choices: [
        {
          id: "handoff:local-to-worktree",
          label: "Handoff to New Worktree",
          style: "primary",
          fallbackText: "1",
          value: {
            backend: "codex",
            threadId: "thread-1",
            direction: "local-to-worktree",
            repositoryPath: "/repo/pwragent",
            sourcePath: "/repo/pwragent",
            sourceBranch: "feature/handoff",
          },
        },
        {
          id: "handoff:cancel",
          label: "Cancel",
          style: "secondary",
          fallbackText: "cancel",
        },
      ],
    } satisfies MessagingSingleSelectIntent;

    expect(intent.choices[0]?.value).toMatchObject({
      direction: "local-to-worktree",
      repositoryPath: "/repo/pwragent",
    });
    expect(JSON.stringify(intent)).not.toMatch(/callback_data|custom_id/);
  });

  it("describes skill browsing as generic single-select actions", () => {
    const intent = {
      id: "skills-browser-1",
      kind: "single_select",
      createdAt: 1000,
      bindingId: "binding-1",
      prompt: "Skills",
      fallbackText: "Reply with a number, Search, Back, Next, Prev, or Cancel.",
      choices: [
        {
          id: "skills:select",
          label: "1. $ce:work",
          style: "secondary",
          fallbackText: "1",
          value: {
            name: "ce:work",
            path: "/skills/ce-work/SKILL.md",
            description: "Execute implementation plans",
          },
        },
        {
          id: "skills:search",
          label: "Search",
          style: "secondary",
          fallbackText: "search",
        },
        {
          id: "status:refresh",
          label: "Cancel",
          style: "secondary",
          fallbackText: "cancel",
        },
      ],
    } satisfies MessagingSingleSelectIntent;

    expect(intent.choices[0]?.value).toMatchObject({
      name: "ce:work",
      path: "/skills/ce-work/SKILL.md",
    });
    expect(JSON.stringify(intent)).not.toMatch(/callback_data|custom_id/);
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
      attachments: [
        {
          id: "attachment-1",
          kind: "audio",
          name: "voice.m4a",
          mimeType: "audio/mp4",
          disposition: "unsupported",
          reason: "audio attachments are not supported",
        },
      ],
      disposition: "unsupported",
    } satisfies MessagingInboundMediaEvent;

    expect(event.disposition).toBe("unsupported");
    expect(event.attachments[0]).toMatchObject({
      kind: "audio",
      name: "voice.m4a",
    });
  });

  it("describes available inbound attachments with opaque download state", () => {
    const event = {
      id: "media-2",
      kind: "media",
      actor: {
        platformUserId: "user-1",
      },
      channel: {
        channel: "telegram",
        conversation: {
          id: "chat-1",
          kind: "dm",
        },
      },
      receivedAt: 1000,
      text: "Please inspect this log",
      disposition: "available",
      attachments: [
        {
          id: "telegram-file-1",
          kind: "file",
          name: "streaming-logs.txt",
          mimeType: "text/plain",
          sizeBytes: 2560,
          disposition: "available",
          state: {
            opaque: {
              provider: "telegram",
              fileId: "opaque-to-core",
            },
          },
        },
      ],
    } satisfies MessagingInboundMediaEvent;

    expect(event.attachments).toHaveLength(1);
    expect(event.attachments[0]?.state?.opaque).toMatchObject({
      provider: "telegram",
    });
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
      monitor: {
        enabled: true,
        intervalMs: 60_000,
        lastRenderedAt: 1500,
        pinnedThreadLimit: 5,
        recentThreadLimit: 10,
        showLastResponseSnippet: true,
        showStatusLine: true,
        updatedAt: 1500,
      },
      monitorSurface: {
        channel: "telegram",
        id: "monitor-message-1",
        state: {
          opaque: {
            chatId: 777,
            messageId: 124,
          },
        },
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
      pendingSkillSelection: {
        name: "ce:work",
        path: "/skills/ce-work/SKILL.md",
        description: "Execute implementation plans",
        selectedActorId: "telegram-user-1",
        selectedAt: 1000,
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
        directoryKey: "dir:pwragent",
        label: "PwrAgent",
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
    const monitorSubscription = {
      id: "monitor:telegram:dm::chat-1",
      channel: binding.channel,
      authorizedActorIds: ["telegram-user-1"],
      createdAt: 1000,
      updatedAt: 1500,
      monitor: {
        enabled: true,
        intervalMs: 60_000,
        lastRenderedAt: 1500,
        pinnedThreadLimit: 5,
        recentThreadLimit: 10,
        showLastResponseSnippet: true,
        showStatusLine: true,
        updatedAt: 1500,
      },
      monitorSurface: binding.monitorSurface,
    } satisfies MessagingMonitorSubscriptionRecord;

    expect(callbackHandle.handle).not.toContain("thread-1");
    expect(browseSession.selectedProject?.label).toBe("PwrAgent");
    expect(binding.preferences?.permissionsMode).toBe("full-access");
    expect(binding.monitor?.enabled).toBe(true);
    expect(binding.monitor?.pinnedThreadLimit).toBe(5);
    expect(binding.monitor?.showStatusLine).toBe(true);
    expect(binding.monitorSurface?.id).toBe("monitor-message-1");
    expect(monitorSubscription.monitor.enabled).toBe(true);
    expect(monitorSubscription.monitor.recentThreadLimit).toBe(10);
    expect(monitorSubscription.monitor.showLastResponseSnippet).toBe(true);
    expect(monitorSubscription.monitorSurface?.id).toBe("monitor-message-1");
    expect(binding.pendingSkillSelection?.name).toBe("ce:work");
  });

  it("defines callback handles as long-lived sqlite routes", () => {
    expect(MESSAGING_CALLBACK_HANDLE_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
