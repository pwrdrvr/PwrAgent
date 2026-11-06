import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageThreadMergeHoldsRequest, NavigationThreadSummary, ThreadMergeHold } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { parseFollowUpSteps, ThreadMergeHoldsDialog } from "../ThreadMergeHoldsDialog";

afterEach(cleanup);
const thread: NavigationThreadSummary = { id: "waiting", source: "codex", title: "Windows MCP link", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false } };
const hold: ThreadMergeHold = {
  id: "hold-1", backend: "codex", threadId: "waiting", reason: "Windows validation",
  followUp: ["Rebase onto #3291", "Merge #17"], pullRequestUrls: [], status: "waiting", createdAt: 1, updatedAt: 1, createdBy: "operator",
};

describe("wait until done dialog", () => {
  it("records what to wait for and the steps to be reminded of, without starting anything", async () => {
    const manage = vi.fn(async (_request: ManageThreadMergeHoldsRequest) => ({ holds: [], dependents: [] }));
    render(<ThreadMergeHoldsDialog thread={thread} api={{ manageThreadMergeHolds: manage } as DesktopApi} onClose={vi.fn()} />);
    await waitFor(() => expect(manage).toHaveBeenCalledWith(expect.objectContaining({ action: "list" })));
    fireEvent.change(screen.getByRole("textbox", { name: "Waiting for" }), { target: { value: hold.reason } });
    const offer = screen.getByRole("checkbox", { name: "Offer to send these steps to this thread" });
    expect(offer).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "When it’s done, remind me to" }), { target: { value: "- Rebase onto #3291\n\n2. Merge #17\n" } });
    fireEvent.click(offer);
    fireEvent.click(screen.getByRole("button", { name: "Start Waiting" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith(expect.objectContaining({
      action: "create", backend: "codex", threadId: "waiting", reason: hold.reason,
      followUp: ["Rebase onto #3291", "Merge #17"], offerToSend: true,
    })));
    expect(screen.queryByRole("button", { name: "Start thread" })).not.toBeInTheDocument();
  });

  it("leaves the reminder steps optional and never offers to send nothing", async () => {
    const manage = vi.fn(async (_request: ManageThreadMergeHoldsRequest) => ({ holds: [], dependents: [] }));
    render(<ThreadMergeHoldsDialog thread={thread} api={{ manageThreadMergeHolds: manage } as DesktopApi} onClose={vi.fn()} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Waiting for" }), { target: { value: "Review" } });
    fireEvent.click(screen.getByRole("button", { name: "Start Waiting" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith(expect.objectContaining({ action: "create", reason: "Review" })));
    const create = manage.mock.calls.find(([request]) => request.action === "create")![0];
    expect(create).not.toHaveProperty("followUp");
    expect(create).not.toHaveProperty("offerToSend");
  });

  it("shows the follow-up, requires a note to mark it done, and keeps the history", async () => {
    let current = hold;
    const manage = vi.fn(async (request: ManageThreadMergeHoldsRequest) => {
      if (request.action === "resolve") current = { ...hold, status: "resolved", resolution: { note: request.note!, actor: "operator", at: 2 } };
      return { holds: [current], dependents: [] };
    });
    render(<ThreadMergeHoldsDialog thread={thread} api={{ manageThreadMergeHolds: manage } as DesktopApi} onClose={vi.fn()} />);
    expect(await screen.findByText("Rebase onto #3291")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mark Done…" }));
    expect(screen.getByText("Mark Done reminds you of the 2 next steps, with this note.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark Done" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "What finished, or why you stopped waiting" }), { target: { value: "Windows checks passed." } });
    fireEvent.click(screen.getByRole("button", { name: "Mark Done" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith(expect.objectContaining({ action: "resolve", holdId: "hold-1", note: "Windows checks passed." })));
    fireEvent.click(await screen.findByRole("button", { name: "Show History" }));
    expect(screen.getByText("Windows checks passed.")).toBeInTheDocument();
  });

  it("lets the prerequisite thread mark the wait done on the waiting thread's remote owner", async () => {
    const owner = { scope: "remote" as const, instanceId: "mac-owner" };
    const manage = vi.fn(async (_request: ManageThreadMergeHoldsRequest) => ({ holds: [], dependents: [{ hold, owner }] }));
    render(<ThreadMergeHoldsDialog thread={{ ...thread, id: "validation" }} api={{ manageThreadMergeHolds: manage } as DesktopApi} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Mark Done…" }));
    expect(screen.queryByRole("button", { name: "Stop Waiting" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "What finished" }), { target: { value: "Investigation complete." } });
    fireEvent.click(screen.getByRole("button", { name: "Mark Done" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith({ action: "resolve", backend: "codex", threadId: "waiting", federationTarget: owner, holdId: "hold-1", note: "Investigation complete." }));
  });

  it("keeps a failed Mark Done visible and does not clear the wait", async () => {
    const manage = vi.fn(async (request: ManageThreadMergeHoldsRequest) => {
      if (request.action === "resolve") throw new Error("Waiting thread's owner is offline");
      return { holds: [hold], dependents: [] };
    });
    render(<ThreadMergeHoldsDialog thread={thread} api={{ manageThreadMergeHolds: manage } as DesktopApi} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Mark Done…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "What finished, or why you stopped waiting" }), { target: { value: "Done" } });
    fireEvent.click(screen.getByRole("button", { name: "Mark Done" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("owner is offline");
    expect(screen.getByRole("button", { name: "Keep Waiting" })).toBeInTheDocument();
  });

  it("reads one step per line, dropping list markers and blanks", () => {
    expect(parseFollowUpSteps("1) Rebase\n  * Re-run CI \n\n• Merge")).toEqual(["Rebase", "Re-run CI", "Merge"]);
  });
});
