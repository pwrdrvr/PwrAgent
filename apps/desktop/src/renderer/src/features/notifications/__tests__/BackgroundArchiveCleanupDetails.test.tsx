import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadLinkProvider } from "../../../lib/thread-links";
import { BackgroundArchiveCleanupReport } from "../../../lib/background-archive-cleanup-report";
import { AppNoticeToast } from "../AppNoticeToast";

afterEach(cleanup);

it("opens the shared blocker chip on its owner and copies every retained outcome", () => {
  const report = new BackgroundArchiveCleanupReport();
  for (let index = 0; index < 21; index++) {
    report.record("codex", { threadId: `archived-${index}`, archivedAt: index, cleanup: [{
      worktreePath: `/contrived/${index}`, removedWorktree: false, deletedBranch: false,
      ...(index >= 19 ? { error: `Snapshot failed ${index}` } : {
        skippedReason: "Worktree is still used by another active thread: blocker.",
        blockingThreads: [{ backend: "claude", threadId: "blocker", title: "Active owner work" }],
      }),
    }] }, { threadLink: { backend: "codex", threadId: `archived-${index}`, title: `Archived work ${index}`, instanceId: "peer" } });
  }
  const onShowThread = vi.fn();
  const copyText = vi.fn(async () => undefined);
  const notice = report.notice()!;
  render(<ThreadLinkProvider threads={[]} onShowThread={onShowThread}>
    <AppNoticeToast notice={notice} desktopApi={{ copyText }} onDismiss={() => undefined} />
  </ThreadLinkProvider>);
  fireEvent.click(screen.getAllByRole("button", { name: "Open thread Active owner work" })[0]!);
  expect(onShowThread).toHaveBeenCalledWith(expect.objectContaining({ backend: "claude", threadId: "blocker", instanceId: "peer" }));
  fireEvent.click(screen.getByRole("button", { name: "Copy notice" }));
  expect(copyText).toHaveBeenCalledExactlyOnceWith(notice.copyText);
  for (let index = 0; index < 21; index++) expect(notice.copyText).toContain(`/contrived/${index}`);
  expect(notice.copyText).toContain("Backend: claude");
  expect(notice.copyText).toContain("Instance ID: peer");
  const rows = document.querySelectorAll(".background-cleanup__outcome");
  expect(rows).toHaveLength(5);
  expect(rows[0]?.textContent).toContain("Snapshot failed 19");
  expect(rows[1]?.textContent).toContain("Snapshot failed 20");
});
