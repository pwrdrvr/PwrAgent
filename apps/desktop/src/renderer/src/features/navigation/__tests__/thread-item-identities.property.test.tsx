import { StrictMode, memo, useMemo } from "react";
import { act, cleanup, fireEvent, render, renderHook, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  threadTodoThreadKey,
  type ThreadTodo,
  type ThreadTodoFeedDelta,
} from "@pwragent/shared/contracts/thread-todos";
import { type AgentEvent } from "@pwragent/shared/contracts/agent";
import { type ListOperatorRequestsResponse } from "@pwragent/shared/contracts/operator-requests";
import { type NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { type ThreadDependency } from "@pwragent/shared/contracts/thread-dependencies";
import { OperatorWaitsContext, useOperatorRequests } from "../../operator-requests/useOperatorRequests";
import { ThreadTodoCountsContext, useThreadTodos } from "../../thread-todos/useThreadTodos";
import { ThreadTodoRevealContext } from "../../thread-todos/thread-todo-reveal";
import { ThreadDependencyIndicatorsContext, threadDependencyIndicatorKey, useThreadDependencyIndicators,
  useThreadDependencyIndicatorsValue } from "../../thread-dependencies/useThreadDependencyIndicators";
import * as providerChips from "../provider-chip-visibility";
import * as identity from "../../../lib/federated-thread-events";
import { TOOLTIP_HOVER_DELAY_MS } from "../../../lib/useViewportTooltip";
import { ThreadMetaChips } from "../ThreadMetaChips";
import budgets from "./fixtures/thread-item-identity-budgets.json";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
type Scenario = "wait" | "todo" | "dependency";

async function fixture(n: number) {
  const target = { scope: "remote" as const, instanceId: "peer" };
  const threads: NavigationThreadSummary[] = Array.from({ length: n }, (_, i) => ({
    id: `row-${Math.floor(i / 2)}`, source: "codex", title: `Contrived ${i}`, titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: false },
    ...(i % 2 ? { federation: { instanceLabel: "Peer", ref: { backend: "codex", threadId: `row-${Math.floor(i / 2)}`, target } } } : {}),
  }));
  const owner = (i: number) => i % 2 ? target : undefined;
  const keys = threads.map((thread, i) => threadTodoThreadKey({ backend: "codex", threadId: thread.id, federationTarget: owner(i) }));
  let response: ListOperatorRequestsResponse = { serverRequests: [], seenKeys: [], questions: threads.map((thread, i) => ({
    backend: "codex", threadId: thread.id, messageId: `question-${i}`, createdAt: i + 1,
    federationTarget: owner(i), questions: [{ title: `Question ${i}`, options: null }],
  })) };
  const card = (i: number): ThreadTodo => ({ id: i % 2 ? `remote-todo:peer:card-${i}` : `card-${i}`,
    backend: "codex", threadId: threads[i]!.id, federationTarget: owner(i), kind: "reminder", status: "open",
    title: `Card ${i}`, createdAt: i, updatedAt: i });
  const dependency = (i: number): ThreadDependency => ({ id: `dependency-${i}`, backend: "codex", threadId: threads[i]!.id,
    status: "waiting", mode: "all", onFailure: "notify", createdAt: i, updatedAt: i,
    conditions: [{ backend: "codex", threadId: "prerequisite", when: "marked_done", title: `Prerequisite ${i}` }], evidence: [] });
  let dependencies = threads.flatMap((_, i) => i % 2 ? [] : [dependency(i)]);
  const peerActive = threads.flatMap((_, i) => i % 2 ? [{ dependency: dependency(i), owner: target }] : []);
  let delta: (event: ThreadTodoFeedDelta) => void = () => {};
  const listeners = new Set<(event: AgentEvent) => void>();
  const api = {
    listOperatorRequests: vi.fn(async () => structuredClone(response)),
    snapshotThreadTodos: vi.fn(async () => ({ epoch: "e", revision: 0, todos: threads.map((_, i) => card(i)) })),
    onThreadTodosDelta: (listener: typeof delta) => { delta = listener; return () => {}; },
    manageThreadDependencies: vi.fn(async () => structuredClone({ dependencies, peerActive })),
    onAgentEvent: (listener: (event: AgentEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const show = vi.fn();
  const openWait = vi.fn();
  const reveal = vi.fn();
  let requests!: ReturnType<typeof useOperatorRequests>;
  let todos!: ReturnType<typeof useThreadTodos>;
  let indicators!: ReturnType<typeof useThreadDependencyIndicators>;
  let context!: ReturnType<typeof useThreadDependencyIndicatorsValue>;
  const Rows = memo(function Rows() { return <>{threads.map((thread, i) => <div data-row={i} key={i}>
    <ThreadMetaChips thread={thread} /></div>)}</>; });
  function Owner() {
    const r = useOperatorRequests(api);
    requests = r;
    todos = useThreadTodos(api);
    indicators = useThreadDependencyIndicators(api);
    context = useThreadDependencyIndicatorsValue(indicators, show);
    const waits = useMemo(() => r.ready ? { waitsByThreadKey: r.waitsByThreadKey, seenKeys: r.seenKeys, openWait } : undefined,
      [r.ready, r.waitsByThreadKey, r.seenKeys]);
    return <OperatorWaitsContext.Provider value={waits}><ThreadTodoCountsContext.Provider value={todos.openByThreadKey}>
      <ThreadDependencyIndicatorsContext.Provider value={context}><ThreadTodoRevealContext.Provider value={reveal}>
        <Rows />
      </ThreadTodoRevealContext.Provider></ThreadDependencyIndicatorsContext.Provider>
    </ThreadTodoCountsContext.Provider></OperatorWaitsContext.Provider>;
  }
  const view = render(<StrictMode><Owner /></StrictMode>);
  await waitFor(() => expect(requests.waits).toHaveLength(n));
  await waitFor(() => expect(todos.openTodos).toHaveLength(n));
  await waitFor(() => expect(indicators.size).toBe(n));
  vi.useFakeTimers();
  const contentRenders = vi.spyOn(providerChips, "useProviderChipNeeded");
  const projections = vi.spyOn(identity, "threadSummaryIdentityKey");
  api.listOperatorRequests.mockClear(); api.snapshotThreadTodos.mockClear(); api.manageThreadDependencies.mockClear();
  let revision = 0;
  const emit = async (threadId: string, dependencyId: string) => { await act(async () => {
    for (const listener of listeners) listener({ backend: "codex", notification: { method: "thread/dependencies/updated", params: { threadId, dependencyId } } });
    await vi.advanceTimersByTimeAsync(150);
  }); };
  return { view, keys, threads, api, contentRenders, projections, show, openWait, reveal,
    current: () => ({ requests, todos, indicators, context }),
    async renameThreadTitle(title: string) {
      response = { ...response, questions: response.questions.map((question, i) => i === 0 ? { ...question, threadTitle: title } : question) };
      await act(async () => requests.refresh());
    },
    groups: (scenario: Scenario) => scenario === "wait" ? requests.waitsByThreadKey : scenario === "todo" ? todos.openByThreadKey : indicators,
    async step(scenario: Scenario, step: number, own = false) {
      if (scenario === "wait") {
        if (own) response = { ...response, questions: response.questions.map((q, i) => i === 0 ? { ...q, messageId: `new-${step}`, questions: [{ title: `New question ${step}`, options: null }] } : q) };
        else response = { ...response, questions: [...response.questions.filter((q) => q.threadId !== "offscreen"), {
          backend: "codex", threadId: "offscreen", messageId: String(step), createdAt: step + 100,
          questions: [{ title: `Offscreen ${step}`, options: null }],
        }] };
        await act(async () => requests.refresh());
      } else if (scenario === "todo") {
        const todo = own ? { ...card(0), title: `New card ${step}`, updatedAt: step + 100 }
          : { ...card(0), id: "offscreen-card", threadId: "offscreen", title: `Offscreen ${step}`, updatedAt: step + 100 };
        act(() => delta({ epoch: "e", revision: ++revision, upserts: [todo] }));
      } else {
        if (own) dependencies = dependencies.map((d, i) => i === 0 ? { ...d, conditions: [{ ...d.conditions[0]!, title: `New prerequisite ${step}` }] } : d);
        else dependencies = [...dependencies.filter((d) => d.id !== "offscreen"), { ...dependency(0), id: "offscreen", threadId: "offscreen", conditions: [{ ...dependency(0).conditions[0]!, title: `Offscreen ${step}` }] }];
        await emit(own ? "row-0" : "offscreen", own ? "dependency-0" : "offscreen");
      }
    },
  };
}

it.each(["wait", "todo", "dependency"] as const)("unrelated %s updates retain every owner's published group and chip work", async (scenario) => {
  // Oracle: changes to an offscreen owner cannot change either owner's row,
  // even when a local and remote thread share a provider thread id.
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 4 }), async (pairs, steps) => {
    const f = await fixture(pairs * 2);
    try {
      const before = f.groups(scenario);
      const html = f.view.container.innerHTML;
      const action = f.current().context.open;
      for (let i = 0; i < steps; i++) {
        await f.step(scenario, i);
        for (let j = 0; j < f.keys.length; j++) {
          const key = scenario === "dependency" ? threadDependencyIndicatorKey("codex", f.threads[j]!.id, j % 2 ? "peer" : undefined) : f.keys[j]!;
          expect(f.groups(scenario).get(key)).toBe(before.get(key));
        }
        expect(f.current().context.open).toBe(action);
        expect(f.view.container.innerHTML).toBe(html);
        expect(f.contentRenders).not.toHaveBeenCalled();
      }
    } finally { f.view.unmount(); vi.restoreAllMocks(); vi.useRealTimers(); }
  }), { numRuns: 15 });
});

it.each([20, 40])("budgets 20 offscreen changes per producer at %i rows", async (count) => {
  for (const scenario of ["wait", "todo", "dependency"] as const) {
    const f = await fixture(count);
    try {
      let publishedGroups = 0;
      const budget = budgets[String(count) as keyof typeof budgets];
      for (let i = 0; i < 20; i++) {
        const before = f.groups(scenario);
        await f.step(scenario, i);
        for (const [key, value] of f.groups(scenario)) if (before.get(key) !== value) publishedGroups++;
      }
      expect({ projections: f.projections.mock.calls.length, contentRenders: f.contentRenders.mock.calls.length, publishedGroups }).toEqual(budget);
      expect(f.api.listOperatorRequests.mock.calls.length).toBe(scenario === "wait" ? 20 : 0);
      expect(f.api.snapshotThreadTodos).not.toHaveBeenCalled();
      expect(f.api.manageThreadDependencies.mock.calls.length).toBe(scenario === "dependency" ? 20 : 0);
    } finally { f.view.unmount(); vi.restoreAllMocks(); vi.useRealTimers(); }
  }
});

it.each(["wait", "todo", "dependency"] as const)("keeps current %s tooltips and actions on a real row change", async (scenario) => {
  const f = await fixture(2);
  await f.step(scenario, 1, true);
  const row = f.view.container.querySelector('[data-row="0"]')! as HTMLElement;
  if (scenario === "wait") {
    fireEvent.click(within(row).getByRole("button", { name: "Question: New question 1" }));
    expect(f.openWait).toHaveBeenLastCalledWith(f.current().requests.waitsByThreadKey.get(f.keys[0]!)![0]);
  } else if (scenario === "todo") {
    fireEvent.mouseEnter(row.querySelector("[data-thread-todos]")!);
    await act(async () => vi.advanceTimersByTimeAsync(TOOLTIP_HOVER_DELAY_MS));
    expect(document.body.textContent).toContain("New card 1");
    fireEvent.click(row.querySelector("[data-thread-todos]")!);
    expect(f.reveal).toHaveBeenLastCalledWith(f.threads[0]);
  } else {
    const chip = within(row).getByRole("button", { name: "Continue after: Waiting" });
    fireEvent.mouseEnter(chip);
    await act(async () => vi.advanceTimersByTimeAsync(TOOLTIP_HOVER_DELAY_MS));
    expect(document.body.textContent).toContain("New prerequisite 1");
    fireEvent.click(chip);
    expect(f.show).toHaveBeenLastCalledWith({ thread: f.threads[0] });
  }
  expect(f.contentRenders.mock.calls.length).toBeGreaterThan(0);
});

it("publishes a renamed wait's latest action payload without replacing its remote namesake", async () => {
  const f = await fixture(2);
  const before = f.current().requests.waitsByThreadKey;
  await f.renameThreadTitle("Renamed owner title");
  const after = f.current().requests.waitsByThreadKey;
  expect(after.get(f.keys[0]!)).not.toBe(before.get(f.keys[0]!));
  expect(after.get(f.keys[1]!)).toBe(before.get(f.keys[1]!));
  const row = f.view.container.querySelector('[data-row="0"]')! as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "Question: Question 0" }));
  expect(f.openWait).toHaveBeenLastCalledWith(expect.objectContaining({ threadTitle: "Renamed owner title" }));
});

it("keeps the current dependency dialog owner and capability as maps refresh", () => {
  const first = vi.fn(), second = vi.fn();
  const empty = new Map();
  const hook = renderHook(({ map, show }) => useThreadDependencyIndicatorsValue(map, show),
    { initialProps: { map: empty, show: first as ((request: { thread: NavigationThreadSummary }) => void) | undefined } });
  const open = hook.result.current.open;
  const thread: NavigationThreadSummary = { id: "same", source: "codex", title: "Contrived", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false } };
  hook.rerender({ map: new Map(), show: first });
  expect(hook.result.current.open).toBe(open);
  hook.rerender({ map: new Map(), show: second });
  hook.result.current.open!(thread);
  expect(second).toHaveBeenCalledExactlyOnceWith({ thread });
  expect(first).not.toHaveBeenCalled();
  hook.rerender({ map: new Map(), show: undefined });
  expect(hook.result.current.open).toBeUndefined();
});
