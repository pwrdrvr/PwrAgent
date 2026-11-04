import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { describe, it, vi } from "vitest";
import type { BackendSummary, ThreadTodo } from "@pwragent/shared";
import { ThreadTodoCard } from "../ThreadTodoCard";
import { TodoDispatchProvider } from "../TodoDispatchProvider";
import {
  codexCatalogWithChoiceArbitrary,
  expectModelDropdownToList,
  expectedModelDropdown,
} from "../../../test/model-catalog";

/**
 * The rule the to-do picker broke before it shared the composer's: a model
 * picker lists any catalog the way `buildModelMenu` arranges it.
 */
describe("to-do dispatch model picker properties", () => {
  it("lists any Codex catalog by the shared model menu rule", async () => {
    await fc.assert(fc.asyncProperty(codexCatalogWithChoiceArbitrary, async ([models, choice]) => {
      const todo: ThreadTodo = {
        id: "card", backend: "codex", threadId: "thread-a", kind: "handoff", status: "open",
        title: "Cache the signing-key lookup", createdAt: 0, updatedAt: 0,
        action: { type: "start_thread", prompt: "Cache the key", workMode: "worktree" },
        dispatchDefaults: { thread: { backend: "codex", model: choice.id } },
      };
      const backends = [{
        kind: "codex", label: "Codex", available: true, capabilities: { createThread: true },
        launchpadOptions: { models },
      }] as BackendSummary[];
      const api = { listModelSettingsRecents: vi.fn(async () => ({ recents: [] })) };
      try {
        render(
          <TodoDispatchProvider api={api} backends={backends} todos={[todo]}>
            <ThreadTodoCard todo={todo} running={false} now={0} onRun={vi.fn()} onResolve={vi.fn()}
              onStartReview={vi.fn()} onSetItemChecked={vi.fn()} />
          </TodoDispatchProvider>,
        );
        await act(async () => {
          fireEvent.click(screen.getByRole("button", { name: /^Model for the new thread:/ }));
        });
        fireEvent.click(screen.getByRole("menuitem", { name: /^To-do model:/ }));
        const list = screen.getByRole("listbox", { name: /^To-do model/ });
        expectModelDropdownToList(list, "To-do model", expectedModelDropdown({ kind: "codex", models }));
      } finally {
        cleanup();
      }
    }), { numRuns: 20 });
  });
});
