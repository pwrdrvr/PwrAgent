import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { buildThreadPricingDisplay } from "@pwragent/shared/thread-pricing-display";
import { type AgentEvent } from "@pwragent/shared/contracts/agent";
import {
  type AppServerReadThreadResponse,
  type AppServerThreadEntry,
} from "@pwragent/shared/contracts/normalized-app-server";
import { type NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../desktop-api";
import { useThreadUsageDisplay } from "../useThreadUsageDisplay";

const target = { scope: "remote" as const, instanceId: "owner" };
const thread: NavigationThreadSummary = { source: "codex", id: "thread", title: "Thread", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
  federation: { ref: { backend: "codex", threadId: "thread", target }, instanceLabel: "Owner", capabilities: ["thread_detail", "event_subscriptions"] } };
const turn = { id: "turn-1", status: "completed" as const, completedAt: 1000 };
const content: AppServerThreadEntry = { type: "message", role: "assistant", id: "answer", text: "Visible answer", turn };
const usage = (summary: string): AppServerThreadEntry => ({ type: "activity", id: "live-turn-usage-turn-1", summary, status: "completed", details: [], turn });
function response(entries: AppServerThreadEntry[], revision = "revision"): AppServerReadThreadResponse {
  return { backend: "codex", threadId: "thread", fetchedAt: 1, replay: { entries, messages: [], pagination: { supportsPagination: true, hasPreviousPage: false } },
    display: { pricing: buildThreadPricingDisplay({}), revision } };
}
afterEach(() => vi.useRealTimers());

it("applies owner usage corrections to loaded turns without reading transcript history or a ledger", async () => {
  let listener!: (event: AgentEvent) => void;
  const read = vi.fn<NonNullable<DesktopApi["readThread"]>>().mockResolvedValue(response([usage("Turn usage: owner corrected cost")]));
  const api: DesktopApi = { readThread: read, onAgentEvent: (callback) => { listener = callback; return () => undefined; } };
  const snapshot = response([content, usage("Turn usage: old cost")]);
  const { result, unmount } = renderHook(() => useThreadUsageDisplay({ desktopApi: api, thread, entries: snapshot.replay.entries, response: snapshot }));
  await waitFor(() => expect(result.current[1]).toMatchObject({ summary: "Turn usage: owner corrected cost" }));
  expect(result.current[0]).toBe(content);
  expect(result.current).toHaveLength(2);
  expect(read).toHaveBeenCalledExactlyOnceWith({ backend: "codex", threadId: "thread", federationTarget: target,
    display: { resource: "accounting", turns: [turn] }, includeTurns: false, viewOnly: true });
  vi.useFakeTimers();
  const event: AgentEvent = { backend: "codex", federationTarget: target, notification: { method: "thread/pricing/updated", params: {
    threadId: "thread", displayInvalidated: true, pricing: { lines: [], summaries: [] },
  } } };
  act(() => listener({ ...event, federationTarget: { scope: "remote", instanceId: "other" } }));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(read).toHaveBeenCalledTimes(1);
  read.mockResolvedValue(response([usage("Turn usage: final cost")]));
  act(() => { listener(event); listener(event); });
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(read).toHaveBeenCalledTimes(2);
  expect(result.current[1]).toMatchObject({ summary: "Turn usage: final cost" });
  unmount();
});

it("does not overwrite a newer snapshot with cached corrections from its previous revision", async () => {
  const read = vi.fn<NonNullable<DesktopApi["readThread"]>>().mockResolvedValue(response([usage("Turn usage: previous correction")]));
  const api: DesktopApi = { readThread: read };
  const { result, rerender, unmount } = renderHook(({ snapshot }) => useThreadUsageDisplay({ desktopApi: api, thread, entries: snapshot.replay.entries, response: snapshot }), {
    initialProps: { snapshot: response([content, usage("Turn usage: initial")]) },
  });
  await waitFor(() => expect(result.current[1]).toMatchObject({ summary: "Turn usage: previous correction" }));
  vi.useFakeTimers();
  rerender({ snapshot: response([content, usage("Turn usage: newest snapshot")], "new-revision") });
  expect(result.current[1]).toMatchObject({ summary: "Turn usage: newest snapshot" });
  unmount();
});

it("requests only invalidated turns and keeps an interrupted refresh until it succeeds", async () => {
  vi.useFakeTimers();
  const ids = ["a", "b", "c"];
  const entries = ids.map((id) => ({ ...content, id, turn: { ...turn, id } }));
  const snapshot = response(entries);
  const latest = new Map(ids.map((id) => [id, 0]));
  const requests: string[][] = [];
  let listener!: (event: AgentEvent) => void;
  let release: (() => void) | undefined;
  let block = false;
  let revision = "original";
  const read: NonNullable<DesktopApi["readThread"]> = async (request) => {
    const selected = request.display?.turns?.map((item) => item.id) ?? [];
    requests.push(selected);
    const result = response(selected.map((id) => ({
      ...usage(`Turn usage: ${id} ${latest.get(id)}`), id: `usage-${id}`, turn: { ...turn, id },
    })));
    if (block) {
      block = false;
      await new Promise<void>((resolve) => { release = resolve; });
    }
    return result;
  };
  const api: DesktopApi = { readThread: read, onAgentEvent: (fn) => { listener = fn; return () => {}; } };
  const { result, unmount } = renderHook(() => useThreadUsageDisplay({ desktopApi: api, thread, entries, response: snapshot }));
  const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(250); });
  const change = (id: string) => {
    latest.set(id, latest.get(id)! + 1);
    act(() => listener({ backend: "codex", federationTarget: target, notification: {
      method: "thread/pricing/updated", params: { threadId: "thread", changedTurnIds: [id], pricingHistoryRevision: revision, displayInvalidated: true, pricing: { lines: [], summaries: [] } },
    } }));
  };
  await flush();
  // Establish the owner revision before measuring incremental reads.
  change("c");
  await flush();
  const unchanged = result.current[1];
  block = true;
  change("b");
  await flush();
  change("c");
  await flush();
  await act(async () => { release!(); });
  expect(requests).toEqual([ids, ids, ["b"], ["b", "c"]]);
  expect(result.current[1]).toBe(unchanged);
  expect(result.current.filter((entry) => entry.type === "activity").map((row) => row.summary))
    .toEqual(["Turn usage: a 0", "Turn usage: b 1", "Turn usage: c 2"]);
  // A historical correction can arrive on a different connection. The owner
  // revision invalidates all visible turns, including ones absent from the hint.
  latest.set("a", 20);
  revision = "repaired";
  change("b");
  await flush();
  expect(requests.at(-1)).toEqual(ids);
  expect(result.current[1]).toMatchObject({ summary: "Turn usage: a 20" });
  latest.set("a", 30);
  act(() => listener({ backend: "codex", notification: { method: "federation/peerStatus/changed",
    params: { instanceId: "owner", status: "connected" },
  } }));
  await flush();
  expect(requests.at(-1)).toEqual(ids);
  expect(result.current[1]).toMatchObject({ summary: "Turn usage: a 30" });
  unmount();
});
