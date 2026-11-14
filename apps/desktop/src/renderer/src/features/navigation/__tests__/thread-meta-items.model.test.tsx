import { memo } from "react";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import { operatorQuestionItemKey, operatorTodoItemKey, threadTodoThreadKey, type NavigationThreadSummary, type ThreadTodo } from "@pwragent/shared";
import { OperatorWaitsContext } from "../../operator-requests/useOperatorRequests";
import type { OperatorWait } from "../../operator-requests/operator-waits";
import { ThreadTodoCountsContext } from "../../thread-todos/useThreadTodos";
import { ThreadTodoRevealContext } from "../../thread-todos/thread-todo-reveal";
import { ThreadDependencyIndicatorsContext, threadDependencyIndicatorKey } from "../../thread-dependencies/useThreadDependencyIndicators";
import { ThreadMetaChips } from "../ThreadMetaChips";

afterEach(cleanup);

it("agrees with owner items after generated local/remote changes, seen marks and action replacements", () => {
  // Model: each owner has an optional question and card, and independent seen
  // facts. A row shows their sum and exactly the unseen subset, even when the
  // two owners use the same provider thread id.
  fc.assert(fc.property(fc.array(fc.record({
    owner: fc.integer({ min: 0, max: 1 }),
    action: fc.constantFrom("question", "todo", "seen", "resolve", "dependency", "actions", "ready"),
  }), { minLength: 10, maxLength: 30, size: "max" }), (commands) => {
    const threads: NavigationThreadSummary[] = [undefined, { scope: "remote" as const, instanceId: "peer" }].map((target) => ({
      source: "codex", id: "same", title: "Contrived", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
      ...(target ? { federation: { instanceLabel: "Peer", ref: { backend: "codex", threadId: "same", target } } } : {}),
    }));
    const states = threads.map(() => ({ wait: undefined as OperatorWait | undefined, todo: undefined as ThreadTodo | undefined,
      seen: new Set<string>(), dependency: false }));
    let ready = false;
    let openWait = vi.fn();
    let reveal = vi.fn();
    let openDependency = vi.fn();
    const Rows = memo(function Rows() {
      return <>{threads.map((thread, i) => <div data-owner={i} key={i}><ThreadMetaChips thread={thread} hasInputRequest /></div>)}</>;
    });
    const tree = () => {
      const waits = new Map<string, OperatorWait[]>();
      const todos = new Map<string, ThreadTodo[]>();
      states.forEach((state, i) => {
        if (state.wait) waits.set(threadTodoThreadKey({ backend: "codex", threadId: "same",
          federationTarget: i ? { scope: "remote", instanceId: "peer" } : undefined }), [state.wait]);
        if (state.todo) todos.set(threadTodoThreadKey(state.todo), [state.todo]);
      });
      const seenKeys = new Set(states.flatMap((state) => [...state.seen]));
      const dependencies = new Map(states.flatMap((state, i) => state.dependency
        ? [[threadDependencyIndicatorKey("codex", "same", i ? "peer" : undefined), {
          count: 1, label: "Merge held", alert: false, tooltip: "Contrived merge wait", mergeHeld: true,
        }] as const] : []));
      return <ThreadTodoCountsContext.Provider value={todos}>
        <OperatorWaitsContext.Provider value={ready ? { waitsByThreadKey: waits, seenKeys, openWait } : undefined}>
          <ThreadDependencyIndicatorsContext.Provider value={{ byThreadKey: dependencies, open: openDependency }}>
            <ThreadTodoRevealContext.Provider value={reveal}><Rows /></ThreadTodoRevealContext.Provider>
          </ThreadDependencyIndicatorsContext.Provider>
        </OperatorWaitsContext.Provider>
      </ThreadTodoCountsContext.Provider>;
    };
    const view = render(tree());
    try {
      for (const [step, command] of commands.entries()) {
        const state = states[command.owner]!;
        const federationTarget = command.owner ? { scope: "remote" as const, instanceId: "peer" } : undefined;
        if (command.action === "ready") ready = true;
        if (command.action === "question") {
          state.wait = { backend: "codex", threadId: "same", federationTarget,
            key: operatorQuestionItemKey("codex", "same", String(step), federationTarget),
            threadKey: threadTodoThreadKey({ backend: "codex", threadId: "same", federationTarget }),
            kind: "question", title: `Question ${step}`, createdAt: step };
        }
        if (command.action === "todo") {
          state.todo = { id: `${command.owner}:${step}`, backend: "codex", threadId: "same", federationTarget,
            kind: "reminder", status: "open", title: `Card ${step}`, createdAt: step, updatedAt: step };
        }
        if (command.action === "seen") {
          if (state.wait) state.seen.add(state.wait.key);
          if (state.todo) state.seen.add(operatorTodoItemKey(state.todo.id));
        }
        if (command.action === "resolve") { state.wait = undefined; state.todo = undefined; }
        if (command.action === "dependency") state.dependency = !state.dependency;
        if (command.action === "actions") { openWait = vi.fn(); reveal = vi.fn(); openDependency = vi.fn(); }
        view.rerender(tree());
        states.forEach((owner, i) => {
          const row = view.container.querySelector(`[data-owner="${i}"]`)! as HTMLElement;
          const count = Number(Boolean(owner.todo)) + Number(ready && Boolean(owner.wait));
          const unread = ready ? Number(Boolean(owner.wait && !owner.seen.has(owner.wait.key)))
            + Number(Boolean(owner.todo && !owner.seen.has(operatorTodoItemKey(owner.todo.id)))) : 0;
          const chip = row.querySelector("[data-thread-todos]");
          expect(chip?.getAttribute("data-thread-todos") ?? "0").toBe(String(count));
          expect(chip?.getAttribute("data-unread") ?? "0").toBe(String(unread));
          expect(within(row).queryByLabelText("Input needed") !== null).toBe(!ready || !owner.wait);
          if (ready && owner.wait) {
            fireEvent.click(within(row).getByRole("button", { name: `Question: ${owner.wait.title}` }));
            expect(openWait).toHaveBeenLastCalledWith(owner.wait);
          }
          if (count) { fireEvent.click(chip!); expect(reveal).toHaveBeenLastCalledWith(threads[i]); }
          const dependencyChip = within(row).queryByRole("button", { name: "Continue after: Merge held" });
          expect(Boolean(dependencyChip)).toBe(owner.dependency);
          if (dependencyChip) { fireEvent.click(dependencyChip); expect(openDependency).toHaveBeenLastCalledWith(threads[i]); }
        });
      }
    } finally { view.unmount(); }
  }), { numRuns: 25 });
});
