import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetThreadCheckoutHibernationResponse, ThreadHibernatedWorkspace } from "@pwragent/shared";
import { HibernatedCheckoutCard, removedOutputText, savedChangesText } from "../HibernatedCheckoutCard";

afterEach(() => {
  cleanup();
});

const DAY = 86_400_000;
const WORKTREE = "/home/dev/.pwragent/worktrees/k3m9q2/harbor-web";

function hibernated(overrides: Partial<ThreadHibernatedWorkspace> = {}): ThreadHibernatedWorkspace {
  return {
    worktreePath: WORKTREE,
    repositoryPath: "/home/dev/src/harbor-web",
    hibernatedAt: Date.now() - 5 * DAY,
    branch: "feat/checkout",
    changedFileCount: 3,
    changedBytes: 41 * 1024,
    removedOutput: ["node_modules"],
    runsSetup: true,
    ...overrides,
  };
}

const answer = (overrides: Partial<SetThreadCheckoutHibernationResponse> = {}): SetThreadCheckoutHibernationResponse => ({
  backend: "codex", threadId: "t1", keepAwake: false, hibernated: false, ...overrides,
});

describe("HibernatedCheckoutCard", () => {
  it("says what was saved and what the next message does", () => {
    render(<HibernatedCheckoutCard workspace={hibernated()} onRestore={vi.fn()} onKeepAwake={vi.fn()} />);
    const card = screen.getByRole("region", { name: /Checkout hibernated/ });
    expect(within(card).getByText("5 days ago")).toBeInTheDocument();
    expect(within(card).getByText(WORKTREE)).toBeInTheDocument();
    expect(within(card).getByText(
      "feat/checkout · 3 changed files saved to a recovery snapshot, 41 KB · node_modules removed",
    )).toBeInTheDocument();
    expect(card).toHaveTextContent(
      "Your next message brings it back first: Git checks out feat/checkout in the same folder, restores the 3 files, and runs the project's setup.",
    );
    expect(within(card).getByRole("button", { name: "Restore now" })).toBeEnabled();
    expect(within(card).getByRole("button", { name: "Keep it awake" })).toBeEnabled();
  });

  it("leaves out what does not apply", () => {
    render(<HibernatedCheckoutCard workspace={hibernated({ branch: undefined, changedFileCount: 0, removedOutput: undefined, runsSetup: false })} />);
    const card = screen.getByRole("region", { name: /Checkout hibernated/ });
    expect(within(card).getByText("No uncommitted changes")).toBeInTheDocument();
    expect(card).toHaveTextContent("Your next message brings it back first: Git checks out its saved commit in the same folder.");
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("calls the owner for Restore now and Keep it awake, and shows a refusal", async () => {
    const onRestore = vi.fn(async () => answer({ hibernated: true, restoreError: "feat/checkout is checked out in /elsewhere." }));
    const onKeepAwake = vi.fn(async () => answer({ keepAwake: true }));
    render(<HibernatedCheckoutCard workspace={hibernated()} onRestore={onRestore} onKeepAwake={onKeepAwake} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("feat/checkout is checked out in /elsewhere.");
    expect(onRestore).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Keep it awake" }));
    await waitFor(() => expect(onKeepAwake).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("follows a running restore step by step", () => {
    const { rerender } = render(<HibernatedCheckoutCard workspace={hibernated({ restoring: true, restorePhase: "checkout" })} />);
    const card = screen.getByRole("region", { name: /Restoring checkout/ });
    expect(card).toHaveAttribute("aria-busy", "true");
    const steps = within(card).getAllByRole("listitem");
    expect(steps.map((step) => step.textContent)).toEqual([
      `In progress: Check out feat/checkout${WORKTREE}`,
      "In progress: Restore 3 changed filesfrom the recovery snapshot",
      "To do: Run project setup",
    ]);
    rerender(<HibernatedCheckoutCard workspace={hibernated({ restoring: true, restorePhase: "setup" })} />);
    expect(within(screen.getByRole("region", { name: /Restoring checkout/ })).getAllByRole("listitem").map((step) => step.textContent?.split(":")[0]))
      .toEqual(["Done", "Done", "In progress"]);
  });

  it("waits for an offline owner", () => {
    render(<HibernatedCheckoutCard workspace={hibernated()} ownerLabel="studio-mac" ownerOffline onRestore={vi.fn()} />);
    expect(screen.getByText("On studio-mac · 5 days ago")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore now" })).toBeDisabled();
    expect(screen.getByText("studio-mac is offline. The checkout comes back when it is.")).toBeInTheDocument();
  });
});

describe("hibernated checkout copy", () => {
  it("names removed output folders once each", () => {
    expect(removedOutputText(["node_modules", "packages/web/node_modules", "dist", "target"])).toBe("node_modules, dist and target removed");
    expect(removedOutputText([])).toBeUndefined();
  });

  it("counts saved files", () => {
    expect(savedChangesText(hibernated({ changedFileCount: 1, changedBytes: 900 }))).toBe("1 changed file saved to a recovery snapshot, 900 B");
    expect(savedChangesText(hibernated({ changedFileCount: undefined }))).toBeUndefined();
  });
});
