import { describe, expect, it } from "vitest";
import type { AppServerReadThreadResponse } from "@pwragent/shared";
import {
  getThreadReplayFileDiff,
  shapeReadThreadFileDiffsForRenderer,
} from "../app-server/thread-file-diff-cache";

function buildReadThreadResponse(diff: string): AppServerReadThreadResponse {
  return {
    backend: "codex",
    fetchedAt: 1,
    threadId: "thread-lazy-replay",
    replay: {
      entries: [
        {
          type: "activity",
          id: "activity-1",
          createdAt: 1,
          summary: "Edited 1 file",
          details: [
            {
              id: "detail-1",
              kind: "write",
              label: "Update thread-view.test.tsx",
              path: "/repo/apps/desktop/src/renderer/src/features/thread-detail/__tests__/thread-view.test.tsx",
              fileDiff: {
                kind: "update",
                diff,
                additions: 128,
                removals: 0,
              },
            },
          ],
        },
      ],
      messages: [],
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
    },
  };
}

describe("thread file diff cache", () => {
  it("strips replay diff text into a fetchable thread diff ref", () => {
    const diff = [
      "@@ -1,2 +1,4 @@",
      " existing",
      "+added one",
      "+added two",
    ].join("\n");

    const shaped = shapeReadThreadFileDiffsForRenderer(
      buildReadThreadResponse(diff),
    );
    const detail =
      shaped.replay.entries[0]?.type === "activity"
        ? shaped.replay.entries[0].details[0]
        : undefined;

    expect(detail?.fileDiff).toMatchObject({
      kind: "update",
      diff: "",
      additions: 128,
      removals: 0,
      diffRef: {
        source: "thread",
        backend: "codex",
        threadId: "thread-lazy-replay",
        entryId: "activity-1",
        detailId: "detail-1",
      },
    });
    expect(detail?.fileDiff?.diffRef?.key).toContain(
      "thread:codex:thread-lazy-replay:activity-1:detail-1:",
    );
    expect(getThreadReplayFileDiff(detail!.fileDiff!.diffRef!)).toBe(diff);
  });

  it("does not attach a ref when a diff was already omitted", () => {
    const response = buildReadThreadResponse("large omitted body");
    const entry = response.replay.entries[0];
    if (entry.type !== "activity") {
      throw new Error("Expected activity entry");
    }
    entry.details[0]!.fileDiff!.omittedReason = "Large file diff omitted.";

    const shaped = shapeReadThreadFileDiffsForRenderer(response);
    const detail =
      shaped.replay.entries[0]?.type === "activity"
        ? shaped.replay.entries[0].details[0]
        : undefined;

    expect(detail?.fileDiff).toMatchObject({
      diff: "",
      omittedReason: "Large file diff omitted.",
    });
    expect(detail?.fileDiff?.diffRef).toBeUndefined();
  });
});
