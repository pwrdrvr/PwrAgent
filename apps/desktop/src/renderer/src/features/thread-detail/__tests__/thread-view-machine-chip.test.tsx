import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { LaunchpadMachineControl } from "../../composer/LaunchpadMachineChip";
import { useIntegratedTerminals } from "../../../lib/useIntegratedTerminals";
import {
  ThreadView as ThreadViewWithTerminals,
  type ThreadViewProps,
} from "../ThreadView";

function ThreadView(props: Omit<ThreadViewProps, "terminals">): ReactElement {
  const terminals = useIntegratedTerminals(props.desktopApi);
  return <ThreadViewWithTerminals {...props} terminals={terminals} />;
}

afterEach(() => {
  cleanup();
});

const baseProps: Omit<ThreadViewProps, "terminals"> = {
  addOptimisticUserMessage: () => "optimistic-1",
  backends: [],
  clearPendingRequest: () => undefined,
  composerDisabled: false,
  loading: false,
  loadingMore: false,
  messageCount: 0,
  skills: [],
  transcriptEntries: [],
  onLoadOlder: async () => undefined,
  removeOptimisticMessage: () => undefined,
};

const machine: LaunchpadMachineControl = {
  local: { label: "Harbor Mac / default", shortLabel: "Harbor", instanceId: "harbor" },
  targets: [{ availability: "available", instanceId: "studio", label: "Studio Mac" }],
  project: { kind: "directory", label: "Example", path: "/repo" },
  localHasProject: true,
  planRetarget: async () => undefined,
};

describe("ThreadView machine chip", () => {
  it("puts the launchpad's machine picker in the title rail, not the composer", () => {
    render(
      <ThreadView
        {...baseProps}
        launchpadMachine={machine}
        selectedDirectory={{
          key: "directory:/repo", kind: "directory", label: "Example", path: "/repo",
        }}
        selectedLaunchpad={{
          backend: "codex", directoryKey: "directory:/repo", directoryKind: "directory",
          directoryLabel: "Example", directoryPath: "/repo", executionMode: "default",
          prompt: "", workMode: "worktree", createdAt: 1, updatedAt: 1,
        }}
      />,
    );

    const picker = screen.getByRole("button", { name: "Machine" });
    expect(picker).toHaveTextContent("Harbor");
    expect(picker.closest(".thread-header__machine")).not.toBeNull();
    expect(
      within(screen.getByLabelText("New thread settings"))
        .queryByRole("button", { name: "Machine" }),
    ).toBeNull();
  });

  it("names the thread's machine in the same place", () => {
    const thread: NavigationThreadSummary = {
      id: "created", source: "codex", title: "Created", titleSource: "explicit",
      linkedDirectories: [], inbox: { inInbox: false },
    };
    render(
      <ThreadView
        {...baseProps}
        selectedThread={thread}
        threadMachine={{ label: "Harbor Mac / default", shortLabel: "Harbor", instanceId: "harbor" }}
      />,
    );

    const chip = screen.getByLabelText("Runs on Harbor");
    expect(chip.closest(".thread-header__machine")).not.toBeNull();
    expect(
      within(screen.getByLabelText("Thread settings")).queryByLabelText("Runs on Harbor"),
    ).toBeNull();
  });
});
