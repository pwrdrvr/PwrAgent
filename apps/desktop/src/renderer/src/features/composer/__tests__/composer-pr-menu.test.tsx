import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import type {
  ManageThreadDependenciesRequest,
  ManageThreadDependenciesResponse,
  ThreadDependency,
} from "@pwragent/shared/contracts/thread-dependencies";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ComposerPrMenu } from "../ComposerPrMenu";
import { describeMergeBuildWatch, mergeBuildPullRequestUrl } from "../../pr-watches/merge-build-watches";

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

  it("lists the PRs Auto-fix covers and switches one off or back on, leaving a hands-off PR to the project", () => {
    const onToggle = vi.fn();
    const onTogglePr = vi.fn();
    render(
      <ComposerPrMenu
        thread={thread}
        desktopApi={{} as DesktopApi}
        watchMergeBuildsDefault
        className="composer__toggle"
        tooltip="Auto-fix PR"
        autoFix={{
          checked: true, available: true, onToggle, onTogglePr,
          coverage: [
            { prKey: "github.com/fork/app#3", label: "fork/app#3", state: "on" },
            { prKey: "github.com/upstream/app#7", label: "upstream/app#7", state: "off" },
            { prKey: "github.com/upstream/app#9", label: "upstream/app#9", state: "hands-off", reason: "hands-off, labeled takeover:yes" },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pull request automation" }));
    const covers = screen.getByRole("group", { name: "Pull requests Auto-fix covers" });
    expect(covers).toBeInTheDocument();
    const on = screen.getByRole("menuitemcheckbox", { name: /fork\/app#3\s*Repairs it/ });
    expect(on).toHaveAttribute("aria-checked", "true");
    const handsOff = screen.getByRole("menuitemcheckbox", { name: /upstream\/app#9\s*hands-off, labeled takeover:yes/ });
    expect(handsOff).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(handsOff);
    expect(onTogglePr).not.toHaveBeenCalled();
    fireEvent.click(on);
    expect(onTogglePr).toHaveBeenCalledWith("github.com/fork/app#3", false);
    fireEvent.click(screen.getByRole("button", { name: "Pull request automation" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /upstream\/app#7\s*Off for this PR/ }));
    expect(onTogglePr).toHaveBeenLastCalledWith("github.com/upstream/app#7", true);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("lists no PRs for a single covered PR, or where one PR's switch cannot reach the owner", () => {
    const one = [{ prKey: "github.com/fork/app#3", label: "fork/app#3", state: "on" as const }];
    const { unmount } = render(
      <ComposerPrMenu
        thread={thread} desktopApi={{} as DesktopApi} watchMergeBuildsDefault className="composer__toggle" tooltip="Auto-fix PR"
        autoFix={{ checked: true, available: true, onToggle: vi.fn(), onTogglePr: vi.fn(), coverage: one }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pull request automation" }));
    expect(screen.queryByRole("group", { name: "Pull requests Auto-fix covers" })).toBeNull();
    unmount();
    render(
      <ComposerPrMenu
        thread={thread} desktopApi={{} as DesktopApi} watchMergeBuildsDefault className="composer__toggle" tooltip="Auto-fix PR"
        autoFix={{ checked: true, available: true, onToggle: vi.fn(), coverage: [...one, { ...one[0]!, prKey: "k2", label: "fork/app#4" }] }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pull request automation" }));
    expect(screen.queryByRole("group", { name: "Pull requests Auto-fix covers" })).toBeNull();
  });

  it("toggles Auto-fix from the menu", () => {
    const { onToggle } = renderMenu([]);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Auto-fix PR/ }));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("names the newest open PR, else the one merged most recently", () => {
    const pr = (number: number, patch: Partial<PrSummary>): PrSummary => ({
      provider: "github.com", org: "example", repo: "app", number, url: `https://github.com/example/app/pull/${number}`,
      title: `PR ${number}`, state: "passing", lifecycleState: "open", ...patch,
    });
    const merged = (number: number, mergedAt: number) => pr(number, { state: "merged", lifecycleState: "merged", mergedAt });
    expect(mergeBuildPullRequestUrl([merged(40, 1), pr(41, { createdAt: 5 }), pr(42, { createdAt: 9 })])).toMatch(/\/42$/);
    // After the merge the menu still names that PR, not none.
    expect(mergeBuildPullRequestUrl([merged(39, 1), merged(41, 7), pr(43, { state: "closed", lifecycleState: "closed" })])).toMatch(/\/41$/);
    expect(mergeBuildPullRequestUrl([])).toBeUndefined();
  });

  it("matches a stopped watch to its PR whatever the URL's case, and ignores other waits", () => {
    const stopped = wait({ status: "cancelled", conditions: [{ backend: "codex", threadId: "feature", when: "merge_build", prUrl: PR_URL.toUpperCase() }] });
    expect(describeMergeBuildWatch({ waits: [stopped], defaultOn: true, prUrl: PR_URL }).detail).toBe("Off for this PR");
    const older = wait({ status: "cancelled", conditions: [{ backend: "codex", threadId: "feature", when: "merge_build", prUrl: "https://github.com/example/app/pull/7" }] });
    expect(describeMergeBuildWatch({ waits: [older], defaultOn: true, prUrl: PR_URL }).detail).toBe("Default: wakes if it fails");
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
