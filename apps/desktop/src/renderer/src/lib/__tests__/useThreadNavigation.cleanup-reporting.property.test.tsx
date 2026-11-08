import { act, render, renderHook, cleanup, screen, within, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { AgentEvent } from "@pwragent/shared";
import { useThreadNavigation } from "../useThreadNavigation";
import { AppNoticeStack } from "../../features/notifications/AppNoticeStack";

afterEach(() => { cleanup(); vi.useRealTimers(); });

// Oracle: only an archive requested now may replace its action notice. Recovery
// and released-reference results belong to one durable, dismissible report.
it("models mixed recovered, deferred and manual completions without extending a toast lifetime", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("recovered", "deferred", "manual", "failure", "dismiss"), {
    minLength: 5, maxLength: 35,
  }), async (commands) => {
    vi.useFakeTimers();
    let receive!: (event: AgentEvent) => void;
    const onThreadActionError = vi.fn();
    const api = {
      onAgentEvent: (listener) => { receive = listener; return () => {}; },
    } satisfies Parameters<typeof useThreadNavigation>[0];
    const hook = renderHook(() => useThreadNavigation(api, { onThreadActionError }));
    let manualId: string | undefined;
    let dismissed = false;
    const backgroundIds = new Set<string>();
    let backgroundCount = 0;
    // Always exercise a recovered skip before the generated interleavings.
    for (const [index, command] of ["recovered", ...commands, "deferred"].entries()) {
      await act(async () => {
        if (command === "dismiss") {
          hook.result.current.dismissArchiveCleanupSummaryNotice();
          dismissed = true;
        } else {
          receive({ backend: "codex", notification: {
            method: "thread/archiveCleanup/completed",
            params: { threadId: `fixture-${index}`, archivedAt: index,
              ...(command === "manual" ? {} : { reporting: "background" }),
              ...(command === "failure" ? { error: "Provider unavailable" } : {}),
              cleanup: command === "failure" ? [] : [{ removedWorktree: false, deletedBranch: false,
                worktreePath: `/contrived/${index}`, skippedReason: "Uncommitted changes; worktree kept." }] },
          } } as AgentEvent);
          if (command !== "manual") backgroundCount += 1;
        }
      });
      if (command === "manual") {
        expect(hook.result.current.archiveThreadNotice?.title).toBe("Worktree cleanup skipped");
        manualId = hook.result.current.archiveThreadNotice?.id;
      } else {
        expect(hook.result.current.archiveThreadNotice?.id).toBe(manualId);
      }
      // No unsolicited completion may use the action error channel either.
      expect(onThreadActionError.mock.calls.filter(([event]) => event?.message)).toEqual([]);
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      const summary = hook.result.current.archiveCleanupSummaryNotice;
      if (dismissed) expect(summary).toBeUndefined();
      else {
        expect(summary?.autoDismiss).toBe(false);
        expect(summary?.message).toContain(`${backgroundCount} cleanup results`);
        expect(summary?.message).not.toContain("Thread archived");
        expect(summary?.facts?.length).toBeLessThanOrEqual(5);
        backgroundIds.add(summary!.id);
      }
    }
    expect(backgroundIds.size).toBeLessThanOrEqual(1);
    hook.unmount();
    vi.useRealTimers();
  }), { numRuns: 25 });
});

it("coalesces a contrived 16-completion recovery burst into one report", async () => {
  vi.useFakeTimers();
  let receive!: (event: AgentEvent) => void;
  const api = {
    onAgentEvent: (listener) => { receive = listener; return () => {}; },
  } satisfies Parameters<typeof useThreadNavigation>[0];
  const hook = renderHook(() => useThreadNavigation(api));
  for (let index = 0; index < 16; index += 1) {
    await act(async () => {
      receive({ backend: "codex", notification: { method: "thread/archiveCleanup/completed", params: {
        threadId: `recovered-${index}`, archivedAt: 1, reporting: "background",
        cleanup: [{ removedWorktree: false, deletedBranch: false, skippedReason: index < 2
          ? "Uncommitted changes; worktree kept." : "Worktree is still used by another active thread: sibling." }],
      } } } as AgentEvent);
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(hook.result.current.archiveThreadNotice).toBeUndefined();
    expect(hook.result.current.archiveCleanupSummaryNotice).toBeUndefined();
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(hook.result.current.archiveCleanupSummaryNotice?.message).toContain("16 cleanup results");
  expect(hook.result.current.archiveCleanupSummaryNotice?.message).toContain("16 kept");
});

it("lets the manual toast expire at nine seconds while the report survives until dismissal", async () => {
  vi.useFakeTimers();
  let receive!: (event: AgentEvent) => void;
  const api = {
    onAgentEvent: (listener) => { receive = listener; return () => {}; },
  } satisfies Parameters<typeof useThreadNavigation>[0];
  function Notices() {
    const navigation = useThreadNavigation(api);
    return <AppNoticeStack durableNotices={[]} onDismissDurable={() => {}} transientNotices={[
      { notice: navigation.archiveThreadNotice, onDismiss: navigation.dismissArchiveThreadNotice },
      { notice: navigation.archiveCleanupSummaryNotice, onDismiss: navigation.dismissArchiveCleanupSummaryNotice },
    ]} />;
  }
  render(<Notices />);
  const complete = (threadId: string, background: boolean): AgentEvent => ({ backend: "codex", notification: {
    method: "thread/archiveCleanup/completed", params: { threadId, archivedAt: 1,
      ...(background ? { reporting: "background" as const } : {}),
      cleanup: [{ removedWorktree: false, deletedBranch: false, skippedReason: "Snapshot failed; checkout kept." }] },
  } });
  await act(async () => { receive(complete("manual", false)); });
  expect(screen.getByText("Worktree cleanup skipped")).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
    receive(complete("recovered", true));
    await vi.advanceTimersByTimeAsync(7_999);
  });
  expect(screen.getByText("Worktree cleanup skipped")).toBeTruthy();
  expect(screen.getByText("Background worktree cleanup")).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.queryByText("Worktree cleanup skipped")).toBeNull();
  await act(async () => {
    receive(complete("deferred", true));
    await vi.advanceTimersByTimeAsync(60_000);
  });
  const report = screen.getByText("Background worktree cleanup").closest("aside")!;
  expect(report.querySelector(".app-notice-toast__timer")).toBeNull();
  fireEvent.click(within(report).getByRole("button", { name: "Dismiss notice" }));
  await act(async () => {
    receive(complete("later-recovery", true));
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(screen.queryByText("Background worktree cleanup")).toBeNull();
});
