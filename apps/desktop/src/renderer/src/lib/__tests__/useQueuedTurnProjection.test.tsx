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
  it("orders queue absence against the owner snapshot timestamp", () => {
    const { result: storeResult } = renderHook(() => useComposerDraftStore());
    const store = storeResult.current;
    const scopeKey = "thread:codex:thread-1";
    store.setQueuedTurns(scopeKey, [
      {
        id: "local-acknowledged",
        queueEntryId: "entry-1",
        queueEntryCreatedAt: 2_000,
        text: "wait for admission",
        imageAttachments: [],
        fileAttachments: [],
      },
    ]);

    const projection = renderHook(
      (props: {
        snapshotFetchedAt: number;
        threads: NavigationThreadSummary[];
      }) =>
        useQueuedTurnProjection({
          composerDraftStore: store,
          snapshotFetchedAt: props.snapshotFetchedAt,
          threads: props.threads,
        }),
      {
        initialProps: {
          // This navigation snapshot predates the queue acknowledgement.
          snapshotFetchedAt: 1_000,
          threads: [buildThread([])],
        },
      },
    );

    expect(store.getQueuedTurn(scopeKey)?.id).toBe("local-acknowledged");

    projection.rerender({
      snapshotFetchedAt: 3_000,
      threads: [buildThread([])],
    });

    expect(store.getQueuedTurn(scopeKey)).toBeUndefined();
  });

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
          snapshotFetchedAt: 2_000,
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

    projection.rerender({
      threads: [
        buildThread([
          {
            queueEntryId: "entry-1",
            origin: "manual",
            displayText: "queued elsewhere",
            createdAt: 1_000,
            position: 0,
            manualReleaseRequired: true,
            holdReason: "Provider unavailable",
          },
        ]),
      ],
    });
    expect(
      store.getQueuedTurns(scopeKey).find(
        (entry) => entry.queueEntryId === "entry-1",
      ),
    ).toMatchObject({
      manualReleaseRequired: true,
      holdReason: "Provider unavailable",
    });

    // The FIFO dispatched the entry: the next snapshot omits it and the
    // mirror is pruned while local state stays.
    projection.rerender({ threads: [buildThread([])] });
    queued = store.getQueuedTurns(scopeKey);
    expect(queued.map((entry) => entry.id)).toEqual(["local-1", "inflight-1"]);
  });

  it("restores a newly held head ahead of previously mirrored entries", () => {
    const { result: storeResult } = renderHook(() => useComposerDraftStore());
    const store = storeResult.current;
    const scopeKey = "thread:codex:thread-1";
    store.setQueuedTurns(scopeKey, [
      {
        id: "backend-queued:older",
        queueEntryId: "older",
        queueEntryCreatedAt: 1_000,
        text: "Older queued message",
        imageAttachments: [],
        fileAttachments: [],
      },
    ]);

    renderHook(() =>
      useQueuedTurnProjection({
        composerDraftStore: store,
        snapshotFetchedAt: 3_000,
        threads: [
          buildThread([
            {
              queueEntryId: "held-head",
              origin: "manual",
              displayText: "Interrupted steer",
              createdAt: 2_000,
              position: 0,
              manualReleaseRequired: true,
              holdReason: "Provider unavailable",
            },
            {
              queueEntryId: "older",
              origin: "manual",
              displayText: "Older queued message",
              createdAt: 1_000,
              position: 1,
              manualReleaseRequired: true,
              holdReason: "Provider unavailable",
            },
          ]),
        ],
      }),
    );

    expect(store.getQueuedTurns(scopeKey).map((entry) => entry.queueEntryId))
      .toEqual(["held-head", "older"]);
  });
});
