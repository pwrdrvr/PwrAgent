import { describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../desktop-api";
import { scopeDesktopApiToFederationTarget } from "../federation-desktop-api";

describe("scopeDesktopApiToFederationTarget", () => {
  it("scopes Agent and Token Miser mutations to the selected owner", async () => {
    const setThreadAgent = vi.fn();
    const setThreadTokenMiser = vi.fn();
    const target = { scope: "remote" as const, instanceId: "owner" };
    const api = scopeDesktopApiToFederationTarget({ setThreadAgent, setThreadTokenMiser }, target)!;
    await api.setThreadAgent!({ threadId: "collision", agent: null });
    await api.setThreadTokenMiser!({ threadId: "collision", enabled: null, federationTarget: { scope: "local" } });
    expect(setThreadAgent).toHaveBeenCalledExactlyOnceWith({ threadId: "collision", agent: null, federationTarget: target });
    expect(setThreadTokenMiser).toHaveBeenCalledExactlyOnceWith({ threadId: "collision", enabled: null, federationTarget: target });
  });

  it("routes remote filesystem operations to the owning peer and removes local path helpers", async () => {
    const openApplication = vi.fn(async () => ({ opened: true }));
    const refreshDirectoryGitStatuses = vi.fn(async () => ({
      scheduledCount: 1,
    }));
    const readPwrSnapConnectionStatus = vi.fn(async () => ({
      connectionId: "pwrsnap" as const,
      displayName: "PwrSnap" as const,
      availability: "running" as const,
      configured: true,
    }));
    const listWorktreeUnpublishedCommits = vi.fn(async () => ({
      commits: [],
      totalCommits: 0,
      truncated: false,
      maxCommits: 20,
      maxFilesPerCommit: 50,
    }));
    const getWorktreeUnpublishedCommitDiff = vi.fn(async () => ({}));
    const desktopApi = {
      openApplication,
      refreshDirectoryGitStatuses,
      readPwrSnapConnectionStatus,
      listWorktreeUnpublishedCommits,
      getWorktreeUnpublishedCommitDiff,
      connectPwrSnap: vi.fn(),
      openPwrSnap: vi.fn(),
      openPwrSnapDownload: vi.fn(),
      readPwrGitConnectionStatus: vi.fn(),
      connectPwrGit: vi.fn(),
      openPwrGit: vi.fn(),
      openPwrGitDownload: vi.fn(),
      openPath: vi.fn(),
      revealPath: vi.fn(),
      readMarkdownFile: vi.fn(),
      openMarkdownFileViewer: vi.fn(),
      readMarkdownFileViewerSnapshot: vi.fn(),
      onMarkdownFileViewerSnapshotChanged: vi.fn(),
    } as DesktopApi;
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };

    const scopedApi = scopeDesktopApiToFederationTarget(
      desktopApi,
      federationTarget,
    );
    await scopedApi?.openApplication?.({
      applicationId: "vscode",
      kind: "editor",
      targetPath: "/remote/repo/file.ts",
    });
    await scopedApi?.refreshDirectoryGitStatuses?.({
      directoryKeys: ["directory:/remote/repo"],
      force: true,
    });
    await scopedApi?.readPwrSnapConnectionStatus?.();
    await scopedApi?.listWorktreeUnpublishedCommits?.({
      backend: "codex",
      threadId: "thread-1",
      worktreePath: "/remote/repo",
    });
    await scopedApi?.getWorktreeUnpublishedCommitDiff?.({
      backend: "codex",
      threadId: "thread-1",
      worktreePath: "/remote/repo",
      commitSha: "a".repeat(40),
      path: "/remote/repo/file.ts",
    });

    expect(openApplication).toHaveBeenCalledWith({
      applicationId: "vscode",
      kind: "editor",
      targetPath: "/remote/repo/file.ts",
      federationTarget,
    });
    expect(refreshDirectoryGitStatuses).toHaveBeenCalledWith({
      directoryKeys: ["directory:/remote/repo"],
      force: true,
      federationTarget,
    });
    expect(readPwrSnapConnectionStatus).toHaveBeenCalledWith({
      federationTarget,
    });
    expect(listWorktreeUnpublishedCommits).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      worktreePath: "/remote/repo",
      federationTarget,
    });
    expect(getWorktreeUnpublishedCommitDiff).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      worktreePath: "/remote/repo",
      commitSha: "a".repeat(40),
      path: "/remote/repo/file.ts",
      federationTarget,
    });
    expect(scopedApi?.connectPwrSnap).toBeUndefined();
    expect(scopedApi?.openPwrSnap).toBeUndefined();
    expect(scopedApi?.openPwrSnapDownload).toBeUndefined();
    // A viewer's own PwrGit says nothing about the owner's machine.
    expect(scopedApi?.readPwrGitConnectionStatus).toBeUndefined();
    expect(scopedApi?.connectPwrGit).toBeUndefined();
    expect(scopedApi?.openPwrGit).toBeUndefined();
    expect(scopedApi?.openPwrGitDownload).toBeUndefined();
    expect(scopedApi?.openPath).toBeUndefined();
    expect(scopedApi?.revealPath).toBeUndefined();
    const thread = { backend: "codex" as const, threadId: "thread-1" };
    await scopedApi?.readMarkdownFile?.({ path: "/remote/report.md", thread, federationTarget: { scope: "local" } });
    expect(desktopApi.readMarkdownFile).toHaveBeenCalledWith({ path: "/remote/report.md", thread, federationTarget });
    await scopedApi?.openMarkdownFileViewer?.({
      context: { key: "thread-1", title: "Files", thread },
      file: { path: "/remote/report.md", label: "Report" },
    });
    expect(desktopApi.openMarkdownFileViewer).toHaveBeenCalledWith({
      context: { key: "remote:remote-instance:thread-1", title: "Files", thread, federationTarget },
      file: { path: "/remote/report.md", label: "Report" },
    });
    expect(scopedApi?.readMarkdownFileViewerSnapshot).toBeUndefined();
    expect(scopedApi?.onMarkdownFileViewerSnapshotChanged).toBeUndefined();
  });

  it("keeps the local desktop API unchanged without a remote target", () => {
    const desktopApi: DesktopApi = { openPath: vi.fn() };

    expect(scopeDesktopApiToFederationTarget(desktopApi, undefined)).toBe(
      desktopApi,
    );
  });
});
