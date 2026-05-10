import { describe, expect, it } from "vitest";
import {
  buildDiscordComponents,
  DISCORD_COMPONENT_CUSTOM_ID_LIMIT_BYTES,
  DISCORD_MESSAGE_CONTENT_LIMIT,
  sanitizeDiscordContent,
  splitDiscordContent,
  textForDiscordIntent,
} from "../discord-formatting.ts";

describe("discord formatting", () => {
  it("keeps bare repo plan paths as plain content instead of explicit links", () => {
    const planPath =
      "docs/plans/2026-05-02-001-feat-messaging-tool-update-verbosity-plan.md";
    const rendered = textForDiscordIntent({
      id: "message-1",
      kind: "message",
      createdAt: 1000,
      role: "assistant",
      parts: [
        {
          type: "text",
          text: `Use ${planPath} for the fix.`,
          markdown: "markdown",
        },
      ],
    });

    expect(rendered).toContain(planPath);
    expect(rendered).not.toContain(`[${planPath}]`);
    expect(rendered).not.toContain(`http://${planPath}`);
    expect(rendered).not.toContain(`https://${planPath}`);
  });

  it("preserves markdown while neutralizing broad mentions", () => {
    expect(
      sanitizeDiscordContent("Run `pnpm test`\n```ts\nexpect(true)\n```\n@everyone <@123> <@&456>"),
    ).toBe(
      "Run `pnpm test`\n```ts\nexpect(true)\n```\n@ everyone @user:123 @role:456",
    );
  });

  it("keeps mention neutralization separate from bare path text", () => {
    const planPath =
      "docs/plans/2026-05-02-001-feat-messaging-tool-update-verbosity-plan.md";

    expect(sanitizeDiscordContent(`@everyone use ${planPath}`)).toBe(
      `@ everyone use ${planPath}`,
    );
  });

  it("splits long content with continuation markers", () => {
    const chunks = splitDiscordContent("A".repeat(DISCORD_MESSAGE_CONTENT_LIMIT + 50));

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain("[continued]");
    expect(chunks.every((chunk) => chunk.length <= DISCORD_MESSAGE_CONTENT_LIMIT)).toBe(
      true,
    );
  });

  it("builds button components with opaque custom IDs", () => {
    const components = buildDiscordComponents(
      [
        {
          id: "bind:codex:a-very-long-thread-identifier",
          label: "1. Thread",
          style: "primary",
        },
      ],
      () => "dc:abcdefghijklmnopqrstuvwx",
    );

    expect(components).toEqual([
      {
        components: [
          {
            custom_id: "dc:abcdefghijklmnopqrstuvwx",
            label: "1. Thread",
            style: 1,
            type: 2,
          },
        ],
        type: 1,
      },
    ]);
    expect(Buffer.byteLength(components![0]!.components[0]!.custom_id, "utf8")).toBeLessThanOrEqual(
      DISCORD_COMPONENT_CUSTOM_ID_LIMIT_BYTES,
    );
  });

  it("honors channel-neutral button row hints", () => {
    const components = buildDiscordComponents(
      [
        {
          id: "thread-1",
          label: "1. Thread",
          style: "primary",
        },
        {
          id: "thread-2",
          label: "2. Thread",
          style: "primary",
        },
        {
          id: "next",
          label: "Next",
          layout: { rowBreakBefore: true },
          style: "navigation",
        },
        {
          id: "projects",
          label: "Projects",
          layout: { rowBreakBefore: true },
          style: "navigation",
        },
        {
          id: "cancel",
          label: "Cancel",
          style: "secondary",
        },
      ],
      () => "dc:abcdefghijklmnopqrstuvwx",
    );

    expect(components?.map((row) => row.components.map((button) => button.label))).toEqual([
      ["1. Thread", "2. Thread"],
      ["Next"],
      ["Projects", "Cancel"],
    ]);
  });

  it("honors channel-neutral automatic column hints", () => {
    const components = buildDiscordComponents(
      [
        { id: "one", label: "One" },
        { id: "two", label: "Two" },
        { id: "three", label: "Three" },
      ],
      () => "dc:abcdefghijklmnopqrstuvwx",
      { columns: 2 },
    );

    expect(components?.map((row) => row.components.map((button) => button.label))).toEqual([
      ["One", "Two"],
      ["Three"],
    ]);
  });

  it("renders workspace handoff choices inside component limits", () => {
    const intent = {
      id: "handoff-overview-1",
      kind: "single_select",
      createdAt: 1000,
      prompt: [
        "Workspace Handoff",
        "Repository: /repo/pwragent",
        "Working directory: /repo/pwragent/.worktrees/pwragent-feature-handoff",
        "Branch: feature/handoff",
      ].join("\n"),
      fallbackText: "Reply with 1, Back, Refresh, or Cancel.",
      choices: [
        {
          id: "handoff:worktree-to-local",
          label: "Handoff to Local",
          style: "primary",
          fallbackText: "1",
          value: {
            backend: "codex",
            threadId: "thread-1",
            direction: "worktree-to-local",
            repositoryPath: "/repo/pwragent",
            sourcePath: "/repo/pwragent/.worktrees/pwragent-feature-handoff",
            sourceBranch: "feature/handoff",
          },
        },
        {
          id: "status:refresh",
          label: "Back",
          style: "secondary",
          fallbackText: "back",
        },
        {
          id: "status:refresh",
          label: "Refresh",
          style: "secondary",
          fallbackText: "refresh",
        },
        {
          id: "handoff:cancel",
          label: "Cancel",
          style: "secondary",
          fallbackText: "cancel",
        },
      ],
    } satisfies Parameters<typeof textForDiscordIntent>[0];

    const components = buildDiscordComponents(
      intent.choices,
      () => "dc:abcdefghijklmnopqrstuvwx",
    );

    expect(textForDiscordIntent(intent)).toContain("Workspace Handoff");
    expect(components).toHaveLength(1);
    expect(components?.[0]?.components.map((button) => button.label)).toEqual([
      "Handoff to Local",
      "Back",
      "Refresh",
      "Cancel",
    ]);
    expect(JSON.stringify(components)).not.toContain("/repo/pwragent");
  });

  it("preserves approval markdown code blocks", () => {
    const rendered = textForDiscordIntent({
      id: "approval-1",
      kind: "approval",
      createdAt: 1000,
      title: "Command Approval",
      body: "Command:\n```shell\npnpm test\n```",
      decisions: [],
    });

    expect(rendered).toContain("```shell\npnpm test\n```");
  });

  it("renders generated batched tool update messages with line breaks", () => {
    const rendered = textForDiscordIntent({
      id: "tool-update-batch-1",
      kind: "message",
      createdAt: 1000,
      role: "system",
      parts: [
        {
          type: "text",
          text: "Tool updates: ran 2 tools\n- pnpm test\n- Failed: tsc",
          markdown: "light",
        },
      ],
    });

    expect(rendered).toBe("Tool updates: ran 2 tools\n- pnpm test\n- Failed: tsc");
  });

  it("renders status actions with caller-provided opaque custom IDs", () => {
    const components = buildDiscordComponents(
      [
        {
          id: "status:tool-updates",
          label: "Tools: Show Some",
          fallbackText: "tools",
          style: "secondary",
        },
      ],
      () => "dc:abcdefghijklmnopqrstuvwx",
    );

    expect(components).toEqual([
      {
        components: [
          {
            custom_id: "dc:abcdefghijklmnopqrstuvwx",
            label: "Tools: Show Some",
            style: 2,
            type: 2,
          },
        ],
        type: 1,
      },
    ]);
  });

  it("rejects semantic ids in Discord custom IDs", () => {
    expect(() =>
      buildDiscordComponents(
        [
          {
            id: "status:streaming",
            label: "Stream: Default",
          },
        ],
        (action) => `dc:${action.id}`,
      ),
    ).toThrow("Discord component custom_id must be an opaque persisted handle.");
  });
});
