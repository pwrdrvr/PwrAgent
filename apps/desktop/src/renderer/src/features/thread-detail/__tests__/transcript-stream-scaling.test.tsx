import "@testing-library/jest-dom/vitest";
import type { AppServerSkillSummary, AppServerThreadEntry } from "@pwragent/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { formatActivityText } from "../activity-path-display";
import { TranscriptList } from "../TranscriptList";
import { TranscriptWorkPhaseGroup } from "../TranscriptWorkPhaseGroup";

vi.mock("../activity-path-display", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../activity-path-display")>();
  return { ...actual, formatActivityText: vi.fn(actual.formatActivityText) };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const onLoadOlder = async () => undefined;
const paragraph = "A contrived **streaming** answer with a `code span`.\n\n";

it.each([10, 40])("does not revisit %i unchanged activity rows for each answer chunk", (count) => {
  const entries: AppServerThreadEntry[] = Array.from({ length: count }, (_, index) => ({
    type: "activity",
    id: `activity-${index}`,
    summary: `Read fixture ${index}`,
    createdAt: 1_700_000_000_000,
    details: [{ id: `detail-${index}`, kind: "read", label: `Fixture ${index}` }],
  }));
  const view = (chunks: number, history = entries, directory = "/fixture") => (
    <TranscriptList
      entries={history}
      directoryPaths={[directory]}
      loading={false}
      loadingMore={false}
      onLoadOlder={onLoadOlder}
      pendingAssistantMessage={{ type: "message", id: "answer", role: "assistant", text: paragraph.repeat(chunks) }}
    />
  );
  const { rerender } = render(view(1));
  vi.mocked(formatActivityText).mockClear();
  for (let chunk = 2; chunk <= 9; chunk += 1) rerender(view(chunk));
  expect(formatActivityText).toHaveBeenCalledTimes(0);

  // A changed row and local disclosure still render; memoization must not
  // freeze live tool status or interactions.
  const changed = [...entries];
  changed[0] = { ...entries[0], summary: "Updated fixture" } as AppServerThreadEntry;
  rerender(view(9, changed));
  expect(screen.getByRole("button", { name: "Updated fixture" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Updated fixture" }));
  expect(screen.getByRole("button", { name: "Updated fixture" })).toHaveAttribute("aria-expanded", "true");
  vi.mocked(formatActivityText).mockClear();
  rerender(view(9, changed, "/different"));
  expect(formatActivityText).toHaveBeenCalled();
});

it.each([4, 16])("bounds follow-up frame work across %i commits before a paint", (chunks) => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  let height = 480;
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => height);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(240);
  const entries: AppServerThreadEntry[] = [];
  const view = (chunk: number) => (
    <TranscriptList entries={entries} loading={false} loadingMore={false} onLoadOlder={onLoadOlder}
      pendingAssistantMessage={{ type: "message", id: "answer", role: "assistant", text: paragraph.repeat(chunk) }} />
  );
  const { rerender, unmount } = render(view(1));
  for (let chunk = 2; chunk <= chunks; chunk += 1) rerender(view(chunk));
  expect(frames.size).toBe(1);
  height = 960;
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(16));
  });
  expect(screen.getByRole("list").scrollTop).toBe(960);
  rerender(view(chunks + 1));
  unmount();
  expect(frames.size).toBe(0);
});

it("keeps activities inside an expanded work phase stable and uses the latest disclosure callback", () => {
  const entries: AppServerThreadEntry[] = Array.from({ length: 20 }, (_, index) => ({
    type: "activity",
    id: `group-activity-${index}`,
    summary: `Grouped fixture ${index}`,
    details: [{ id: `group-detail-${index}`, kind: "read", label: `Fixture ${index}` }],
  }));
  const paths = ["/fixture"];
  const skills: AppServerSkillSummary[] = [];
  const expanded = new Set<string>();
  const firstCallback = vi.fn();
  const nextCallback = vi.fn();
  const view = (onActivityExpandedChange = firstCallback) => (
    <TranscriptWorkPhaseGroup
      entries={[...entries]}
      directoryPaths={paths}
      skills={skills}
      collapsible={true}
      expanded={true}
      expandedActivityIds={expanded}
      label="Worked for 1m"
      onToggle={() => undefined}
      onActivityExpandedChange={onActivityExpandedChange}
    />
  );
  const { rerender } = render(view());
  vi.mocked(formatActivityText).mockClear();
  for (let chunk = 0; chunk < 8; chunk += 1) rerender(view());
  expect(formatActivityText).toHaveBeenCalledTimes(0);
  rerender(view(nextCallback));
  fireEvent.click(screen.getByRole("button", { name: "Grouped fixture 0" }));
  expect(firstCallback).not.toHaveBeenCalled();
  expect(nextCallback).toHaveBeenCalledWith("group-activity-0", true);
});

it("does not let a pending follow-up pull a reader back after scrolling away", () => {
  let follow: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { follow = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(960);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(240);
  render(<TranscriptList entries={[]} loading={false} loadingMore={false} onLoadOlder={onLoadOlder}
    pendingAssistantMessage={{ type: "message", id: "answer", role: "assistant", text: paragraph }} />);
  const list = screen.getByRole("list");
  list.scrollTop = 720;
  fireEvent.scroll(list);
  list.scrollTop = 100;
  fireEvent.scroll(list);
  act(() => follow?.(16));
  expect(list.scrollTop).toBe(100);
});

it("cancels the old thread frame before scheduling a follow-up for the new thread", () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextId, callback); return nextId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  let height = 480;
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => height);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(240);
  const view = (threadId: string) => <TranscriptList threadId={threadId} entries={[]} loading={false} loadingMore={false} onLoadOlder={onLoadOlder}
    pendingAssistantMessage={{ type: "message", id: `answer-${threadId}`, role: "assistant", text: paragraph }} />;
  const { rerender } = render(view("first"));
  const oldFrame = [...frames.keys()][0];
  rerender(view("second"));
  expect(frames.has(oldFrame)).toBe(false);
  expect(frames.size).toBe(1);
  height = 960;
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(16));
  });
  expect(screen.getByRole("list").scrollTop).toBe(960);
});
