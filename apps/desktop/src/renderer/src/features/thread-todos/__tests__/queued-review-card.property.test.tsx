import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import type {
  ScheduledThreadAction,
  ScheduledThreadActionStatus,
} from "@pwragent/shared/contracts/scheduled-thread-actions";
import type { ThreadTodo } from "@pwragent/shared/contracts/thread-todos";
import { remoteThreadTodoId } from "@pwragent/shared/contracts/thread-todos";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { useComposerDraftStore } from "../../composer/useComposerDraftStore";
import {
  applyScheduledActionProjection,
  syncScheduledActionProjections,
} from "../../../lib/useScheduledThreadActionProjection";
import { ThreadTodoCard } from "../ThreadTodoCard";
import { TodoDispatchProvider } from "../TodoDispatchProvider";
import { useQueuedReviewTodoIds } from "../queued-review-todos";

afterEach(cleanup);

const CARD_IDS = ["card-1", "card-2", "card-3"] as const;
const THREAD_IDS = ["thread-a", "thread-b"] as const;
const STATUSES: ScheduledThreadActionStatus[] = [
  "held", "scheduled", "dispatching", "queued", "started", "cancelled", "failed",
];
/** Still waiting to start: the owner has not completed the card yet. */
const WAITING = new Set<ScheduledThreadActionStatus>(["held", "scheduled", "dispatching", "queued"]);

type ActionSpec = { threadId: string; todoId?: string; status: ScheduledThreadActionStatus };

function reviewAction(id: string, spec: ActionSpec): ScheduledThreadAction {
  return {
    id,
    backend: "claude",
    threadId: spec.threadId,
    kind: "review",
    origin: "desktop",
    status: spec.status,
    scheduledFor: 1_000,
    displayText: "Review PR #4405",
    review: {
      target: { type: "uncommittedChanges" },
      ...(spec.todoId ? { todo: { id: spec.todoId } } : {}),
    },
    ...(spec.status === "queued" ? { queueEntryId: `pending-review:${id}` } : {}),
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

function reviewCard(id: string): ThreadTodo {
  return {
    id, backend: "claude", threadId: "thread-a", kind: "review", status: "open",
    title: `Review ${id}`, createdAt: 0, updatedAt: 0, action: { type: "start_review" },
  };
}

const actionSpec = fc.record({
  threadId: fc.constantFrom(...THREAD_IDS),
  todoId: fc.option(fc.constantFrom(...CARD_IDS), { nil: undefined }),
  status: fc.constantFrom(...STATUSES),
});

// Model: a review card offers Start review exactly when no review queued from
// it is still waiting to start. Once the queued review starts the owner
// completes the card; once it fails or is cancelled the card is live again.
it("offers Start review only while no review queued from the card is waiting", () => {
  fc.assert(
    fc.property(
      fc.array(actionSpec, { minLength: 1, maxLength: 5 }),
      fc.array(fc.record({ index: fc.nat(), status: fc.constantFrom(...STATUSES) }), { maxLength: 6 }),
      (initial, updates) => {
        const { result: storeHook } = renderHook(() => useComposerDraftStore());
        const store = storeHook.current;
        const { result: queued } = renderHook(() => useQueuedReviewTodoIds(store));
        const specs = initial.map((spec) => ({ ...spec }));
        const cards = CARD_IDS.map(reviewCard);
        const api = { getNavigationQueryPage: vi.fn() };
        const tree = (queuedTodoIds: ReadonlySet<string>) => (
          <TodoDispatchProvider api={api} backends={[]} todos={cards}>
            {cards.map((card) => (
              <ThreadTodoCard key={card.id} todo={card} running={false} now={0}
                onRun={vi.fn()} onResolve={vi.fn()} onStartReview={vi.fn()} onSetItemChecked={vi.fn()}
                reviewSetup={{ onShow: vi.fn(), queuedTodoIds }} />
            ))}
          </TodoDispatchProvider>
        );
        const view = render(tree(queued.current));

        const check = () => {
          view.rerender(tree(queued.current));
          for (const card of cards) {
            const waiting = specs.some((spec) => spec.todoId === card.id && WAITING.has(spec.status));
            const region = view.container.querySelector(`[data-todo-id='${card.id}']`) as HTMLElement;
            const start = [...region.querySelectorAll("button")].some((button) => button.textContent === "Start review");
            expect(start).toBe(!waiting);
            expect(region.textContent?.includes("Review queued")).toBe(waiting);
          }
        };

        act(() => {
          syncScheduledActionProjections(store, specs.map((spec, index) => reviewAction(`action-${index}`, spec)));
        });
        check();
        for (const update of updates) {
          const index = update.index % specs.length;
          specs[index] = { ...specs[index]!, status: update.status };
          act(() => applyScheduledActionProjection(store, reviewAction(`action-${index}`, specs[index]!)));
          check();
        }
        view.unmount();
      },
    ),
    { numRuns: 60 },
  );
  expect(screen.queryByText("Review queued")).toBeNull();
});

// Every queue edit in any thread notifies the store's listeners. The card set
// is read from ThreadView, so an edit that leaves the ids alone must neither
// re-render it nor hand the cards a new set.
it("keeps the queued card set, and skips the render, when a queue edit leaves its ids alone", () => {
  const { result: storeHook } = renderHook(() => useComposerDraftStore());
  const store = storeHook.current;
  let renders = 0;
  const { result } = renderHook(() => {
    renders += 1;
    return useQueuedReviewTodoIds(store);
  });
  act(() => syncScheduledActionProjections(store, [reviewAction("action-0", { threadId: "thread-a", todoId: "card-1", status: "queued" })]));
  const queued = result.current;
  const rendersAfterQueue = renders;
  expect([...queued]).toEqual(["card-1"]);

  act(() => applyScheduledActionProjection(store, reviewAction("action-1", { threadId: "thread-b", status: "scheduled" })));
  act(() => applyScheduledActionProjection(store, reviewAction("action-0", { threadId: "thread-a", todoId: "card-1", status: "dispatching" })));

  expect(renders).toBe(rendersAfterQueue);
  expect(result.current).toBe(queued);
});

// The owner stores its own card id on the queued review; a viewer names a
// peer's card `remote-todo:<owner>:<id>`. Whatever either id holds, the card
// the viewer shows must read the review as queued.
it("says a peer's card has a queued review when the owner reports the review", () => {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 12 }),
      fc.string({ minLength: 1, maxLength: 24 }),
      (owner, ownerCardId) => {
        const target = { scope: "remote" as const, instanceId: owner };
        const { result: storeHook } = renderHook(() => useComposerDraftStore());
        const store = storeHook.current;
        const { result: queued } = renderHook(() => useQueuedReviewTodoIds(store));
        act(() => syncScheduledActionProjections(
          store,
          [reviewAction("action-0", { threadId: "thread-a", todoId: ownerCardId, status: "queued" })],
          new Set(),
          target,
        ));

        expect([...queued.current]).toEqual([remoteThreadTodoId(target, ownerCardId)]);
      },
    ),
    { numRuns: 40 },
  );
});
