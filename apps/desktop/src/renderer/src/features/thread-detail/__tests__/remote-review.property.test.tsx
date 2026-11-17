import { cleanup, render, waitFor } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { TranscriptReview } from "../TranscriptReview";

afterEach(() => {
  cleanup();
  delete (window as unknown as { pwragent?: unknown }).pwragent;
});

it("reads a mounted review from its thread owner regardless of the project path", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 1, max: 100000 }),
    fc.integer({ min: 1, max: 100000 }),
    async (owner, directory) => {
      const instanceId = `owner-${owner}`;
      const listThreadReviews = vi.fn(async () => ({ reviews: [] }));
      Object.assign(window, { pwragent: { listThreadReviews } });
      const { unmount } = render(<TranscriptReview
        entry={{ type: "review", id: "artifact", review: "A finding" }}
        parentThreadId="thread" parentThreadBackend="codex"
        threadLinkSource={{ backend: "codex", instanceId }}
        fileViewerContext={{ key: "thread", title: "Thread", projectPath: `/owner/worktrees/${directory}/project` }} />);
      try {
        await waitFor(() => expect(listThreadReviews).toHaveBeenCalledWith({ backend: "codex", threadId: "thread", status: "all",
          federationTarget: { scope: "remote", instanceId } }));
      } finally {
        unmount();
      }
    },
  ), { numRuns: 25 });
});

it("shows unsuccessful reviews without a clean verdict or completion actions on local and remote threads", async () => {
  await fc.assert(fc.asyncProperty(
    fc.boolean(),
    fc.constantFrom("interrupted" as const, "failed" as const, undefined),
    fc.boolean(),
    async (remote, status, structured) => {
      const listThreadReviews = vi.fn(async () => ({ reviews: [{
        id: "tracked", sourceKey: "artifact", backend: "codex", threadId: "thread",
        title: "Code review", status: "open", items: [], createdAt: 1, updatedAt: 1,
      }] }));
      Object.assign(window, { pwragent: { listThreadReviews } });
      const view = render(<TranscriptReview
        entry={{ type: "review", id: "artifact", review: "Reviewer failed to output a response.",
          ...(status ? { turn: { id: "turn", status } } : {}),
          ...(structured ? { output: { findings: [], overall_correctness: "patch is correct",
            overall_explanation: "No issues found." } } : {}),
        }}
        parentThreadId="thread" parentThreadBackend="codex"
        {...(remote ? { threadLinkSource: { backend: "codex" as const, instanceId: "peer" } } : {})} />);
      try {
        expect(view.getByText(status === "interrupted" ? "Review stopped"
          : status === "failed" ? "Review failed" : "Review did not complete")).toBeTruthy();
        await waitFor(() => expect(view.queryByText(/Mark handled/i)).toBeNull());
        expect(view.queryByText(/Patch correct|No issues found|0 findings/)).toBeNull();
        expect(listThreadReviews).not.toHaveBeenCalled();
      } finally {
        view.unmount();
      }
    },
  ), { numRuns: 12 });
});
