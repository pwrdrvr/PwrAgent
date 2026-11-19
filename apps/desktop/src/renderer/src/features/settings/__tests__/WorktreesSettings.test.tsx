import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettingsSnapshot } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { WorktreesSettings } from "../WorktreesSettings";

afterEach(cleanup);

function snapshot(worktrees: Partial<DesktopSettingsSnapshot["worktrees"]>): DesktopSettingsSnapshot {
  return {
    worktrees: {
      storage: { value: "user-home", source: "default" },
      effectivePath: "/Users/sam/.pwragent/worktrees",
      ...worktrees,
    },
  } as DesktopSettingsSnapshot;
}

function renderSettings(worktrees: Partial<DesktopSettingsSnapshot["worktrees"]>, picked = "/Volumes/Dev") {
  const onWriteConfig = vi.fn(async () => true);
  const desktopApi = {
    pickDirectoryFromDisk: vi.fn(async () => ({ canceled: false as const, path: picked })),
  } as unknown as DesktopApi;
  render(
    <WorktreesSettings
      saving={false}
      snapshot={snapshot(worktrees)}
      onStorageChange={vi.fn(async () => {})}
      onWriteConfig={onWriteConfig}
      desktopApi={desktopApi}
    />,
  );
  return { onWriteConfig };
}

describe("WorktreesSettings worktree folder", () => {
  it("saves a chosen folder at once", async () => {
    const { onWriteConfig } = renderSettings({});
    expect(screen.getByLabelText("Worktree folder")).toHaveValue("Home folder");
    expect(screen.queryByRole("button", { name: "Use home folder" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Choose…" }));
    await waitFor(() => expect(onWriteConfig).toHaveBeenCalledWith({ worktrees: { baseDirectory: "/Volumes/Dev" } }));
  });

  it("returns to the home folder and warns when the folder is missing", async () => {
    const { onWriteConfig } = renderSettings({
      baseDirectory: "/Volumes/Dev",
      baseDirectoryAvailable: false,
      effectivePath: "/Volumes/Dev/.pwragent/worktrees",
    });
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.getByText(/\/Volumes\/Dev is not available\. Connect the drive/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use home folder" }));
    await waitFor(() => expect(onWriteConfig).toHaveBeenCalledWith({ worktrees: { baseDirectory: null } }));
  });

  it("offers Codex threads the folder only once a folder is chosen", async () => {
    renderSettings({});
    expect(screen.queryByRole("switch", { name: /Use for Codex threads too/ })).toBeNull();
    cleanup();
    const { onWriteConfig } = renderSettings({ baseDirectory: "/Volumes/Dev", baseDirectoryAvailable: true });
    const codex = screen.getByRole("switch", { name: /Use for Codex threads too/ });
    expect(codex).not.toBeChecked();
    expect(screen.getByText(/Codex Desktop lists only worktrees in its own folder/)).toBeInTheDocument();
    fireEvent.click(codex);
    await waitFor(() => expect(onWriteConfig).toHaveBeenCalledWith({ worktrees: { baseDirectoryIncludesCodex: true } }));
  });

  it("hides the folder for in-repository worktrees", () => {
    renderSettings({ storage: { value: "in-repo", source: "config" }, effectivePath: ".worktrees" });
    expect(screen.queryByLabelText("Worktree folder")).toBeNull();
    expect(screen.queryByRole("switch", { name: /Use for Codex threads too/ })).toBeNull();
  });
});
