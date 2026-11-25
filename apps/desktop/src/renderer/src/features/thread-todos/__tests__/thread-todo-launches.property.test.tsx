import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { threadTodoThreadKey, type ThreadTodo } from "@pwragent/shared/contracts/thread-todos";
import { THREAD_TODO_LAUNCH_DISMISS_MS, ThreadTodoLaunchTray } from "../ThreadTodoLaunchTray";
import { launchThreadTodo, resetThreadTodoLaunchesForTests, useThreadTodoLaunches } from "../thread-todo-launches";

const card: ThreadTodo = {
  id: "retry-queue",
  backend: "acp:antigravity",
  threadId: "webhook-delivery",
  federationTarget: { scope: "remote", instanceId: "fixture-owner" },
  kind: "handoff",
  status: "open",
  title: "Bound the retry queue",
  action: { type: "start_thread", prompt: "Bound queued delivery retries." },
  createdAt: 0,
  updatedAt: 0,
};

function SourceTray() {
  const { launches } = useThreadTodoLaunches(threadTodoThreadKey(card));
  return (
    <ThreadTodoLaunchTray
      launches={launches}
      onOpenThread={() => {}}
      onReturnCard={() => {}}
      onClose={() => {}}
    />
  );
}

function startFromSource() {
  const { rerender } = render(<SourceTray />);
  let complete!: (todo: ThreadTodo) => void;
  const reply = new Promise<ThreadTodo>((resolve) => { complete = resolve; });
  act(() => {
    void launchThreadTodo({ todo: card, threadKey: threadTodoThreadKey(card) }, (begin) => {
      begin();
      return reply;
    });
  });
  return {
    focusSource: (visible: boolean) => rerender(visible ? <SourceTray /> : <div>Another thread</div>),
    succeed: () => act(async () => {
      complete({ ...card, status: "done", startedThread: { backend: card.backend, threadId: "retry-worker" } });
    }),
  };
}

function elapse(ms: number) {
  act(() => { vi.advanceTimersByTime(ms); });
}

function hasStartedNotice() {
  return screen.queryByRole("button", { name: `Open thread: ${card.title}` }) !== null;
}

afterEach(() => {
  cleanup();
  resetThreadTodoLaunchesForTests();
  vi.useRealTimers();
});

it("lets only time paused in the visible tray extend a success's lifetime", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const lifetime = THREAD_TODO_LAUNCH_DISMISS_MS;
  await fc.assert(fc.asyncProperty(
    fc.boolean(),
    fc.array(fc.record({
      readingMs: fc.nat(lifetime),
      pauseMs: fc.nat(lifetime * 2),
      awayMs: fc.nat(lifetime),
    })),
    async (settleWhileAway, visits) => {
      const viewer = startFromSource();
      try {
        if (settleWhileAway) viewer.focusSource(false);
        await viewer.succeed();
        // The owner replied. Consume the same time budget whether the
        // source thread stays selected or the viewer visits another thread.
        let timeSpent = 0;
        for (const { readingMs, pauseMs, awayMs } of visits) {
          viewer.focusSource(true);
          expect(hasStartedNotice()).toBe(timeSpent < lifetime);
          elapse(readingMs);
          timeSpent += readingMs;
          const tray = screen.queryByRole("region", { name: "Started to-dos" });
          if (tray) fireEvent.pointerEnter(tray);
          elapse(pauseMs);
          expect(hasStartedNotice()).toBe(timeSpent < lifetime);

          viewer.focusSource(false);
          elapse(awayMs);
          timeSpent += awayMs;
        }
        viewer.focusSource(false);
        elapse(Math.max(0, lifetime - timeSpent));
        viewer.focusSource(true);
        expect(hasStartedNotice()).toBe(false);
      } finally {
        cleanup();
        resetThreadTodoLaunchesForTests();
      }
    },
  ), { numRuns: 25 });
});

it.each([false, true])("does not replay an expired success on return (completed while away: %s)", async (settleWhileAway) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const viewer = startFromSource();
  if (settleWhileAway) viewer.focusSource(false);
  await viewer.succeed();
  viewer.focusSource(false);
  elapse(THREAD_TODO_LAUNCH_DISMISS_MS);

  viewer.focusSource(true);
  expect(hasStartedNotice()).toBe(false);
});
