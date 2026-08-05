import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { useComposerDraftStore } from "../../features/composer/useComposerDraftStore";
import { useQueuedTurnProjection } from "../useQueuedTurnProjection";

function buildThread(
  queuedTurns: NavigationThreadSummary["queuedTurns"],
): NavigationThreadSummary {
  return {
    id: "thread-1",
    title: "Thread",
    titleSource: "explicit",
    source: "codex",
    linkedDirectories: [],
    inbox: { inInbox: true },
    queuedTurns,
  } as NavigationThreadSummary;
}

describe("useQueuedTurnProjection", () => {
  it("mirrors FIFO entries from the snapshot and prunes dispatched ones", () => {
    const { result: storeResult } = renderHook(() => useComposerDraftStore());
    const store = storeResult.current;
    const scopeKey = "thread:codex:thread-1";

    // A local-only draft and an in-flight submission must survive
    // reconciliation untouched.
    store.setQueuedTurns(scopeKey, [
      {
        id: "local-1",
        text: "local only",
        imageAttachments: [],
        fileAttachments: [],
      },
      {
        id: "inflight-1",
        backendQueuePending: true,
        text: "in flight",
        imageAttachments: [],
        fileAttachments: [],
      },
    ]);

    const projection = renderHook(
      (props: { threads: NavigationThreadSummary[] }) =>
        useQueuedTurnProjection({
          composerDraftStore: store,
          threads: props.threads,
        }),
      {
        initialProps: {
          threads: [
            buildThread([
              {
                queueEntryId: "entry-1",
                origin: "manual",
                displayText: "queued elsewhere",
                createdAt: 1_000,
                position: 0,
              },
            ]),
          ],
        },
      },
    );

    let queued = store.getQueuedTurns(scopeKey);
    expect(queued.map((entry) => entry.id)).toEqual([
      "local-1",
      "inflight-1",
      "backend-queued:entry-1",
    ]);
    expect(
      queued.find((entry) => entry.queueEntryId === "entry-1")?.text,
    ).toBe("queued elsewhere");

    // The FIFO dispatched the entry: the next snapshot omits it and the
    // mirror is pruned while local state stays.
    projection.rerender({ threads: [buildThread([])] });
    queued = store.getQueuedTurns(scopeKey);
    expect(queued.map((entry) => entry.id)).toEqual(["local-1", "inflight-1"]);
  });
});
