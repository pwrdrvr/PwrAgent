import { describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../desktop-api";
import { scopeDesktopApiToFederationTarget } from "../federation-desktop-api";

describe("scopeDesktopApiToFederationTarget", () => {
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
    const desktopApi = {
      openApplication,
      refreshDirectoryGitStatuses,
      readPwrSnapConnectionStatus,
      connectPwrSnap: vi.fn(),
      openPwrSnap: vi.fn(),
      openPwrSnapDownload: vi.fn(),
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
    expect(scopedApi?.connectPwrSnap).toBeUndefined();
    expect(scopedApi?.openPwrSnap).toBeUndefined();
    expect(scopedApi?.openPwrSnapDownload).toBeUndefined();
    expect(scopedApi?.openPath).toBeUndefined();
    expect(scopedApi?.revealPath).toBeUndefined();
    expect(scopedApi?.readMarkdownFile).toBeUndefined();
    expect(scopedApi?.openMarkdownFileViewer).toBeUndefined();
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
