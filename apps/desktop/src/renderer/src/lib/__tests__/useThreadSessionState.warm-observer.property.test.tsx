import { act, renderHook } from "@testing-library/react";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { AppServerReadThreadResponse, AppServerThreadEntry } from "@pwragent/shared/contracts/normalized-app-server";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { buildThreadPricingDisplay } from "@pwragent/shared/thread-pricing-display";
import type { DesktopApi } from "../desktop-api";
import { useThreadSessionState } from "../useThreadSessionState";

async function observeWarmTurn(remote: boolean, fromMessaging: boolean, historySize: number, chunks: number) {
  const target = remote ? { scope: "remote" as const, instanceId: "owner" } : undefined;
  const thread: NavigationThreadSummary = {
    id: "fixture", source: "claude", title: "Observer fixture", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
    updatedAt: 1,
    ...(target ? { federation: {
      ref: { backend: "claude", threadId: "fixture", target }, instanceLabel: "Remote owner",
      capabilities: ["thread_detail", "event_subscriptions", "thread_display_bulk_reads"],
    } } : {}),
  };
  let historicalVisits = 0;
  const oldRows: AppServerThreadEntry[] = Array.from({ length: historySize }, (_, index) => ({
    id: `review-${index}`,
    get type() { historicalVisits++; return "review" as const; },
    review: `Old findings ${index}`,
    turn: { id: `old-${index}`, status: "completed", completedAt: 1_800_000_000_000 + index },
  }));
  const recent: AppServerThreadEntry = {
    id: "recent", type: "message", role: "assistant", text: "Recent reply",
    turn: { id: "recent-turn", status: "completed", completedAt: 1_800_000_001_000 },
  };
  const owners = new Set<(event: AgentEvent) => void>();
  const display = { revision: "revision", pricing: buildThreadPricingDisplay({}) };
  const response = (entries: AppServerThreadEntry[], before?: string): AppServerReadThreadResponse => ({
    backend: "claude", threadId: thread.id, fetchedAt: Date.now(), display, threadStatus: "idle",
    replay: { entries, messages: [], pagination: before
      ? { supportsPagination: true, hasPreviousPage: true, previousCursor: before }
      : { supportsPagination: true, hasPreviousPage: false } },
  });
  const readThread = vi.fn<NonNullable<DesktopApi["readThread"]>>(async (request) => {
    if (request.display?.resource === "accounting") {
      return response((request.display.turns ?? []).map((turn) => ({
        type: "activity", id: `live-turn-usage-${turn.id}`, status: "completed",
        summary: "Turn usage: 1 out", details: [], turn,
      })));
    }
    return request.before ? response(oldRows) : response([recent], "older");
  });
  const api: DesktopApi = {
    readThread,
    onAgentEvent: (listener) => { owners.add(listener); return () => { owners.delete(listener); }; },
  };
  vi.useFakeTimers();
  const mounted = renderHook(() => useThreadSessionState({ desktopApi: api, thread, initialHistoryLimit: 1 }));
  try {
    await act(async () => {});
    await act(async () => { await mounted.result.current.loadOlder(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(mounted.result.current.entries.map((entry) => entry.id)).toContain("live-turn-usage-recent-turn");
    const prefix = mounted.result.current.entries.map((entry) => entry.id);
    expect(prefix).toContain("review-0");
    historicalVisits = 0;
    readThread.mockClear();

    const send = (method: string, fields: Record<string, unknown>) => {
      const event: AgentEvent = {
        backend: "claude", ...(target ? { federationTarget: target } : {}),
        notification: { method, params: { threadId: thread.id, turnId: "new-turn", ...fields } } as AgentEvent["notification"],
      };
      act(() => { for (const listener of owners) listener(event); });
    };
    send("turn/started", { turn: { id: "new-turn", status: "in_progress" } });
    send("item/completed", { item: {
      id: "new-prompt", type: "userMessage", text: "/code-review",
      ...(fromMessaging ? { origin: { kind: "messaging" } } : {}),
    } });
    for (let index = 0; index < chunks; index++) {
      send("item/agentMessage/delta", { itemId: "new-answer", delta: "word " });
    }
    send("item/completed", { item: { id: "new-answer", type: "agentMessage", text: "New answer.", phase: "final" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(readThread.mock.calls).toEqual([]);
    expect(historicalVisits).toBe(0);
    const shown = mounted.result.current.entries.map((entry) => entry.id);
    expect(shown.slice(0, prefix.length)).toEqual(prefix);
    expect(shown).toContain("new-prompt");
    expect(shown).toContain("new-answer");
  } finally {
    mounted.unmount();
    vi.useRealTimers();
  }
}

it("does not revisit older pages in warm desktop and federated observers of a turn", async () => {
  for (const remote of [false, true]) {
    for (const messaging of [false, true]) {
      await fc.assert(fc.asyncProperty(
        fc.integer({ min: 8, max: 40 }), fc.integer({ min: 2, max: 12 }),
        (historySize, chunks) => observeWarmTurn(remote, messaging, historySize, chunks),
      ), { numRuns: 5 });
    }
  }
});

it.each(["reconnect", "reload", "overlapping reload"])("reconciles the owner cursor after %s in a continuously mounted remote observer", async (trigger) => {
  let firstRowVisits = 0;
  const first: AppServerThreadEntry = {
    id: "first", get type() { firstRowVisits++; return "message" as const; },
    role: "assistant", text: "First answer",
    turn: { id: "first-turn", status: "completed", completedAt: 1 },
  };
  const target = { scope: "remote" as const, instanceId: "owner" };
  const thread: NavigationThreadSummary = {
    id: "long-lived", source: "claude", title: "Warm thread", titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: true }, updatedAt: 1,
    federation: {
      ref: { target, backend: "claude", threadId: "long-lived" }, instanceLabel: "Remote owner",
      capabilities: ["thread_detail", "event_subscriptions"],
    },
  };
  const usage: AppServerThreadEntry = {
    id: "live-turn-usage-first-turn", type: "activity", status: "completed",
    summary: "Turn usage: 10 out", details: [], turn: first.turn,
  };
  let recovering = false;
  const recovered = {
    ...first, id: "recovered", text: "After reconnect", turn: { ...first.turn!, id: "recovered-turn" },
  };
  const gap = {
    ...first, id: "in-gap", text: "While disconnected", turn: { ...first.turn!, id: "gap-turn" },
  };
  const readThread = vi.fn<NonNullable<DesktopApi["readThread"]>>(async (request) => ({
    backend: "claude", threadId: thread.id, fetchedAt: Date.now(), threadStatus: "idle",
    display: { revision: "revision", pricing: buildThreadPricingDisplay({}) },
    replay: {
      entries: request.display?.resource === "accounting" ? [usage]
        : request.before ? [gap] : recovering ? trigger === "overlapping reload" ? [first, recovered] : [recovered] : [first],
      messages: [], pagination: recovering && !request.before
        ? { supportsPagination: true, hasPreviousPage: true, previousCursor: "gap" }
        : { supportsPagination: true, hasPreviousPage: false },
    },
  }));
  const listeners = new Set<(event: AgentEvent) => void>();
  const api: DesktopApi = {
    readThread, onAgentEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  vi.useFakeTimers();
  const { result, unmount } = renderHook(() => useThreadSessionState({ desktopApi: api, thread, initialHistoryLimit: 5 }));
  try {
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(result.current.entries.map((entry) => entry.id)).toEqual(["first", usage.id]);
    const send = (turnId: string, method: string, fields: Record<string, unknown>) => {
      const event: AgentEvent = { backend: "claude", federationTarget: target,
        notification: { method, params: { threadId: thread.id, turnId, ...fields } } as AgentEvent["notification"],
      };
      for (const listener of listeners) listener(event);
    };
    const turnCount = 120;
    for (let index = 0; index < turnCount; index++) {
      // Give every accepted turn its own items and terminal evidence.
      const turnId = `turn-${index}`;
      act(() => {
        send(turnId, "turn/started", { turn: { id: turnId, status: "in_progress" } });
        send(turnId, "item/completed", { item: { type: "userMessage", id: `user-${index}`, text: `Prompt ${index}` } });
        send(turnId, "item/completed", { item: { type: "agentMessage", id: `answer-${index}`, text: `Answer ${index}`, phase: "final" } });
        send(turnId, "turn/completed", { turn: {
          id: turnId, status: "completed", output: [{ type: "output_text", text: `Answer ${index}` }],
        } });
      });
    }
    const expected = ["first", usage.id, ...Array.from({ length: turnCount }, (_, index) => [`user-${index}`, `answer-${index}`]).flat()];
    expect(result.current.entries.map((entry) => entry.id)).toEqual(expected);
    const reads = readThread.mock.calls.length;
    firstRowVisits = 0;
    act(() => {
      send("next-turn", "turn/started", { turn: { id: "next-turn", status: "in_progress" } });
      send("next-turn", "item/completed", { item: { type: "userMessage", id: "next-user", text: "Next prompt" } });
    });
    expect(firstRowVisits).toBe(0);
    expect(readThread).toHaveBeenCalledTimes(reads);
    expect(result.current.entries.map((entry) => entry.id)).toEqual([...expected, "next-user"]);
    act(() => send("first-turn", "item/completed", {
      item: { type: "agentMessage", id: "first", text: "First answer revised.", phase: "final" },
    }));
    expect(result.current.entries.map((entry) => entry.id)).toEqual([...expected, "next-user"]);
    expect(result.current.entries[0]).toMatchObject({ id: "first", text: "First answer revised." });
    recovering = true;
    await act(async () => {
      if (trigger !== "reconnect") {
        await result.current.reload();
        return;
      }
      const event: AgentEvent = {
        backend: "claude", federationTarget: target,
        notification: { method: "federation/eventStream/changed", params: { instanceId: target.instanceId, epoch: "gap" } },
      };
      for (const listener of listeners) listener(event);
    });
    if (trigger === "overlapping reload") {
      expect(result.current.entries.map((entry) => entry.id)).toContain("first");
      expect(result.current.entries.map((entry) => entry.id)).toContain("recovered");
      expect(result.current.entries.map((entry) => entry.id)).toContain("answer-0");
      return;
    }
    expect(result.current.entries.map((entry) => entry.id)).toEqual(["recovered"]);
    await act(async () => { await result.current.loadOlder(); });
    expect(result.current.entries.map((entry) => entry.id)).toEqual(["in-gap", "recovered"]);
  } finally {
    unmount();
    vi.useRealTimers();
  }
});
