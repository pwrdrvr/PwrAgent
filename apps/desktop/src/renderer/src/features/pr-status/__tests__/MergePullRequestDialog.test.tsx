import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
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

function renderDialog(held = false) {
  const merge = vi.fn<PullRequestMergeService["merge"]>(async () => true);
  const onClose = vi.fn();
  const desktopApi = {
    readThreadPullRequestMerge: vi.fn(async () => ({ fallback: "squash" as const })),
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
      pr={PR}
      thread={THREAD}
      service={{ api: desktopApi as unknown as DesktopApi, merge }}
      onClose={onClose}
    />,
  );
  return { merge, onClose };
}

afterEach(() => {
  cleanup();
});

describe("MergePullRequestDialog", () => {
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

  it("offers only Close while a wait holds the merge", async () => {
    renderDialog(true);
    expect(await screen.findByText("Merge waits for Lab validation.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /merge$/i })).toBeNull();
  });
});
