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
    const main = within(app.getByRole("main"));
    const sidebar = app.getByRole("complementary", { name: "Threads" });
    const row = (index: number) => within(sidebar).getByRole("button", { name: threads[index]!.title });

    const checkSelection = async (index: number) => {
      const { id, source } = threads[index]!;
      const activeKeys = [...sidebar.querySelectorAll("[data-thread-key] > .thread-row.is-selected")]
        .map((card) => card.parentElement?.dataset.threadKey);
      expect(activeKeys).toEqual([`${source}:${id}`]);
      expect([...sidebar.querySelectorAll(".thread-row__open[aria-current='true']")]).toEqual([row(index)]);
      await main.findByText(transcriptText(id));
      expect(main.queryByText(transcriptText(threads[1 - index]!.id))).toBeNull();
    };

    await main.findByText(transcriptText(threads[0]!.id));
    await checkSelection(0);
    await fc.assert(fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 7 }), async (actions) => {
      signal.throwIfAborted();
      // Start each generated case at a known history suffix with batch state cleared.
      // Staying within the suffix makes shrinking independent of older visits.
      for (const index of [1, 0]) {
        await act(async () => { fireEvent.click(row(index)); });
        await checkSelection(index);
      }
      const visits = [1, 0];
      let cursor = 1;
      for (const command of actions) {
        signal.throwIfAborted();
        const other = 1 - visits[cursor]!;
        await act(async () => {
          switch (command) {
            case "open":
              fireEvent.click(row(other));
              if (visits.at(-1) !== other) visits.push(other);
              cursor = visits.length - 1;
              break;
            case "back":
              if (cursor > 0) {
                fireEvent.click(app.getByTestId("history-nav-back"));
                cursor -= 1;
              }
              break;
            case "forward":
              fireEvent.click(app.getByTestId("history-nav-forward"));
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
          const menu = app.getByRole("menu");
          try {
            await checkSelection(visits[cursor]!);
          } finally {
            fireEvent.keyDown(menu, { key: "Escape" });
          }
        }
        await checkSelection(visits[cursor]!);
      }
    }), { numRuns: 12 });
  } finally {
    app.unmount();
    if (previous) Object.defineProperty(window, "pwragent", previous);
    else Reflect.deleteProperty(window, "pwragent");
  }
});
