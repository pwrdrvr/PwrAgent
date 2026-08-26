import { describe, expect, it } from "vitest";
import {
  insertSubthreadIdAfter,
  resolveThreadParentKey,
  sortSubthreadSummaries,
} from "../subthreads";
import type { NavigationThreadSummary } from "../contracts/navigation";
import {
  buildThreadIdentityKey,
} from "../contracts/navigation";
import { federatedThreadIdentityKey } from "../contracts/federation";

type ParentLinkedThread = Pick<
  NavigationThreadSummary,
  | "id"
  | "parentThreadBackend"
  | "parentThreadId"
  | "parentThreadInstanceId"
  | "source"
>;

describe("resolveThreadParentKey", () => {
  it("uses the remote owner identity when a local thread id collides", () => {
    const localParentKey = buildThreadIdentityKey("codex", "parent");
    const remoteParentKey = federatedThreadIdentityKey({
      backend: "codex",
      target: { scope: "remote", instanceId: "remote-owner" },
      threadId: "parent",
    });
    const parents = new Map<string, ParentLinkedThread>([
      [localParentKey, { id: "parent", source: "codex" }],
      [remoteParentKey, { id: "parent", source: "codex" }],
    ]);

    expect(resolveThreadParentKey({
      id: "child",
      source: "codex",
      parentThreadBackend: "codex",
      parentThreadId: "parent",
      parentThreadInstanceId: "remote-owner",
    }, parents)).toBe(remoteParentKey);
  });
});

describe("sortSubthreadSummaries", () => {
  it("orders explicitly-ranked children by subthreadOrder", () => {
    const sorted = sortSubthreadSummaries(
      { subthreadOrder: ["c", "a", "b"] },
      [
        { id: "a", createdAt: 1 },
        { id: "b", createdAt: 2 },
        { id: "c", createdAt: 3 },
      ],
    );
    expect(sorted.map((child) => child.id)).toEqual(["c", "a", "b"]);
  });

  it("falls back to newest-first by createdAt when unranked", () => {
    const sorted = sortSubthreadSummaries({ subthreadOrder: undefined }, [
      { id: "old", createdAt: 1 },
      { id: "new", createdAt: 3 },
      { id: "mid", createdAt: 2 },
    ]);
    expect(sorted.map((child) => child.id)).toEqual(["new", "mid", "old"]);
  });

  it("sorts ranked children ahead of unranked ones", () => {
    const sorted = sortSubthreadSummaries({ subthreadOrder: ["ranked"] }, [
      { id: "unranked-new", createdAt: 100 },
      { id: "ranked", createdAt: 1 },
    ]);
    expect(sorted.map((child) => child.id)).toEqual(["ranked", "unranked-new"]);
  });
});

describe("insertSubthreadIdAfter", () => {
  it("inserts immediately after the source child", () => {
    expect(insertSubthreadIdAfter(["a", "b", "c"], "b", "new")).toEqual([
      "a",
      "b",
      "new",
      "c",
    ]);
  });

  it("prepends when the source is the root (not in the child list)", () => {
    expect(insertSubthreadIdAfter(["a", "b"], "root", "new")).toEqual([
      "new",
      "a",
      "b",
    ]);
  });

  it("prepends into an empty tray", () => {
    expect(insertSubthreadIdAfter([], "root", "new")).toEqual(["new"]);
  });

  it("is idempotent when the new id already exists", () => {
    expect(insertSubthreadIdAfter(["a", "new", "b"], "a", "new")).toEqual([
      "a",
      "new",
      "b",
    ]);
  });
});
