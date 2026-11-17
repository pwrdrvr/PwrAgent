import { act, renderHook } from "@testing-library/react";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { AgentEvent, AppServerReadThreadResponse, NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useThreadSessionState } from "../useThreadSessionState";

type Trigger = "completion" | "metadata" | "history-limit";
const LOGGED_OUT = "Codex is logged out. Please sign in again to resume operations.";
const thread: NavigationThreadSummary = {
  id: "quiet-thread", title: "Quiet transcript", titleSource: "explicit", summary: "Fixture",
  source: "codex", linkedDirectories: [], inbox: { inInbox: false }, updatedAt: 1,
};

function response(): AppServerReadThreadResponse {
  const message = {
    type: "message" as const, id: "retained-message", role: "assistant" as const, text: "Keep this visible.",
    turn: { id: "turn-1", status: "completed" as const, startedAt: 1, completedAt: 2 },
  };
  return {
    backend: "codex", threadId: thread.id, fetchedAt: 3, threadStatus: "idle",
    replay: { entries: [message], messages: [message], pagination: { hasPreviousPage: false } },
  };
}

async function mountFailedRefresh(trigger: Trigger, error = LOGGED_OUT) {
  const reads: { resolve: (value: AppServerReadThreadResponse) => void; reject: (error: Error) => void }[] = [];
  // Every request is controlled. An unwanted retry stays pending so the
  // pre-fix hook fails an assertion instead of spinning inside async act.
  const readThread = vi.fn(() => new Promise<AppServerReadThreadResponse>((resolve, reject) => {
    reads.push({ resolve, reject });
  }));
  let emit: (event: AgentEvent) => void = () => { throw new Error("missing subscription"); };
  const desktopApi: DesktopApi = {
    readThread,
    onAgentEvent: (listener) => { emit = listener; return () => undefined; },
  };
  let currentThread: NavigationThreadSummary | undefined = thread;
  let initialHistoryLimit = 2;
  const hook = renderHook(() => useThreadSessionState({ desktopApi, thread: currentThread, initialHistoryLimit }));
  await act(async () => reads[0]!.resolve(response()));
  expect(readThread).toHaveBeenCalledTimes(1);
  const notify = (method: "turn/started" | "turn/completed") => emit({
    backend: "codex",
    notification: { method, params: { threadId: thread.id, turnId: "turn-1", turn: {
      id: "turn-1", status: method === "turn/started" ? "in_progress" : "failed", startedAt: 1,
      ...(method === "turn/completed" ? { completedAt: 2 } : {}),
    } } },
  });
  if (trigger === "completion") {
    act(() => notify("turn/started"));
    act(() => notify("turn/completed"));
  } else {
    if (trigger === "metadata") currentThread = { ...thread, updatedAt: 2 };
    else initialHistoryLimit = 3;
    hook.rerender();
  }
  expect(readThread).toHaveBeenCalledTimes(2);
  await act(async () => reads[1]!.reject(new Error(error)));
  return {
    ...hook, reads, readThread,
    rerenderSummary: () => { currentThread = { ...currentThread! }; hook.rerender(); },
    advanceVersion: () => { currentThread = { ...currentThread!, updatedAt: currentThread!.updatedAt! + 1 }; hook.rerender(); },
    reselect: () => { const selected = currentThread; currentThread = undefined; hook.rerender(); currentThread = selected; hook.rerender(); },
  };
}

// Rule: once a refresh fails, the same selected thread/version must remain
// quiescent with its cached transcript and error until a retry or new version.
for (const trigger of ["completion", "metadata", "history-limit"] as const) {
  it(`keeps a failed ${trigger} refresh quiet without hiding cached messages`, async () => {
    const real = await mountFailedRefresh(trigger);
    try {
      expect(real.readThread).toHaveBeenCalledTimes(2);
      expect(real.result.current.error).toBe(LOGGED_OUT);
      expect(real.result.current.loading).toBe(false);
      expect(real.result.current.messages.map((entry) => entry.id)).toEqual(["retained-message"]);
      real.rerenderSummary();
      await act(async () => {});
      expect(real.readThread).toHaveBeenCalledTimes(2);
      expect(real.result.current.error).toBe(LOGGED_OUT);
    } finally {
      real.unmount();
    }
  });
}

it("preserves the failed-refresh invariant across generated summary rerenders", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom<Trigger>("completion", "metadata", "history-limit"),
    fc.constantFrom(LOGGED_OUT, "Federation peer is not connected", "Backend unavailable"),
    fc.integer({ min: 1, max: 8 }),
    async (trigger, error, rerenders) => {
      const real = await mountFailedRefresh(trigger, error);
      try {
        const entries = real.result.current.entries;
        for (let i = 0; i < rerenders; i += 1) {
          real.rerenderSummary();
          await act(async () => {});
          expect(real.readThread).toHaveBeenCalledTimes(2);
          expect(real.result.current.loading).toBe(false);
          expect(real.result.current.error).toBe(error);
          expect(real.result.current.entries).toBe(entries);
        }
      } finally {
        real.unmount();
      }
    },
  ), { numRuns: 25 });
});

for (const retry of ["reload", "reselect", "new-version"] as const) {
  it(`recovers a failed completion refresh after ${retry}`, async () => {
    const real = await mountFailedRefresh("completion");
    try {
      expect(real.readThread).toHaveBeenCalledTimes(2);
      let reloaded: Promise<void> | undefined;
      if (retry === "reload") act(() => { reloaded = real.result.current.reload(); });
      else if (retry === "reselect") real.reselect();
      else real.advanceVersion();
      expect(real.readThread).toHaveBeenCalledTimes(3);
      await act(async () => { real.reads[2]!.resolve(response()); await reloaded; });
      expect(real.result.current.loading).toBe(false);
      expect(real.result.current.error).toBeUndefined();
      expect(real.readThread).toHaveBeenCalledTimes(3);
    } finally {
      real.unmount();
    }
  });
}
