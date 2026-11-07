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
