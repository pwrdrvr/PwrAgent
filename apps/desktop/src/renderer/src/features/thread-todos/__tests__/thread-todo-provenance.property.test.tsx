import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { operatorTodoItemKey } from "@pwragent/shared/contracts/operator-requests";
import {
  threadTodoThreadKey,
  type ThreadTodo,
  type ThreadTodoProject,
} from "@pwragent/shared/contracts/thread-todos";
import { ThreadTodosPanel } from "../ThreadTodosPanel";
import { reviewTranscriptEntryId } from "../review-tracking";
import type { ThreadTodosView } from "../thread-todos-view";

afterEach(cleanup);

const PROJECTS: Array<ThreadTodoProject | undefined> = [
  { key: "directory:/src/pwragent", label: "PwrAgent", path: "/src/pwragent" },
  { key: "directory:/src/pwrsnap", label: "PwrSnap", path: "/src/pwrsnap" },
  undefined,
];
const THREADS = ["a", "b", "c"] as const;
const CURRENT = "codex:thread-a";

const titleOf = (threadId: string): string => `Thread ${threadId.slice("thread-".length)}`;

function createView(open: ThreadTodo[], overrides: Partial<ThreadTodosView> = {}): ThreadTodosView {
  const openByThreadKey = new Map<string, ThreadTodo[]>();
  for (const entry of open) {
    const key = threadTodoThreadKey(entry);
    openByThreadKey.set(key, [...(openByThreadKey.get(key) ?? []), entry]);
  }
  return {
    open,
    openByThreadKey,
    revision: 0,
    runningIds: new Set(),
    instances: [],
    threadTitle: (entry) => titleOf(entry.threadId),
    resolve: vi.fn(async (entry, status) => ({ ...entry, status })),
    run: vi.fn(async (entry) => entry),
    setItemChecked: vi.fn(async (entry) => entry),
    openThread: vi.fn(),
    openStartedThread: vi.fn(),
    waits: [],
    waitsByThreadKey: new Map(),
    seenKeys: new Set(open.map((entry) => operatorTodoItemKey(entry.id))),
    markSeen: vi.fn(),
    respond: vi.fn(async () => undefined),
    dismissQuestion: vi.fn(async () => undefined),
    dismissedQuestionKeys: new Set(),
    openWait: vi.fn(),
    threadTitleForKey: (threadKey) => titleOf(threadKey.slice("codex:".length)),
    threadProjectForKey: () => undefined,
    ...overrides,
  };
}

const cards = fc.uniqueArray(
  fc.record({
    id: fc.integer({ min: 0, max: 999 }),
    thread: fc.constantFrom(...THREADS),
    project: fc.constantFrom(0, 1, 2),
  }),
  { minLength: 1, maxLength: 8, selector: (entry) => entry.id },
).map((entries) => entries.map((entry): ThreadTodo => ({
  id: `todo-${entry.id}`,
  backend: "codex",
  threadId: `thread-${entry.thread}`,
  kind: "reminder",
  status: "open",
  title: `Card ${entry.id}`,
  createdAt: 1,
  updatedAt: 1,
  ...(PROJECTS[entry.project] ? { sourceProject: PROJECTS[entry.project] } : {}),
})));

describe("To-do thread provenance", () => {
  it("names every card's thread above it in All, once per thread in each project", () => {
    // Oracle: a card's thread is the one it was raised in. In All, the
    // nearest thread heading above each card names that thread, each thread
    // heads one run per project, and the thread on screen leads and is
    // marked.
    fc.assert(fc.property(cards, (open) => {
      cleanup();
      render(
        <ThreadTodosPanel
          view={createView(open)}
          threadKey={CURRENT}
          projectKey={PROJECTS[0]!.key}
          onStartReview={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole("tab", { name: /^All/ }));
      for (const card of open) {
        const title = screen.getByText(card.title);
        const run = title.closest(".thread-todos-panel__thread");
        expect(run, card.title).not.toBeNull();
        const heading = within(run as HTMLElement).getAllByRole("heading", { level: 5 })[0]!;
        const mine = threadTodoThreadKey(card) === CURRENT;
        expect(heading.textContent).toBe(`${titleOf(card.threadId)}${mine ? "This thread" : ""}`);
      }
      for (const group of document.querySelectorAll(".thread-todos-panel__group")) {
        const names = [...group.querySelectorAll(".thread-todos-panel__thread-name")]
          .map((name) => name.textContent);
        expect(new Set(names).size).toBe(names.length);
        if (names.includes(titleOf("thread-a"))) expect(names[0]).toBe(titleOf("thread-a"));
      }
    }), { numRuns: 40 });
  });

  it("opens another thread from its heading", () => {
    const other: ThreadTodo = {
      id: "other", backend: "codex", threadId: "thread-b", kind: "reminder",
      status: "open", title: "Elsewhere", createdAt: 1, updatedAt: 1,
    };
    const view = createView([other]);
    render(<ThreadTodosPanel view={view} threadKey={CURRENT} onStartReview={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: /^All/ }));
    fireEvent.click(screen.getByRole("button", { name: "Open thread: Thread b" }));
    expect(view.openThread).toHaveBeenCalledWith(other);
  });

  it("shows a review row's review rather than only opening its thread", () => {
    const review: ThreadTodo = {
      id: "review-todo", reviewId: "review-1", backend: "codex", threadId: "thread-b", kind: "review",
      status: "open", title: "Review of PR #12", createdAt: 1, updatedAt: 1,
    };
    const openReview = vi.fn();
    const view = createView([review], { openReview });
    render(<ThreadTodosPanel view={view} threadKey={CURRENT} onStartReview={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: /^All/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Show review: Review of PR #12/ }));
    expect(openReview).toHaveBeenCalledWith(review);
    expect(view.openThread).not.toHaveBeenCalled();
  });

  it("makes the thread on screen's review card title show its review", () => {
    const review: ThreadTodo = {
      id: "review-todo", reviewId: "review-1", backend: "codex", threadId: "thread-a", kind: "review",
      status: "open", title: "Code review", createdAt: 1, updatedAt: 1,
    };
    const openReview = vi.fn();
    render(
      <ThreadTodosPanel view={createView([review], { openReview })} threadKey={CURRENT} onStartReview={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show review in transcript: Code review" }));
    expect(openReview).toHaveBeenCalledWith(review);
  });

  it("names the machine when two project headings would read the same", () => {
    const project: ThreadTodoProject = { key: "directory:/src/pwragent", label: "PwrAgent", path: "/src/pwragent" };
    const local: ThreadTodo = {
      id: "local", backend: "codex", threadId: "thread-b", kind: "reminder", status: "open",
      title: "Here", createdAt: 1, updatedAt: 1, sourceProject: project,
    };
    const remote: ThreadTodo = {
      ...local, id: "remote", threadId: "thread-c", title: "There",
      federationTarget: { scope: "remote", instanceId: "peer" },
    };
    render(
      <ThreadTodosPanel
        view={createView([local, remote], {
          instances: [{ instanceId: "peer", label: "M5 Max" }],
          localMachine: { label: "M2 Max" },
        })}
        threadKey={CURRENT}
        onStartReview={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /^All/ }));
    expect(screen.getAllByRole("heading", { level: 4 }).map((heading) =>
      heading.querySelector(".thread-todos-panel__group-name")?.textContent))
      .toEqual(["PwrAgent · M2 Max", "PwrAgent · M5 Max"]);
  });

  it("names the directory when two same-named projects share a machine", () => {
    const checkout: ThreadTodo = {
      id: "checkout", backend: "codex", threadId: "thread-b", kind: "reminder", status: "open",
      title: "Here", createdAt: 1, updatedAt: 1,
      sourceProject: { key: "directory:/src/github/PwrAgnt", label: "PwrAgnt", path: "/src/github/PwrAgnt" },
    };
    const worktree: ThreadTodo = {
      ...checkout, id: "worktree", threadId: "thread-c", title: "There",
      sourceProject: { key: "directory:/wt/abc/PwrAgnt", label: "PwrAgnt", path: "/wt/abc/PwrAgnt" },
    };
    render(<ThreadTodosPanel view={createView([checkout, worktree])} threadKey={CURRENT} onStartReview={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: /^All/ }));
    expect(screen.getAllByRole("heading", { level: 4 }).map((heading) =>
      heading.querySelector(".thread-todos-panel__group-name")?.textContent))
      .toEqual(["PwrAgnt · github/PwrAgnt", "PwrAgnt · abc/PwrAgnt"]);
  });

  it("anchors only reviews imported from the transcript", () => {
    // A key that names no entry would page the whole history looking for it.
    expect(reviewTranscriptEntryId({ origin: "automatic", sourceKey: "item-1" })).toBe("item-1");
    expect(reviewTranscriptEntryId({ origin: "explicit", sourceKey: "https://example.test/r/1" })).toBeUndefined();
    expect(reviewTranscriptEntryId({ sourceKey: "https://example.test/r/1" })).toBeUndefined();
  });
});
