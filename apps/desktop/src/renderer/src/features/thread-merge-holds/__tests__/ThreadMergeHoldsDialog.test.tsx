import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManageThreadMergeHoldsRequest, NavigationThreadSummary, ThreadMergeHold } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ThreadMergeHoldsDialog } from "../ThreadMergeHoldsDialog";

afterEach(cleanup);
const thread: NavigationThreadSummary = { id: "waiting", source: "codex", title: "Windows MCP link", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false } };
const hold: ThreadMergeHold = { id: "hold-1", backend: "codex", threadId: "waiting", reason: "Waiting for Windows validation", releaseWhen: "Findings reconciled with PR #17", pullRequestUrls: [], status: "waiting", createdAt: 1, updatedAt: 1, createdBy: "operator" };

describe("merge holds dialog", () => {
  it("creates a hold without any continuation or Start thread action", async () => {
    const manage = vi.fn(async (_request: ManageThreadMergeHoldsRequest) => ({ holds: [], dependents: [] }));
    render(<ThreadMergeHoldsDialog thread={thread} api={{ manageThreadMergeHolds: manage } as DesktopApi} onClose={vi.fn()} />);
    await waitFor(() => expect(manage).toHaveBeenCalledWith(expect.objectContaining({ action: "list" })));
    fireEvent.change(screen.getByRole("textbox", { name: "Hold merge because" }), { target: { value: hold.reason } });
    fireEvent.change(screen.getByRole("textbox", { name: "Release when" }), { target: { value: hold.releaseWhen } });
    fireEvent.click(screen.getByRole("button", { name: "Hold merge" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith(expect.objectContaining({ action: "create", backend: "codex", threadId: "waiting", reason: hold.reason, releaseWhen: hold.releaseWhen })));
    expect(screen.queryByRole("button", { name: "Start thread" })).not.toBeInTheDocument();
  });

  it("requires a resolution note, clears the exact hold, and keeps the audit history", async () => {
    let current = hold;
    const manage = vi.fn(async (request: ManageThreadMergeHoldsRequest) => {
      if (request.action === "resolve") current = { ...hold, status: "resolved", resolution: { note: request.note!, actor: "operator", at: 2 } };
      return { holds: [current], dependents: [] };
    });
    render(<ThreadMergeHoldsDialog thread={thread} api={{ manageThreadMergeHolds: manage } as DesktopApi} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Resolve hold…" }));
    expect(screen.getByRole("button", { name: "Resolve hold" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Findings or reason for clearing" }), { target: { value: "Windows checks passed; findings reconciled." } });
    fireEvent.click(screen.getByRole("button", { name: "Resolve hold" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith(expect.objectContaining({ action: "resolve", holdId: "hold-1", note: "Windows checks passed; findings reconciled." })));
    fireEvent.click(await screen.findByRole("button", { name: "Show history" }));
    expect(screen.getByText("Windows checks passed; findings reconciled.")).toBeInTheDocument();
  });

  it("reports completion to the waiting thread's remote owner", async () => {
    const owner = { scope: "remote" as const, instanceId: "mac-owner" };
    const manage = vi.fn(async (_request: ManageThreadMergeHoldsRequest) => ({ holds: [], dependents: [{ hold, owner }] }));
    render(<ThreadMergeHoldsDialog thread={{ ...thread, id: "validation" }} api={{ manageThreadMergeHolds: manage } as DesktopApi} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Report completion…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Findings or reason for clearing" }), { target: { value: "Investigation complete; findings reconciled." } });
    fireEvent.click(screen.getByRole("button", { name: "Resolve hold" }));
    await waitFor(() => expect(manage).toHaveBeenCalledWith({ action: "resolve", backend: "codex", threadId: "waiting", federationTarget: owner, holdId: "hold-1", note: "Investigation complete; findings reconciled." }));
  });

  it("keeps a failed resolution visible and does not clear the hold", async () => {
    const manage = vi.fn(async (request: ManageThreadMergeHoldsRequest) => {
      if (request.action === "resolve") throw new Error("Waiting thread's owner is offline");
      return { holds: [hold], dependents: [] };
    });
    render(<ThreadMergeHoldsDialog thread={thread} api={{ manageThreadMergeHolds: manage } as DesktopApi} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Resolve hold…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Findings or reason for clearing" }), { target: { value: "Done" } });
    fireEvent.click(screen.getByRole("button", { name: "Resolve hold" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("owner is offline");
    expect(screen.getByRole("button", { name: "Keep waiting" })).toBeInTheDocument();
  });
});
