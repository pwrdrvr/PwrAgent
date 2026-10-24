import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REMOTE_NATIVE_PICKER_TOOLTIP } from "../../../composer/native-picker-boundary";
import { LinkedProjectsPanel } from "../LinkedProjectsPanel";

afterEach(cleanup);

describe("LinkedProjectsPanel", () => {
  it("routes secondary directory detachment to the remote owner and source thread", async () => {
    const target = { scope: "remote" as const, instanceId: "owner-one" };
    const directory = { id: "/owner/PwrGit", kind: "local" as const,
      label: "PwrGit", path: "/owner/PwrGit" };
    const detachDirectoryFromThread = vi.fn(async () => ({
      ok: true as const, backend: "codex" as const, threadId: "source-thread", directories: [],
    }));
    const onRefreshNavigation = vi.fn(async () => undefined);
    render(
      <LinkedProjectsPanel
        desktopApi={{ detachDirectoryFromThread }}
        onRefreshNavigation={onRefreshNavigation}
        hideTooltip={() => undefined}
        showTooltip={() => undefined}
        thread={{
          id: "mounted-thread", title: "PwrSnap", titleSource: "explicit", source: "codex",
          projectKey: "/owner/PwrSnap",
          federation: { ref: { backend: "codex", target, threadId: "source-thread" },
            instanceLabel: "Owner", peerStatus: "connected" },
          linkedDirectories: [
            { id: "/owner/PwrSnap", kind: "local", label: "PwrSnap", path: "/owner/PwrSnap" },
            directory,
          ],
          inbox: { inInbox: false },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Detach" }));
    await waitFor(() => expect(onRefreshNavigation).toHaveBeenCalledOnce());
    expect(detachDirectoryFromThread).toHaveBeenCalledWith({
      backend: "codex", federationTarget: target, threadId: "source-thread", directory,
    });
  });

  it("disables the native directory picker for a remote thread", () => {
    const pickDirectoryFromDisk = vi.fn();
    const attachDirectoryToThread = vi.fn();
    render(
      <LinkedProjectsPanel
        desktopApi={{
          attachDirectoryToThread,
          detachDirectoryFromThread: vi.fn(),
          pickDirectoryFromDisk,
        }}
        hideTooltip={() => undefined}
        showTooltip={() => undefined}
        thread={{
          id: "thread-1",
          title: "Remote thread",
          titleSource: "explicit",
          source: "codex",
          federation: {
            ref: {
              backend: "codex",
              target: {
                scope: "remote",
                instanceId: "owner-one",
              },
              threadId: "thread-1",
            },
            instanceLabel: "Owner",
            peerStatus: "connected",
          },
          linkedDirectories: [{
            id: "/owner/project",
            kind: "local",
            label: "Owner project",
            path: "/owner/project",
          }],
          inbox: { inInbox: false },
        }}
      />,
    );

    const addDirectory = screen.getByRole("button", { name: "Add directory" });
    expect(addDirectory).toBeDisabled();
    expect(addDirectory).toHaveAttribute(
      "data-tooltip",
      REMOTE_NATIVE_PICKER_TOOLTIP,
    );
  });
});
