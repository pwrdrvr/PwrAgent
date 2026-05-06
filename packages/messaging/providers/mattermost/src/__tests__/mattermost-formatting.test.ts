import { describe, expect, it } from "vitest";
import type {
  MessagingCapabilityProfile,
  MessagingSurfaceAction,
} from "@pwragent/messaging-interface";
import {
  buildMattermostActions,
  clampMattermostMessage,
  sanitizeMattermostActionId,
  styleForMattermostAction,
  textForMattermostIntent,
  MATTERMOST_MESSAGE_TEXT_LIMIT,
} from "../mattermost-formatting.ts";

const PROFILE: MessagingCapabilityProfile = {
  actions: {
    maxActions: 25,
    maxActionsPerRow: 5,
    maxRows: 5,
    maxLabelLength: 40,
    supportsStyles: true,
    supportsDisabled: false,
    supportsLayoutHints: false,
    maxCallbackPayloadBytes: 16_000,
  },
  text: {
    maxLength: 16_383,
    encoding: "characters",
    markdownDialect: "markdown",
    supportsCodeBlocks: true,
    supportsBold: true,
    supportsItalic: true,
    supportsLinks: true,
    supportsInlineCode: true,
    supportsMessageEdit: true,
  },
};

describe("sanitizeMattermostActionId", () => {
  it("preserves alphanumeric ids unchanged", () => {
    expect(sanitizeMattermostActionId("statusModel123")).toBe("statusModel123");
  });

  it("strips non-alphanumeric characters (Mattermost route is [A-Za-z0-9]+)", () => {
    // Underscores, colons, dashes, etc. all fail the action-id route regex
    // — `command_resume` returns 404 from Mattermost's not-found handler.
    expect(sanitizeMattermostActionId("command_resume")).toBe("commandresume");
    expect(sanitizeMattermostActionId("status:detach")).toBe("statusdetach");
    expect(sanitizeMattermostActionId("handoff:cancel-now!")).toBe(
      "handoffcancelnow",
    );
  });

  it("yields a non-empty result for an all-symbol id", () => {
    expect(sanitizeMattermostActionId("...")).toMatch(/^act\d+$/);
  });
});

describe("styleForMattermostAction", () => {
  it("maps generic styles onto Mattermost keyword set", () => {
    expect(styleForMattermostAction({ id: "a", label: "A", style: "primary" })).toBe(
      "primary",
    );
    expect(styleForMattermostAction({ id: "a", label: "A", style: "danger" })).toBe(
      "danger",
    );
    expect(
      styleForMattermostAction({ id: "a", label: "A", style: "secondary" }),
    ).toBe("default");
    expect(
      styleForMattermostAction({ id: "a", label: "A", style: "navigation" }),
    ).toBe("default");
    expect(styleForMattermostAction({ id: "a", label: "A" })).toBe("default");
  });
});

describe("buildMattermostActions", () => {
  const baseActions: MessagingSurfaceAction[] = [
    { id: "status:stop", label: "Stop", style: "danger", priority: 1 },
    { id: "status:refresh", label: "Refresh", style: "secondary", priority: 2 },
    { id: "status:detach", label: "Detach", style: "danger", priority: 3 },
  ];

  it("returns undefined when no actions present", () => {
    expect(
      buildMattermostActions({
        actions: [],
        buildCallbackContext: () => ({}),
        callbackUrl: "https://callback.example.com/",
        capabilityProfile: PROFILE,
      }),
    ).toBeUndefined();
  });

  it("renders interactive buttons with sanitized ids and proper integration", () => {
    const buttons = buildMattermostActions({
      actions: baseActions,
      buildCallbackContext: (action) => ({ handle: `h-${action.id}` }),
      callbackUrl: "https://callback.example.com/cb",
      capabilityProfile: PROFILE,
    });
    expect(buttons).toHaveLength(3);
    expect(buttons?.[0]).toMatchObject({
      id: "statusstop0",
      name: "Stop",
      type: "button",
      style: "danger",
      integration: {
        url: "https://callback.example.com/cb",
        context: { handle: "h-status:stop" },
      },
    });
  });

  it("appends slot index to URL ids so chips with duplicate action.id route distinctly", () => {
    // Regression: thread_picker / project_picker / many other producers
    // emit chips that share `action.id` (e.g. "browse:select-thread")
    // and differentiate via `action.value`. Mattermost's URL routing
    // (`/api/v4/posts/{post_id}/actions/{action_id:[A-Za-z0-9]+}`)
    // matches on the URL `id` only — duplicate ids meant every click
    // resolved to the first chip's integration.context, silently
    // binding the wrong thread.
    const buttons = buildMattermostActions({
      actions: [
        { id: "browse:select-thread", label: "1. Knock Knock Rock", value: { threadId: "thread-1" } },
        { id: "browse:select-thread", label: "2. Wood chuck joke", value: { threadId: "thread-2" } },
        { id: "browse:select-thread", label: "3. Codex App Server", value: { threadId: "thread-3" } },
      ],
      buildCallbackContext: (action) => ({
        actionId: action.id,
        threadId: (action.value as { threadId?: string } | undefined)?.threadId,
      }),
      callbackUrl: "https://callback.example.com/cb",
      capabilityProfile: PROFILE,
    });
    expect(buttons).toHaveLength(3);
    const ids = buttons!.map((b) => b.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual([
      "browseselectthread0",
      "browseselectthread1",
      "browseselectthread2",
    ]);
    // The integration.context still carries the original action.id and
    // the per-chip value — handle/HMAC resolution unchanged.
    expect(buttons![1].integration.context).toEqual({
      actionId: "browse:select-thread",
      threadId: "thread-2",
    });
  });

  it("respects defensive caps from the profile", () => {
    const tightProfile: MessagingCapabilityProfile = {
      ...PROFILE,
      actions: { ...PROFILE.actions!, maxActions: 2, maxLabelLength: 4 },
    };
    const buttons = buildMattermostActions({
      actions: baseActions,
      buildCallbackContext: () => ({}),
      callbackUrl: "https://callback.example.com/cb",
      capabilityProfile: tightProfile,
    });
    expect(buttons).toHaveLength(2);
    expect(buttons?.[0].name).toBe("Stop");
    expect(buttons?.[1].name).toBe("Refr"); // truncated to maxLabelLength=4
  });

  it("filters disabled actions out before slicing to maxActions", () => {
    const buttons = buildMattermostActions({
      actions: [
        { id: "a", label: "A", disabled: true },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
      ],
      buildCallbackContext: () => ({}),
      callbackUrl: "https://callback.example.com/cb",
      capabilityProfile: PROFILE,
    });
    expect(buttons?.map((b) => b.name)).toEqual(["B", "C"]);
  });
});

describe("textForMattermostIntent", () => {
  it("renders message intent body parts", () => {
    const text = textForMattermostIntent({
      kind: "message",
      id: "x",
      createdAt: 0,
      parts: [
        { type: "text", text: "Hello", markdown: "markdown" },
        { type: "text", text: "World", markdown: "plain" },
      ],
    });
    expect(text).toContain("Hello");
    expect(text).toContain("World");
  });

  it("renders status intent text", () => {
    const text = textForMattermostIntent({
      kind: "status",
      id: "x",
      createdAt: 0,
      status: "idle",
      text: "Status: ready",
    });
    expect(text).toBe("Status: ready");
  });

  it("renders approval intent title and body", () => {
    const text = textForMattermostIntent({
      kind: "approval",
      id: "x",
      createdAt: 0,
      title: "Approve?",
      body: "Some command",
      decisions: [],
    });
    expect(text).toContain("Approve?");
    expect(text).toContain("Some command");
  });
});

describe("clampMattermostMessage", () => {
  it("returns short text unchanged", () => {
    expect(clampMattermostMessage("hello")).toBe("hello");
  });

  it("truncates long text with an ellipsis", () => {
    const long = "x".repeat(MATTERMOST_MESSAGE_TEXT_LIMIT + 100);
    const clamped = clampMattermostMessage(long);
    expect(clamped.length).toBe(MATTERMOST_MESSAGE_TEXT_LIMIT);
    expect(clamped.endsWith("…")).toBe(true);
  });
});
