import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerThreadReviewEntry, ThreadReview } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { TranscriptReview } from "../../thread-detail/TranscriptReview";

const entry: AppServerThreadReviewEntry = {
  type: "review", id: "artifact", review: "A cancellation regression.",
  output: {
    overall_correctness: "patch is incorrect", overall_explanation: "A cancellation regression.",
    findings: [{ title: "Abort pending exports", body: "Stop the export when its owner closes.", confidence_score: 0.9,
      code_location: { absolute_file_path: "/example/queue.ts", line_range: { start: 1, end: 2 } } }],
  },
};
const review: ThreadReview = {
  id: "review", backend: "codex", threadId: "owner", sourceKey: "artifact", title: "Code review", status: "open", createdAt: 1, updatedAt: 1,
  items: [{ id: "finding", title: "Abort pending exports", status: "open", createdAt: 1, updatedAt: 1 }],
};

function installApi(result: ThreadReview) {
  const api: Pick<DesktopApi, "listThreadReviews" | "updateThreadReview" | "onThreadTodosChanged"> = {
    listThreadReviews: vi.fn(async () => ({ reviews: [review] })),
    updateThreadReview: vi.fn(async () => ({ review: result })),
    onThreadTodosChanged: vi.fn(() => () => {}),
  };
  Object.assign(window, { pwragent: api });
  return api;
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { pwragent?: unknown }).pwragent;
  delete (window as unknown as { __pwragentFederationTarget?: unknown }).__pwragentFederationTarget;
});

describe("review status controls", () => {
  it("shares one pending read across two surfaces of the same review", async () => {
    const api = installApi(review);
    render(<>
      <TranscriptReview entry={entry} parentThreadId="owner" />
      <TranscriptReview entry={entry} parentThreadId="owner" />
    </>);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Dismiss review" })).toHaveLength(2));
    expect(api.listThreadReviews).toHaveBeenCalledTimes(1);
  });

  it("documents an addressed finding and keeps the original review visible", async () => {
    const api = installApi({
      ...review, status: "handled", resolution: { note: "All findings addressed or dismissed.", actor: "system", at: 2 },
      items: [{ ...review.items[0]!, status: "addressed", resolution: { note: "Added the abort handler.", url: "https://example.com/commit/fix", actor: "agent", at: 2 } }],
    });
    render(<TranscriptReview entry={entry} parentThreadId="owner" parentThreadBackend="codex" />);
    fireEvent.click(await screen.findByRole("button", { name: "Mark addressed: Abort pending exports" }));
    await waitFor(() => expect(api.updateThreadReview).toHaveBeenCalledWith({ id: "review", itemId: "finding", status: "addressed" }));
    await screen.findByText("All findings addressed or dismissed.");
    expect(screen.getByText("Abort pending exports")).toBeVisible();
    expect(screen.getByRole("link", { name: "Resolution" })).toHaveAttribute("href", "https://example.com/commit/fix");
    expect(screen.getByRole("button", { name: "Reopen finding: Abort pending exports" })).toBeVisible();
  });

  it("labels the whole review and its findings Do not address after dismissal", async () => {
    const api = installApi({ ...review, status: "dismissed", resolution: { note: "Dismissed by operator.", actor: "user", at: 2 } });
    render(<TranscriptReview entry={entry} parentThreadId="owner" />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss review" }));
    await waitFor(() => expect(screen.getAllByText("Do not address", { exact: true })).toHaveLength(2));
    expect(screen.getByText("Stop the export when its owner closes.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Mark addressed:/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reopen review" }));
    await waitFor(() => expect(api.updateThreadReview).toHaveBeenLastCalledWith({ id: "review", status: "open" }));
  });

  it("never looks up peer reviews in the local database", () => {
    const api = installApi(review);
    Object.assign(window, { __pwragentFederationTarget: { scope: "remote", instanceId: "peer" } });
    render(<TranscriptReview entry={entry} parentThreadId="owner" />);
    expect(api.listThreadReviews).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Dismiss review" })).not.toBeInTheDocument();
  });
});
