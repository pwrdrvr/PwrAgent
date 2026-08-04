import { describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../desktop-api";
import { scopeDesktopApiToFederationTarget } from "../federation-desktop-api";

describe("scopeDesktopApiToFederationTarget", () => {
  it("routes application opens remotely and removes local path helpers", async () => {
    const openApplication = vi.fn(async () => ({ opened: true }));
    const desktopApi = {
      openApplication,
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

    expect(openApplication).toHaveBeenCalledWith({
      applicationId: "vscode",
      kind: "editor",
      targetPath: "/remote/repo/file.ts",
      federationTarget,
    });
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
