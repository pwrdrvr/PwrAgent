import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type {
  ManageThreadDependenciesRequest,
  ManageThreadDependenciesResponse,
  ThreadDependency,
} from "@pwragent/shared/contracts/thread-dependencies";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ComposerPrMenu, describeMergeBuildWatch } from "../ComposerPrMenu";

const PR_URL = "https://github.com/example/app/pull/41";

const thread: NavigationThreadSummary = {
  id: "feature", title: "Widgets", titleSource: "explicit", source: "codex", inbox: { inInbox: false }, linkedDirectories: [],
};

const wait = (patch: Partial<ThreadDependency> = {}): ThreadDependency => ({
  id: "wait-1", backend: "codex", threadId: "feature", mode: "all", onFailure: "notify", status: "waiting",
  conditions: [{ backend: "codex", threadId: "feature", when: "merge_build", prUrl: PR_URL }],
  evidence: [], createdAt: 1, updatedAt: 1, ...patch,
});

function renderMenu(dependencies: ThreadDependency[], defaultOn = true) {
  const calls: ManageThreadDependenciesRequest[] = [];
  const manageThreadDependencies = vi.fn(async (request: ManageThreadDependenciesRequest): Promise<ManageThreadDependenciesResponse> => {
    calls.push(request);
    return { dependencies };
  });
  const onToggle = vi.fn();
  render(
    <ComposerPrMenu
      thread={thread}
      desktopApi={{ manageThreadDependencies } as unknown as DesktopApi}
      watchMergeBuildsDefault={defaultOn}
      prUrl={PR_URL}
      className="composer__toggle"
      tooltip="Auto-fix PR"
      autoFix={{ checked: true, available: true, onToggle }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Pull request automation" }));
  return { calls, onToggle };
}

describe("composer PR menu", () => {
  it("watches this thread's merge build on pass or fail when asked", async () => {
    const { calls } = renderMenu([]);
    const item = await screen.findByRole("menuitemcheckbox", { name: /Watch merge build\s*Default: wakes if it fails/ });
    expect(item).toHaveAttribute("aria-checked", "false");
    fireEvent.click(item);
    await waitFor(() => expect(calls.some((call) => call.action === "create")).toBe(true));
    expect(calls.find((call) => call.action === "create")).toEqual({
      action: "create", backend: "codex", threadId: "feature",
      conditions: [{ backend: "codex", threadId: "feature", when: "merge_build", prUrl: PR_URL, title: "Widgets" }],
    });
  });

  it("stops an active watch, including one PwrAgent armed on merge", async () => {
    const { calls } = renderMenu([wait({ automatic: true, wakeOn: "failure" })]);
    const item = await screen.findByRole("menuitemcheckbox", { name: /Watch merge build\s*Wakes if it fails/ });
    expect(item).toHaveAttribute("aria-checked", "true");
    fireEvent.click(item);
    await waitFor(() => expect(calls.find((call) => call.action === "cancel")).toMatchObject({ dependencyId: "wait-1" }));
  });

  it("toggles Auto-fix from the menu", () => {
    const { onToggle } = renderMenu([]);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Auto-fix PR/ }));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("describes the watch from the thread's own waits and the default", () => {
    expect(describeMergeBuildWatch({ waits: [], defaultOn: false })).toEqual({ checked: false, detail: "Off" });
    expect(describeMergeBuildWatch({ waits: [wait()], defaultOn: true })).toEqual({ checked: true, detail: "Wakes on pass or fail" });
    expect(describeMergeBuildWatch({ waits: [wait({ status: "cancelled" })], defaultOn: true, prUrl: PR_URL }))
      .toEqual({ checked: false, detail: "Off for this PR" });
    // A delivered watch for an earlier PR leaves the default in charge.
    expect(describeMergeBuildWatch({ waits: [wait({ status: "delivered" })], defaultOn: true, prUrl: PR_URL }))
      .toEqual({ checked: false, detail: "Default: wakes if it fails" });
  });
});
