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
});
