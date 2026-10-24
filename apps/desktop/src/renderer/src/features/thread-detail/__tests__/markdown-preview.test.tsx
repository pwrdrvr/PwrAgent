import "@testing-library/jest-dom/vitest";
import type { AppServerThreadMessageEntry } from "@pwragent/shared";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TranscriptList } from "../TranscriptList";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const onLoadOlder = async () => undefined;
const message = (text: string, id = "answer"): AppServerThreadMessageEntry => ({
  type: "message", id, role: "assistant", text,
});

function view(text: string, options: { completed?: boolean; threadId?: string; id?: string } = {}) {
  const entry = message(text, options.id);
  return (
    <TranscriptList threadId={options.threadId ?? "fixture"}
      entries={options.completed ? [entry] : []}
      pendingAssistantMessage={options.completed ? undefined : entry}
      loading={false} loadingMore={false} onLoadOlder={onLoadOlder} />
  );
}

// Includes definitions after use, constructs spanning arbitrary stream cuts,
// nested blocks, GFM, fence contents and unsafe destinations. Entire-document
// parsing must match a fresh render at every admitted preview, not just EOF.
const markdown = [
  "See [cross-block reference][ref] and **strong with _emphasis_**.",
  "",
  "3. Ordered item",
  "   - Nested `inline code`",
  "   - Second item",
  "",
  "| Key | Value |",
  "| --- | --- |",
  "| A | ~~removed~~ |",
  "",
  "```ts",
  "const literal = '**not bold**';",
  "```",
  "",
  "> Quote with [explicit link](https://example.com/path).",
  "",
  "[unsafe](javascript:alert%281%29)",
  "<script>alert('fixture')</script>",
  "",
  "[ref]: https://example.com/reference",
].join("\n");

it("matches full production Markdown rendering at arbitrary preview cuts and completion", () => {
  vi.useFakeTimers();
  const { container, rerender, unmount } = render(view(markdown.slice(0, 21)));
  for (const end of [83, 141, 209, 267, 314, markdown.length]) {
    const text = markdown.slice(0, end);
    rerender(view(text));
    act(() => vi.advanceTimersByTime(100));
    const expected = render(view(text, { completed: true, threadId: "reference" }));
    expect(container.querySelector(".transcript-message__text")?.innerHTML)
      .toBe(expected.container.querySelector(".transcript-message__text")?.innerHTML);
    expected.unmount();
  }
  rerender(view(markdown, { completed: true }));
  expect(screen.getByRole("link", { name: "cross-block reference" })).toHaveAttribute("href", "https://example.com/reference");
  expect(container.querySelector("ol")).toHaveAttribute("start", "3");
  expect(container.querySelector("ul li code")).toHaveTextContent("inline code");
  expect(container.querySelector("table del")).toHaveTextContent("removed");
  expect(container.querySelector("pre code")).toHaveTextContent("**not bold**");
  expect(container.querySelector("a[href^='javascript:'], script")).toBeNull();
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("makes progress during continuous input, flushes a trailing chunk, and flushes completion immediately", () => {
  vi.useFakeTimers();
  const { container, rerender } = render(view("Initial"));
  for (let index = 1; index <= 20; index += 1) {
    rerender(view(`Growing ${index}`));
    act(() => vi.advanceTimersByTime(10));
  }
  expect(container).toHaveTextContent("Growing 20");
  rerender(view("Trailing"));
  expect(container).not.toHaveTextContent("Trailing");
  act(() => vi.advanceTimersByTime(100));
  expect(container).toHaveTextContent("Trailing");
  rerender(view("Uncommitted preview"));
  rerender(view("Complete immediately", { completed: true }));
  expect(container).toHaveTextContent("Complete immediately");
  act(() => vi.advanceTimersByTime(100));
  expect(container).not.toHaveTextContent("Uncommitted preview");
});

it("drops pending work on thread/message switches and unmount", () => {
  vi.useFakeTimers();
  const { container, rerender, unmount } = render(view("First thread"));
  rerender(view("Private old pending snapshot"));
  // Even a reused message ID must not expose the previous thread's preview.
  rerender(view("Second thread", { threadId: "second" }));
  expect(container).toHaveTextContent("Second thread");
  expect(container).not.toHaveTextContent("First thread");
  act(() => vi.advanceTimersByTime(100));
  expect(container).not.toHaveTextContent("Private old pending snapshot");
  rerender(view("Pending second", { threadId: "second" }));
  rerender(view("New message", { threadId: "second", id: "new-answer" }));
  expect(container).toHaveTextContent("New message");
  rerender(view("Pending new message", { threadId: "second", id: "new-answer" }));
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("copies the complete final message after a paced preview", async () => {
  vi.useFakeTimers();
  const copyText = vi.fn(async () => undefined);
  const copyRichText = vi.fn(async () => undefined);
  const entry = message(markdown);
  const { rerender } = render(view("Initial"));
  rerender(view("Pending"));
  rerender(
    <TranscriptList threadId="fixture" entries={[entry]} desktopApi={{ copyText, copyRichText }}
      loading={false} loadingMore={false} onLoadOlder={onLoadOlder} />,
  );
  vi.useRealTimers();
  fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
  await waitFor(() => expect(copyRichText).toHaveBeenCalled());
  expect(copyRichText).toHaveBeenCalledWith(expect.objectContaining({ text: markdown }));
});
