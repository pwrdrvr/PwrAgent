import { memo, useMemo } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { ListOperatorRequestsResponse, NavigationThreadSummary } from "@pwragent/shared";
import { OperatorWaitsContext, useOperatorRequests } from "../../operator-requests/useOperatorRequests";
import budgets from "./fixtures/thread-meta-wait-budgets.json";
import * as identity from "../../../lib/federated-thread-events";
import * as tooltips from "../../../lib/useViewportTooltip";
import { ThreadMetaChips } from "../ThreadMetaChips";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function fixture(count: number) {
  const threads: NavigationThreadSummary[] = Array.from({ length: count }, (_, i) => ({
    id: `row-${i}`, source: "codex", title: `Contrived ${i}`, titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
  }));
  let response: ListOperatorRequestsResponse = { serverRequests: [], seenKeys: [], questions: threads.map((thread, i) => ({
    backend: "codex", threadId: thread.id, messageId: `question-${i}`, createdAt: i,
    questions: [{ title: `Question ${i}`, options: null }],
  })) };
  const list = vi.fn(async () => structuredClone(response));
  const api = { listOperatorRequests: list };
  let controller!: ReturnType<typeof useOperatorRequests>;
  const Rows = memo(function Rows() {
    return <>{threads.map((thread) => <ThreadMetaChips key={thread.id} thread={thread} />)}</>;
  });
  function Owner() {
    const current = useOperatorRequests(api);
    controller = current;
    const value = useMemo(() => current.ready ? {
      waitsByThreadKey: current.waitsByThreadKey, seenKeys: current.seenKeys,
    } : undefined, [current.ready, current.waitsByThreadKey, current.seenKeys]);
    return <OperatorWaitsContext.Provider value={value}><Rows /></OperatorWaitsContext.Provider>;
  }
  const mounted = render(<Owner />);
  await waitFor(() => expect(controller.ready).toBe(true));
  const tooltip = vi.spyOn(tooltips, "useViewportTooltip");
  const beforeReads = list.mock.calls.length;
  return {
    mounted, tooltip, controller: () => controller,
    reads: () => list.mock.calls.length - beforeReads,
    update: async (seenKeys: string[]) => {
      response = { ...response, seenKeys };
      await act(async () => controller.refresh());
    },
  };
}

it("projects an owner seen update onto only the displayed thread's items", async () => {
  // Oracle: owner snapshots change only keys absent from these rows. The DOM
  // and chip-content work must stay unchanged for every generated sequence.
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 1, max: 4 }),
    fc.array(fc.nat(), { minLength: 1, maxLength: 6, size: "max" }),
    async (count, marks) => {
      const f = await fixture(count);
      try {
        const before = f.mounted.container.innerHTML;
        for (const mark of marks) {
          await f.update([`other-thread:${mark}`]);
          expect(f.mounted.container.innerHTML).toBe(before);
          expect(f.tooltip).not.toHaveBeenCalled();
        }
        expect(f.reads()).toBe(marks.length);
      } finally { f.mounted.unmount(); vi.restoreAllMocks(); }
    },
  ), { numRuns: 15 });
});

it.each([20, 40])("budgets chip-content work for 20 unrelated broadcasts across %i rows", async (count) => {
  const f = await fixture(count);
  const waits = f.controller().waitsByThreadKey;
  const rowArrays: ReadonlySet<unknown> = new Set(waits.values());
  const projections = vi.spyOn(identity, "threadSummaryIdentityKey");
  const filters = vi.spyOn(Array.prototype, "filter");
  const budget = budgets[String(count) as keyof typeof budgets];
  for (let i = 0; i < budget.broadcasts; i++) await f.update([`offscreen:${i}`]);
  // No tooltip hooks means no chip-content render and none of its tooltip,
  // closure or JSX allocations. The small context adapter still executes.
  expect({
    broadcasts: budget.broadcasts,
    ownerReads: f.reads(),
    contextProjections: projections.mock.calls.length,
    tooltipHooks: f.tooltip.mock.calls.length,
    waitFilterArrays: filters.mock.contexts.filter((array) => rowArrays.has(array)).length,
  }).toEqual(budget);
  expect(f.controller().waitsByThreadKey).toBe(waits);
  filters.mockRestore();
  // A selected row's own freshness is necessary work, even with equal waits.
  await f.update([f.controller().waits[0]!.key]);
  expect(f.tooltip.mock.calls.length).toBeGreaterThan(0);
  expect(f.mounted.container.querySelectorAll(".thread-row__chip--todos.is-unread").length).toBe(count - 1);
});
