import { act, fireEvent, render, within } from "@testing-library/react";
import fc from "fast-check";
import { expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { App } from "../App";
import { navigationOwnerApiFixture } from "../test/navigation-owner-api-fixture";

// Warm the real transcript tree during collection, as in app-shell.test.tsx.
await import("../features/thread-detail/ThreadView");

const threads: NavigationThreadSummary[] = [
  { id: "first", source: "codex", title: "First fixture thread", titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: false }, updatedAt: 2 },
  { id: "second", source: "acp:antigravity", title: "Second fixture thread", titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: false }, updatedAt: 1 },
];
const transcriptText = (id: string) => `Transcript for fixture ${id}`;

it("keeps the active row and transcript on the same thread through navigation and row actions", async ({ signal }) => {
  const action = fc.constantFrom("open", "back", "forward", "context menu", "toggle batch");
  const previous = Object.getOwnPropertyDescriptor(window, "pwragent");
  Object.defineProperty(window, "pwragent", { configurable: true, value: navigationOwnerApiFixture({
    readPopulation: async () => ({ backend: "all", fetchedAt: 1, unchanged: false,
      inboxThreadKeys: threads.map(({ source, id }) => `${source}:${id}`), threads, directories: [],
      launchpadDefaults: { backend: "codex", executionMode: "default" } }),
    readThread: async ({ backend = "codex", threadId }) => ({ backend, threadId, fetchedAt: 1,
      replay: {
        entries: [{ type: "message", id: `message-${threadId}`, role: "assistant", text: transcriptText(threadId) }],
        messages: [], pagination: { supportsPagination: false, hasPreviousPage: false },
      },
    }),
  }) });
  const app = render(<App />);
  try {
    const mainEl = app.getByRole("main");
    const main = within(mainEl);
    const sidebar = app.getByRole("complementary", { name: "Threads" });
    const threadKey = (index: number) => `${threads[index]!.source}:${threads[index]!.id}`;
    const row = (index: number) => {
      const button = sidebar.querySelector<HTMLButtonElement>(
        `[data-thread-key="${threadKey(index)}"] .thread-row__open`,
      );
      if (!button) throw new Error(`Missing sidebar row button for ${threadKey(index)}`);
      return button;
    };

    const checkSelection = async (index: number) => {
      const expectedKey = threadKey(index);
      const expectedText = transcriptText(threads[index]!.id);
      const otherText = transcriptText(threads[1 - index]!.id);
      const activeKeys = [...sidebar.querySelectorAll("[data-thread-key] > .thread-row.is-selected")]
        .map((card) => card.parentElement?.dataset.threadKey);
      expect(activeKeys).toEqual([expectedKey]);
      expect([...sidebar.querySelectorAll(".thread-row__open[aria-current='true']")]).toEqual([row(index)]);
      if (!mainEl.textContent?.includes(expectedText)) {
        await main.findByText(expectedText);
      }
      expect(mainEl.textContent).toContain(expectedText);
      expect(mainEl.textContent).not.toContain(otherText);
    };

    await main.findByText(transcriptText(threads[0]!.id));
    for (const [index, thread] of threads.entries()) {
      expect(within(sidebar).getByRole("button", { name: thread.title })).toBe(row(index));
    }
    await checkSelection(0);
    const navButton = (testId: string) => {
      const button = mainEl.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
      if (!button) throw new Error(`Missing navigation button ${testId}`);
      return button;
    };

    await fc.assert(fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 5 }), async (actions) => {
      signal.throwIfAborted();
      // Start each generated case at a known two-visit suffix with no forward
      // history and batch state cleared, so shrinking stays independent of
      // older runs without forcing two full thread switches every run.
      const current = mainEl.textContent?.includes(transcriptText(threads[0]!.id)) ? 0 : 1;
      const start = navButton("history-nav-back").disabled || !navButton("history-nav-forward").disabled
        ? 1 - current
        : current;
      await act(async () => { fireEvent.click(row(start)); });
      await checkSelection(start);
      const visits = [1 - start, start];
      let cursor = 1;
      for (const command of actions) {
        signal.throwIfAborted();
        const other = 1 - visits[cursor]!;
        await act(async () => {
          switch (command) {
            case "open":
              fireEvent.click(row(other));
              visits.splice(cursor + 1);
              visits.push(other);
              cursor = visits.length - 1;
              break;
            case "back":
              if (cursor > 0) {
                fireEvent.click(navButton("history-nav-back"));
                cursor -= 1;
              }
              break;
            case "forward":
              fireEvent.click(navButton("history-nav-forward"));
              cursor = Math.min(visits.length - 1, cursor + 1);
              break;
            case "context menu":
              fireEvent.contextMenu(row(other));
              break;
            case "toggle batch":
              fireEvent.click(row(other), { metaKey: true });
              break;
          }
        });
        if (command === "context menu") {
          const menu = app.container.ownerDocument.querySelector<HTMLElement>("[role='menu']");
          expect(menu).not.toBeNull();
          try {
            await checkSelection(visits[cursor]!);
          } finally {
            fireEvent.keyDown(menu!, { key: "Escape" });
          }
        }
        await checkSelection(visits[cursor]!);
      }
    }), { numRuns: 10 });
  } finally {
    app.unmount();
    if (previous) Object.defineProperty(window, "pwragent", previous);
    else Reflect.deleteProperty(window, "pwragent");
  }
});
