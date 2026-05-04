import { describe, expect, it } from "vitest";
import {
  buildTelegramKeyboard,
  escapeTelegramHtml,
  renderTelegramHtml,
  splitTelegramHtml,
  TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
  TELEGRAM_MESSAGE_TEXT_LIMIT,
  textForTelegramIntent,
} from "../telegram-formatting.ts";

describe("telegram formatting", () => {
  it("keeps bare repo plan paths as text instead of explicit links", () => {
    const planPath =
      "docs/plans/2026-05-02-001-feat-messaging-tool-update-verbosity-plan.md";
    const rendered = textForTelegramIntent({
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
    expect(rendered).not.toContain("<a");
    expect(rendered).not.toContain("href=");
    expect(rendered).not.toContain(`http://${planPath}`);
    expect(rendered).not.toContain(`https://${planPath}`);
  });

  it("escapes HTML and preserves inline and fenced code as Telegram HTML", () => {
    const rendered = renderTelegramHtml(
      "Use `pnpm test` <now>\n\n```ts\nexpect(true).toBe(true)\n```",
      "markdown",
    );

    expect(rendered).toContain("Use <code>pnpm test</code> &lt;now&gt;");
    expect(rendered).toContain(
      "<pre><code>expect(true).toBe(true)</code></pre>",
    );
  });

  it("splits long responses under Telegram message limits", () => {
    const chunks = splitTelegramHtml(
      `${"A".repeat(TELEGRAM_MESSAGE_TEXT_LIMIT - 10)}\n${"B".repeat(100)}`,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= TELEGRAM_MESSAGE_TEXT_LIMIT)).toBe(
      true,
    );
  });

  it("builds one-button rows with short opaque callback handles", () => {
    const keyboard = buildTelegramKeyboard(
      [
        {
          id: "bind:codex:a-very-long-thread-identifier-that-would-not-fit-everywhere",
          label: "1. Long thread",
          value: {
            backend: "codex",
            threadId: "thread",
          },
        },
      ],
      () => "tg:short-handle",
    );

    expect(keyboard).toEqual({
      inline_keyboard: [
        [
          {
            text: "1. Long thread",
            callback_data: "tg:short-handle",
          },
        ],
      ],
    });
    expect(Buffer.byteLength(keyboard!.inline_keyboard[0]![0]!.callback_data, "utf8")).toBeLessThanOrEqual(
      TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
    );
  });

  it("honors explicit channel-neutral button rows", () => {
    const keyboard = buildTelegramKeyboard(
      [
        {
          id: "one",
          label: "One",
          layout: { row: 0, column: 0 },
        },
        {
          id: "two",
          label: "Two",
          layout: { row: 0, column: 1 },
        },
        {
          id: "three",
          label: "Three",
          layout: { row: 1, column: 0 },
        },
      ],
      (action) => `tg:${action.id}`,
    );

    expect(keyboard?.inline_keyboard.map((row) => row.map((button) => button.text))).toEqual([
      ["One", "Two"],
      ["Three"],
    ]);
  });

  it("honors channel-neutral automatic column hints", () => {
    const keyboard = buildTelegramKeyboard(
      [
        { id: "one", label: "One" },
        { id: "two", label: "Two" },
        { id: "three", label: "Three" },
      ],
      (action) => `tg:${action.id}`,
      { columns: 2 },
    );

    expect(keyboard?.inline_keyboard.map((row) => row.map((button) => button.text))).toEqual([
      ["One", "Two"],
      ["Three"],
    ]);
  });

  it("renders workspace handoff choices with opaque callback handles", () => {
    const intent = {
      id: "handoff-overview-1",
      kind: "single_select",
      createdAt: 1000,
      prompt: [
        "Workspace Handoff",
        "Repository: /repo/pwragent",
        "Working directory: /repo/pwragent",
        "Branch: feature/handoff",
      ].join("\n"),
      fallbackText: "Reply with 1, Back, Refresh, or Cancel.",
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
    } satisfies Parameters<typeof textForTelegramIntent>[0];

    const keyboard = buildTelegramKeyboard(
      intent.choices,
      (action) => `tg:${action.id}`,
    );

    expect(textForTelegramIntent(intent)).toContain("Workspace Handoff");
    expect(keyboard?.inline_keyboard.map((row) => row.map((button) => button.text))).toEqual([
      ["Handoff to New Worktree"],
      ["Cancel"],
    ]);
    expect(JSON.stringify(keyboard)).not.toContain("/repo/pwragent");
  });

  it("escapes plain text without introducing formatting", () => {
    expect(escapeTelegramHtml("a < b && b > c")).toBe(
      "a &lt; b &amp;&amp; b &gt; c",
    );
  });

  it("renders approval code blocks as Telegram HTML", () => {
    const rendered = textForTelegramIntent({
      id: "approval-1",
      kind: "approval",
      createdAt: 1000,
      title: "Command Approval",
      body: "Command:\n```shell\npnpm test\n```",
      decisions: [],
    });

    expect(rendered).toContain("Command Approval");
    expect(rendered).toContain("<pre><code>pnpm test</code></pre>");
  });

  it("renders generated tool update messages as ordinary escaped chat text", () => {
    const rendered = textForTelegramIntent({
      id: "tool-update-1",
      kind: "message",
      createdAt: 1000,
      role: "system",
      parts: [
        {
          type: "text",
          text: "Tool update: npm view <dive>",
          markdown: "light",
        },
      ],
    });

    expect(rendered).toBe("Tool update: npm view &lt;dive&gt;");
  });

  it("exposes the tool updates status action through generic keyboard rows", () => {
    const keyboard = buildTelegramKeyboard(
      [
        {
          id: "status:tool-updates",
          label: "Tools: Show Some",
          fallbackText: "tools",
          style: "secondary",
        },
      ],
      (action) => `tg:${action.id}`,
    );

    expect(keyboard?.inline_keyboard).toEqual([
      [
        {
          text: "Tools: Show Some",
          callback_data: "tg:status:tool-updates",
        },
      ],
    ]);
  });
});
