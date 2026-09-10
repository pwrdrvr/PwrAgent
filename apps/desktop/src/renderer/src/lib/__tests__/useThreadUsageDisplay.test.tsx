import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { buildThreadPricingDisplay, type AgentEvent, type AppServerReadThreadResponse, type AppServerThreadEntry, type NavigationThreadSummary } from "@pwragent/shared";
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
