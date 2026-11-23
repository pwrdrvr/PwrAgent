import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ThreadTodo } from "@pwragent/shared/contracts/thread-todos";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadTodoCard } from "../ThreadTodoCard";
import { TodoDispatchProvider } from "../TodoDispatchProvider";
import type { ThreadTodoInstance } from "../thread-todos-view";

const OWNER: ThreadTodoInstance = { instanceId: "owner", label: "Studio", messageTarget: true, startFromMessage: true };
const OLDER_OWNER = { ...OWNER, startFromMessage: false };

afterEach(cleanup);

function selectHandoffOption(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Handoff options" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name }));
}

function setup(targetThreadId: string, items?: ThreadTodo["items"]) {
  const todo: ThreadTodo = {
    id: "remote-todo:owner:card", backend: "codex", threadId: "source", kind: "handoff", status: "open",
    title: "Bound webhook retries", createdAt: 0, updatedAt: 0,
    federationTarget: { scope: "remote", instanceId: OWNER.instanceId },
    ...(items ? { items } : {}),
    action: { type: "send_message", prompt: "Add a retry cap", target: { backend: "codex", threadId: targetThreadId } },
  };
  const onRun = vi.fn();
  const onDoHere = vi.fn(async () => true);
  const api = { getNavigationQueryPage: vi.fn() };
  const tree = (instances: ThreadTodoInstance[]) => (
    <TodoDispatchProvider api={api} backends={[]} todos={[todo]}>
      <ThreadTodoCard todo={todo} running={false} now={0} instances={instances} onRun={onRun} onDoHere={onDoHere}
        onResolve={vi.fn()} onStartReview={vi.fn()} onSetItemChecked={vi.fn()} />
    </TodoDispatchProvider>
  );
  const view = render(tree([OWNER]));
  return { updateOwners: (instances: ThreadTodoInstance[]) => view.rerender(tree(instances)), onRun, onDoHere };
}

const startButton = () => screen.getByRole<HTMLButtonElement>("button", { name: "Start thread" });

it("keeps a selected start disabled on an older owner and lets the operator switch back to Do it here", () => {
  const { updateOwners, onRun, onDoHere } = setup("source");
  selectHandoffOption("Start a new thread");
  updateOwners([]);
  expect(startButton().disabled).toBe(true);
  updateOwners([OLDER_OWNER]);

  expect(startButton().disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toContain("Update the card's PwrAgent owner");
  fireEvent.click(startButton());
  expect(onRun).not.toHaveBeenCalled();
  expect(onDoHere).not.toHaveBeenCalled();

  selectHandoffOption("Send to thread…");
  fireEvent.click(screen.getByRole("button", { name: "Do it here" }));
  expect(onDoHere).toHaveBeenCalledOnce();
  expect(onRun).not.toHaveBeenCalled();
});

it("disables a pending start confirmation when its owner loses support", () => {
  const { updateOwners, onRun } = setup("source", [
    { id: "backup", text: "Back up the fixture", checked: false, prerequisite: true },
  ]);
  selectHandoffOption("Start a new thread");
  fireEvent.click(startButton());
  expect(screen.getByText(/Start the thread anyway\?/)).toBeTruthy();

  updateOwners([OLDER_OWNER]);
  expect(startButton().disabled).toBe(true);
  fireEvent.click(startButton());
  expect(onRun).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(startButton().disabled).toBe(true);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Handoff options" }));
});

it("keeps the explicit start selected across owner capability observations", () => {
  // An owner observation can affect whether a dispatch runs. Only the operator changes its destination.
  fc.assert(fc.property(
    fc.constantFrom("source", "another-thread"),
    fc.array(fc.constantFrom<ThreadTodoInstance[]>([OWNER], [OLDER_OWNER], []), { minLength: 1, maxLength: 5 }),
    (targetThreadId, observations) => {
      cleanup();
      const { updateOwners, onRun, onDoHere } = setup(targetThreadId);
      selectHandoffOption("Start a new thread");
      for (const instances of observations) {
        updateOwners(instances);
        expect(startButton().disabled).toBe(!instances.some((instance) => instance.startFromMessage));
        expect(screen.queryByRole("button", { name: /^(Do it here|Send request)$/ })).toBeNull();
      }
      updateOwners([OWNER]);
      fireEvent.click(startButton());
      expect(onRun).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.objectContaining({ startNewThread: true }));
      expect(onDoHere).not.toHaveBeenCalled();
    },
  ), { numRuns: 25 });
});
