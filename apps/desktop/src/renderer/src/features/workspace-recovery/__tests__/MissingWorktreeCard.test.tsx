import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecreateThreadWorktreeResponse, ThreadMissingWorkspace } from "@pwragent/shared";
import { MissingWorktreeCard, WorkspaceRecoveryNotice } from "../MissingWorktreeCard";

afterEach(() => {
  cleanup();
});

const WORKTREE = "/home/dev/.pwragent/worktrees/mf3k2q/atlas";
const MAIN = "/home/dev/src/atlas";

const missing: ThreadMissingWorkspace = {
  worktreePath: WORKTREE,
  repositoryPath: MAIN,
  repositoryAvailable: true,
  branch: "fix/retry-backoff",
  mainCheckoutBranch: "main",
};

function recreated(overrides: Partial<Extract<RecreateThreadWorktreeResponse, { status: "recreated" }>> = {}) {
  return {
    status: "recreated" as const,
    backend: "codex" as const,
    threadId: "t1",
    worktreePath: WORKTREE,
    branch: "fix/retry-backoff",
    steps: [],
    warnings: [],
    completedAt: 1,
    ...overrides,
  };
}

function refused(
  reason: Extract<RecreateThreadWorktreeResponse, { status: "failed" }>["reason"],
  message: string,
): RecreateThreadWorktreeResponse {
  return {
    status: "failed",
    backend: "codex",
    threadId: "t1",
    worktreePath: WORKTREE,
    reason,
    message,
    steps: [
      { id: "check-path", status: "done" },
      { id: "find-checkpoint", status: "skipped" },
      { id: "clear-record", status: "skipped" },
      { id: "add-worktree", status: "failed", detail: message },
      { id: "apply-checkpoint", status: "skipped" },
    ],
  };
}

function card() {
  return screen.getByRole("region", { name: /worktree/i });
}

describe("MissingWorktreeCard", () => {
  it("offers all three ways on, naming the branch each one lands on", () => {
    render(
      <MissingWorktreeCard
        missing={missing}
        onRecreate={vi.fn()}
        onMoveToMainCheckout={vi.fn()}
        onArchive={vi.fn()}
        onRecovered={vi.fn()}
      />,
    );

    expect(card()).toHaveTextContent("This thread’s worktree is gone");
    expect(card()).toHaveTextContent(WORKTREE);
    expect(card()).toHaveTextContent("Same folder, back on fix/retry-backoff.");
    expect(card()).toHaveTextContent(`Work in ${MAIN} from now on. It stays on main; nothing is switched or stashed.`);
    for (const name of ["Recreate", "Continue", "Archive"]) {
      expect(within(card()).getByRole("button", { name })).toBeEnabled();
    }
  });

  it("promises the checkpoint when PwrAgent kept one", () => {
    render(
      <MissingWorktreeCard
        missing={{ ...missing, checkpoint: { snapshotRef: "refs/codex/snapshots/a", snapshotCommit: "a41c9e2", archivedAt: Date.UTC(2026, 9, 20, 12) } }}
        onRecreate={vi.fn()}
        onRecovered={vi.fn()}
      />,
    );
    expect(card()).toHaveTextContent(/archived this worktree on Oct 20 and kept a checkpoint/);
    expect(card()).toHaveTextContent(/with the uncommitted changes saved on Oct 20/);
  });

  it("recreates and hands the result back", async () => {
    const response = recreated();
    const onRecreate = vi.fn(async () => response);
    const onRecovered = vi.fn();
    render(<MissingWorktreeCard missing={missing} onRecreate={onRecreate} onRecovered={onRecovered} />);

    fireEvent.click(screen.getByRole("button", { name: "Recreate" }));

    expect(card()).toHaveTextContent("Recreating worktree…");
    const planned = within(screen.getByRole("list", { name: "Steps" })).getAllByRole("listitem");
    // The same five steps the owner reports back, so the list does not reshuffle.
    expect(planned.map((item) => item.textContent)).toEqual([
      "To do: Check the folder is free",
      "To do: Look for a checkpoint",
      "To do: Clear Git’s record of the deleted folder",
      "To do: Add the worktree on fix/retry-backoff",
    ]);
    await waitFor(() => expect(onRecovered).toHaveBeenCalledWith({ kind: "recreated", response, checkpointArchivedAt: undefined }));
    expect(onRecreate).toHaveBeenCalledWith({});
  });

  it("offers a detached worktree when the branch is checked out elsewhere", async () => {
    const onRecreate = vi.fn()
      .mockResolvedValueOnce(refused("branch-checked-out", "fix/retry-backoff is checked out in /elsewhere."))
      .mockResolvedValueOnce(recreated({ branch: undefined }));
    const onRecovered = vi.fn();
    render(<MissingWorktreeCard missing={missing} onRecreate={onRecreate} onMoveToMainCheckout={vi.fn()} onRecovered={onRecovered} />);

    fireEvent.click(screen.getByRole("button", { name: "Recreate" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("checked out in /elsewhere");
    expect(screen.getByRole("list", { name: "Steps" })).toHaveTextContent("Failed: Add the worktree on fix/retry-backoff");
    // The alert carries the reason; the failed step does not repeat it.
    expect(screen.getAllByText(/checked out in \/elsewhere/)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Recreate Detached" }));
    await waitFor(() => expect(onRecreate).toHaveBeenLastCalledWith({ detached: true }));
    await waitFor(() => expect(onRecovered).toHaveBeenCalled());
  });

  it("asks before recreating without a pruned checkpoint", async () => {
    const onRecreate = vi.fn()
      .mockResolvedValueOnce(refused("checkpoint-missing", "The checkpoint is gone."))
      .mockResolvedValueOnce(recreated());
    render(<MissingWorktreeCard missing={missing} onRecreate={onRecreate} onRecovered={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Recreate" }));
    fireEvent.click(await screen.findByRole("button", { name: "Recreate Without Checkpoint" }));

    await waitFor(() => expect(onRecreate).toHaveBeenLastCalledWith({ skipCheckpoint: true }));
  });

  it("moves to the main checkout and reports which branch was left alone", async () => {
    const response = {
      backend: "codex" as const, threadId: "t1", repositoryPath: MAIN, branch: "main", warnings: [], completedAt: 1,
      linkedDirectory: { id: "pwragent-handoff:codex:t1", kind: "local" as const, label: "atlas", path: MAIN },
    };
    const onRecovered = vi.fn();
    render(
      <MissingWorktreeCard
        missing={missing}
        onMoveToMainCheckout={async () => response}
        onRecovered={onRecovered}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(onRecovered).toHaveBeenCalledWith({
      kind: "moved", response, previousBranch: "fix/retry-backoff",
    }));
  });

  it("names the machine to update when the owner is too old", async () => {
    const onArchive = vi.fn(async () => undefined);
    render(
      <MissingWorktreeCard
        missing={missing}
        ownerLabel="studio-mac"
        onRecreate={async () => {
          throw new Error("Error invoking remote method: Error: method_not_found: No federation handler registered for backend.recreateThreadWorktree");
        }}
        onArchive={onArchive}
        onRecovered={vi.fn()}
      />,
    );

    expect(card()).toHaveTextContent("On studio-mac");
    fireEvent.click(screen.getByRole("button", { name: "Recreate" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "studio-mac runs an older PwrAgent. Update PwrAgent on studio-mac to recreate or move this worktree. Archive still works.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(onArchive).toHaveBeenCalled());
  });

  it("waits for an offline owner, and for a live turn", () => {
    const view = render(
      <MissingWorktreeCard missing={missing} ownerLabel="studio-mac" ownerOffline onRecreate={vi.fn()} onArchive={vi.fn()} onRecovered={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Recreate" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Archive" })).toBeDisabled();
    expect(card()).toHaveTextContent("studio-mac is offline.");

    view.rerender(<MissingWorktreeCard missing={missing} turnActive onRecreate={vi.fn()} onRecovered={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Recreate" })).toBeDisabled();
    expect(card()).toHaveTextContent("Available when the current turn ends.");
  });

  it("leaves only Archive when the main checkout is gone too", () => {
    render(
      <MissingWorktreeCard
        missing={{ ...missing, repositoryAvailable: false, mainCheckoutBranch: undefined }}
        onRecreate={vi.fn()}
        onMoveToMainCheckout={vi.fn()}
        onArchive={vi.fn()}
        onRecovered={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Recreate" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Archive" })).toBeEnabled();
  });
});

describe("WorkspaceRecoveryNotice", () => {
  it("says when the checkpoint did not apply, and dismisses", () => {
    const onDismiss = vi.fn();
    render(
      <WorkspaceRecoveryNotice
        outcome={{
          kind: "recreated",
          response: recreated({
            checkpoint: { snapshotCommit: "a41c9e2", restored: false },
            warnings: ["The checkpoint did not apply cleanly, so nothing was applied. It is kept at a41c9e2."],
          }),
        }}
        onDismiss={onDismiss}
      />,
    );
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("Worktree recreated without its checkpoint.");
    expect(notice).toHaveTextContent("It is kept at a41c9e2.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("counts the restored files", () => {
    render(
      <WorkspaceRecoveryNotice
        outcome={{ kind: "recreated", response: recreated({ checkpoint: { snapshotCommit: "a41c9e2", restored: true, changedFileCount: 7 } }) }}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("checkpoint is back as 7 uncommitted files.");
  });
});
