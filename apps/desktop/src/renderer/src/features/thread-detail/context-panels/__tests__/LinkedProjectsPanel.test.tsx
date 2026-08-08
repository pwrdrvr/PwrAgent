import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REMOTE_NATIVE_PICKER_TOOLTIP } from "../../../composer/native-picker-boundary";
import { LinkedProjectsPanel } from "../LinkedProjectsPanel";

afterEach(cleanup);

describe("LinkedProjectsPanel", () => {
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
    expect(pickDirectoryFromDisk).not.toHaveBeenCalled();
    expect(attachDirectoryToThread).not.toHaveBeenCalled();
  });
});
