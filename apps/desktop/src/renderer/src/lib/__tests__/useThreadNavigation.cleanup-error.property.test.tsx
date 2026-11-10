import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentEvent, NavigationThreadSummary } from "@pwragent/shared";
import { AppNoticeToast } from "../../features/notifications/AppNoticeToast";
import { resolveThreadActionErrorNotice, type ThreadActionErrorEvent } from "../../features/notifications/thread-action-error-notice";
import type { DesktopApi } from "../desktop-api";
import { useThreadNavigation } from "../useThreadNavigation";

afterEach(cleanup);

async function cleanupFailure(capturedPaths: string[], returnedPaths: Array<string | undefined>, timing: "before response" | "after response") {
  let receive!: (event: AgentEvent) => void;
  const message = "Cleanup failed before all checkout results were available.";
  const completion: AgentEvent = { backend: "codex", notification: { method: "thread/archiveCleanup/completed", params: {
    threadId: "archived", archivedAt: 1, error: message,
    cleanup: returnedPaths.map((worktreePath) => ({ worktreePath, removedWorktree: false, deletedBranch: false })),
  } } };
  const onThreadActionError = vi.fn<(event: ThreadActionErrorEvent) => void>();
  const api: DesktopApi = {
    onAgentEvent: (listener) => { receive = listener; return () => {}; },
    archiveThread: async ({ threadId }) => {
      if (timing === "before response") receive(completion);
      return { backend: "codex", threadId, archivedAt: 1, cleanup: [], cleanupPending: true };
    },
  };
  const thread: NavigationThreadSummary = { id: "archived", source: "codex", title: "Repair build caching",
    titleSource: "explicit", inbox: { inInbox: true },
    linkedDirectories: capturedPaths.map((worktreePath, index) => ({ id: `checkout-${index}`, label: "Project",
      kind: "worktree", path: "/contrived/repository", worktreePath })),
  };
  const hook = renderHook(() => useThreadNavigation(api, { onThreadActionError }));
  try {
    await act(async () => { await hook.result.current.archiveThread(thread); });
    if (timing === "after response") act(() => receive(completion));
    const failure = onThreadActionError.mock.calls.find(([event]) => event.kind === "archive-thread" && event.message === message)?.[0];
    if (!failure?.message) throw new Error("Missing asynchronous cleanup failure");
    const notice = resolveThreadActionErrorNotice({ ...failure, message: failure.message });
    expect(failure.threadLink).toMatchObject({ backend: "codex", threadId: thread.id, title: thread.title });
    // Every path known when the action started or supplied by the completion
    // remains available, even when the provider supplies no item results.
    const knownPaths = new Set([...capturedPaths, ...returnedPaths.filter((path): path is string => Boolean(path))]);
    expect(new Set(failure.worktreePaths)).toEqual(knownPaths);
    expect(failure.worktreePaths).toHaveLength(knownPaths.size);
    for (const path of knownPaths) {
      expect(notice.facts?.some((fact) => fact.value === path)).toBe(true);
      expect(notice.copyText).toContain(`Worktree: ${path}\n`);
    }
    return notice;
  } finally { hook.unmount(); }
}

it.each(["before response", "after response"] as const)("keeps captured checkout paths in the toast and Copy when cleanup rejects %s without item results", async (timing) => {
  const path = "/contrived/worktrees/build-cache";
  const notice = await cleanupFailure([path], [], timing);
  const copyText = vi.fn(async (_text: string) => undefined);
  render(<AppNoticeToast notice={notice} desktopApi={{ copyText }} onDismiss={() => undefined} />);
  expect(screen.getByText(path)).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Copy notice" }));
  expect(copyText).toHaveBeenCalledExactlyOnceWith(notice.copyText);
  expect(copyText.mock.calls[0]?.[0]).toContain(path);
});

it("preserves the set of known checkout paths across partial results, duplicates and completion order", async () => {
  await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.uuid(), { minLength: 1, maxLength: 4 }),
    fc.array(fc.option(fc.uuid(), { nil: undefined }), { maxLength: 4 }), async (captured, returned) => {
      const paths = captured.map((id) => `/contrived/worktrees/${id}`);
      const results = [...returned.map((id) => id ? `/contrived/worktrees/${id}` : undefined), paths[0], paths[0]];
      for (const timing of ["before response", "after response"] as const) await cleanupFailure(paths, results, timing);
    }), { numRuns: 25 });
});
