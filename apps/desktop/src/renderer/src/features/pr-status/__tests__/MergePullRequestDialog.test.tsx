import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import type { CompactStackMembership } from "@pwragent/shared/stacks/stack-status";
import type { DesktopApi } from "../../../lib/desktop-api";
import { MergePullRequestDialog } from "../MergePullRequestDialog";
import type { PullRequestMergeService } from "../pull-request-merge-context";

/**
 * The chip menu's merge, for the keyboard: it opens on the card's method with
 * focus on Cancel, lists only the repository's methods, remembers a method
 * the operator changed to, and has nothing to confirm while a wait holds it.
 */
const THREAD = { backend: "codex", threadId: "thread-a" } as const;
const PR: PrSummary = {
  provider: "github.com", number: 11, org: "acme", repo: "orbit", title: "Change 11",
  url: "https://github.com/acme/orbit/pull/11", baseRefName: "main",
  state: "passing", checkState: "passing", lifecycleState: "open",
  allowedMergeMethods: ["squash", "merge"],
};

/** #11 is the top of a GitHub stack whose two lower layers are still open. */
const STACKED: CompactStackMembership = {
  key: "stack:github.com:acme/orbit:main", name: "Orbit", inferred: false, position: 3, count: 3,
  number: 11, health: "in_sync", trunk: "main", githubStack: 4402, openBelow: [9, 10],
};

function renderDialog(held = false, options: {
  stack?: CompactStackMembership;
  remote?: boolean;
  pr?: PrSummary;
  /** What the owner answers about the thread's project. */
  owner?: { neverMergeProject?: string; mergeBranches?: string[] };
} = {}) {
  const merge = vi.fn<PullRequestMergeService["merge"]>(async () => true);
  const onClose = vi.fn();
  const desktopApi = {
    readThreadPullRequestMerge: vi.fn(async () => ({ fallback: "squash" as const, ...options.owner })),
    manageThreadDependencies: vi.fn(async () => ({
      dependencies: [],
      mergeHolds: held ? [{
        id: "hold", backend: "codex", threadId: "thread-b", holdMerge: true, status: "waiting",
        mode: "all", onFailure: "notify", deliver: "operator", createdAt: 1, updatedAt: 1, evidence: [],
        conditions: [{ backend: "codex", threadId: "", when: "marked_done", subject: "Lab validation" }],
      }] : [],
    })),
    onAgentEvent: () => () => {},
  };
  render(
    <MergePullRequestDialog
      pr={options.pr ?? PR}
      thread={options.remote
        ? { ...THREAD, federationTarget: { scope: "remote", instanceId: "peer-a" } } as never
        : THREAD}
      service={{ api: desktopApi as unknown as DesktopApi, merge }}
      {...(options.stack ? { stack: options.stack } : {})}
      onClose={onClose}
    />,
  );
  return { merge, onClose };
}

afterEach(() => {
  cleanup();
});

describe("MergePullRequestDialog", () => {
  it.each<[string, string | undefined, string[] | undefined, boolean]>([
    ["refuses a PR into main when nothing is listed", "main", undefined, false],
    ["refuses a PR into main when pwrdrvr is listed", "main", ["pwrdrvr"], false],
    ["offers a PR into pwrdrvr when pwrdrvr is listed", "pwrdrvr", ["pwrdrvr"], true],
    ["offers a PR into pwrdrvr among several listed", "pwrdrvr", ["release", "pwrdrvr"], true],
    ["refuses a PR whose base is unknown", undefined, ["pwrdrvr"], false],
  ])("in a never-merge project, %s", async (_name, base, mergeBranches, offered) => {
    const { baseRefName: _base, ...rest } = PR;
    renderDialog(false, {
      pr: base ? { ...rest, baseRefName: base } : rest,
      owner: { neverMergeProject: "canvas", ...(mergeBranches ? { mergeBranches } : {}) },
    });
    if (offered) {
      expect(await screen.findByRole("button", { name: "Squash merge" })).toBeInTheDocument();
      return;
    }
    expect(await screen.findByText(mergeBranches
      ? `canvas merges only pull requests into ${mergeBranches.join(" or ")}. Change it from the project menu: Forge Automation.`
      : "canvas never merges its pull requests. Change it from the project menu: Forge Automation."))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Squash merge" })).toBeNull();
  });

  it("starts on Cancel and the card's method, and remembers a changed method", async () => {
    const user = userEvent.setup();
    const { merge, onClose } = renderDialog();
    expect(await screen.findByRole("dialog", { name: "Squash merge #11 into main?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

    await user.click(screen.getByRole("combobox", { name: "Merge method" }));
    expect(screen.queryByRole("option", { name: /Rebase and merge/ })).toBeNull();
    await user.click(screen.getByRole("option", { name: /Create a merge commit/ }));
    expect(screen.getByRole("dialog", { name: "Merge #11 into main?" })).toBeInTheDocument();

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Merge" }));
    });
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({ method: "merge", rememberMethod: true }));
    expect(onClose).toHaveBeenCalled();
  });

  it("does not remember the method it opened on", async () => {
    const user = userEvent.setup();
    const { merge } = renderDialog();
    await screen.findByRole("dialog", { name: "Squash merge #11 into main?" });
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Squash merge" }));
    });
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({ method: "squash", rememberMethod: false }));
  });

  it("says a GitHub stack's merge lands the open layers below, and sends that choice", async () => {
    const user = userEvent.setup();
    const { merge } = renderDialog(false, { stack: STACKED });
    expect(await screen.findByRole("dialog", { name: "Squash merge 3 PRs from its GitHub stack into main?" }))
      .toBeInTheDocument();
    expect(screen.getByText("#9 and #10 below #11 in its GitHub stack are still open. GitHub merges them first, then #11."))
      .toBeInTheDocument();
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Squash merge 3 PRs" }));
    });
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({ method: "squash", mergeOpenLayersBelow: [9, 10] }));
  });

  it("asks a peer's thread to merge the open layers below first, with nothing to confirm", async () => {
    const { merge } = renderDialog(false, { stack: STACKED, remote: true });
    expect(await screen.findByText("#9 and #10 below #11 in its GitHub stack are still open. Merge them first."))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /merge/i })).toBeNull();
    expect(merge).not.toHaveBeenCalled();
  });

  it("merges one PR when no layer below it is open", async () => {
    const user = userEvent.setup();
    const { merge } = renderDialog(false, { stack: { ...STACKED, openBelow: undefined } as CompactStackMembership });
    await screen.findByRole("dialog", { name: "Squash merge #11 into main?" });
    expect(screen.queryByText(/in its GitHub stack/)).toBeNull();
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Squash merge" }));
    });
    expect(merge.mock.calls[0]![0]).not.toHaveProperty("mergeOpenLayersBelow");
  });

  it("offers only Close while a wait holds the merge", async () => {
    renderDialog(true);
    expect(await screen.findByText("Merge waits for Lab validation.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /merge$/i })).toBeNull();
  });
});
