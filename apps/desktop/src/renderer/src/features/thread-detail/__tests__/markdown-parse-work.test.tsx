import "@testing-library/jest-dom/vitest";
import type { AppServerThreadEntry, AppServerThreadMessageEntry } from "@pwragent/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TranscriptList } from "../TranscriptList";
import { ThreadMarkdown } from "../ThreadMarkdown";
import budgets from "./fixtures/markdown-parse-budgets.json";

const work = vi.hoisted(() => ({ parses: 0, characters: 0, nodes: 0 }));

// Observe the real ReactMarkdown/unified pipeline after parsing, without
// replacing the parser or its plugins. Count cumulative UTF-16 input and mdast
// nodes, not elapsed time; these are deterministic operation budgets, not CPU.
vi.mock("../remark-table-profile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../remark-table-profile")>();
  return {
    ...actual,
    remarkTableProfile: () => {
      const transform = actual.remarkTableProfile();
      return (tree: Parameters<typeof transform>[0] & { position?: { end: { offset?: number } } }) => {
        work.parses += 1;
        work.characters += tree.position?.end.offset ?? 0;
        const count = (node: typeof tree): number =>
          1 + (node.children?.reduce((sum, child) => sum + count(child), 0) ?? 0);
        work.nodes += count(tree);
        transform(tree);
      };
    },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  work.parses = 0;
  work.characters = 0;
  work.nodes = 0;
});

const onLoadOlder = async () => undefined;
const chunk = "A contrived **answer** with `code` and [a][ref].\n\n";
const answer = (text: string): AppServerThreadMessageEntry => ({
  type: "message", id: "answer", role: "assistant", text,
});

function checkBudget(name: keyof typeof budgets) {
  expect({ ...work }, name).toEqual(budgets[name]);
}

it("owns immutable history parsing independently of refreshed transcript props", () => {
  const entries: AppServerThreadEntry[] = Array.from({ length: 6 }, (_, index) => ({
    ...answer(chunk.repeat(40)), id: `history-${index}`,
  }));
  const view = (update: number) => (
    <TranscriptList threadId="fixture" entries={entries.map((entry) => ({ ...entry }))}
      skills={[]} pendingStatusText={`Contrived update ${update}`}
      loading={false} loadingMore={false} onLoadOlder={onLoadOlder} />
  );
  const { rerender } = render(view(0));
  for (let update = 1; update <= 8; update += 1) rerender(view(update));
  checkBudget("historyRefreshes");
});

it.each([16, 32, 64] as const)("bounds real Markdown work for %i growing stream chunks", (chunks) => {
  vi.useFakeTimers();
  const view = (text: string, completed = false) => (
    <TranscriptList threadId="fixture" entries={completed ? [answer(text)] : []}
      pendingAssistantMessage={completed ? undefined : answer(text)}
      skills={[]} loading={false} loadingMore={false} onLoadOlder={onLoadOlder} />
  );
  const { rerender } = render(view(chunk));
  for (let index = 2; index <= chunks; index += 1) {
    act(() => vi.advanceTimersByTime(10));
    rerender(view(chunk.repeat(index)));
  }
  // Completion bypasses pacing and flushes the authoritative final document.
  rerender(view(chunk.repeat(chunks), true));
  checkBudget(`stream${chunks}`);
});

it.each([16, 32, 64] as const)("records necessary full-document work for %i slow chunks", (chunks) => {
  vi.useFakeTimers();
  const view = (text: string, completed = false) => (
    <TranscriptList threadId="fixture" entries={completed ? [answer(text)] : []}
      pendingAssistantMessage={completed ? undefined : answer(text)}
      loading={false} loadingMore={false} onLoadOlder={onLoadOlder} />
  );
  const { rerender } = render(view(chunk));
  for (let index = 2; index <= chunks; index += 1) {
    act(() => vi.advanceTimersByTime(110));
    rerender(view(chunk.repeat(index)));
  }
  act(() => vi.advanceTimersByTime(100));
  rerender(view(chunk.repeat(chunks), true));
  checkBudget(`slowStream${chunks}`);
});

it.each([16, 32, 64] as const)("reuses stable prose in the production transcript for %i slow chunks", (chunks) => {
  vi.useFakeTimers();
  const prose = "A contrived **answer** with `code`.\n\n";
  const view = (text: string) => (
    <TranscriptList threadId="fixture" entries={[]} pendingAssistantMessage={answer(text)}
      loading={false} loadingMore={false} onLoadOlder={onLoadOlder} />
  );
  const { rerender } = render(view(prose));
  for (let index = 2; index <= chunks; index += 1) {
    act(() => vi.advanceTimersByTime(110));
    rerender(view(prose.repeat(index)));
  }
  act(() => vi.advanceTimersByTime(100));
  checkBudget(`proseStream${chunks}`);
});

it("updates copy actions and viewer state without reparsing the owning message", async () => {
  const text = "Copy `fixture code` or [open a file](/fixture/example.md).";
  const firstCopy = vi.fn(async () => undefined);
  const latestCopy = vi.fn(async () => undefined);
  const readMarkdownFile = vi.fn(async () => ({ path: "/fixture/example.md", content: "Contrived preview" }));
  const view = (copyText = firstCopy) => (
    <ThreadMarkdown text={text} desktopApi={{ copyText, readMarkdownFile }} />
  );
  const { rerender } = render(view());
  expect(work.parses).toBe(1);
  const selectedNode = screen.getByText("fixture code", { selector: "code" });
  rerender(view(latestCopy));
  expect(screen.getByText("fixture code", { selector: "code" })).toBe(selectedNode);
  fireEvent.click(screen.getByRole("button", { name: "Copy inline code" }));
  expect(latestCopy).toHaveBeenCalledWith("fixture code");
  expect(firstCopy).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("link", { name: "open a file" }));
  await screen.findByText("Contrived preview");
  // The new preview document owns its own parse; opening/closing the modal
  // must not parse the unchanged message behind it again.
  expect(work.parses).toBe(2);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(work.parses).toBe(2);
});
