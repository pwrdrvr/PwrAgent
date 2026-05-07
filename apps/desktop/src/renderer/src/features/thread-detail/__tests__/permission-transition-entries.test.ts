import { describe, expect, it } from "vitest";
import type {
  AppServerThreadEntry,
  ThreadPermissionTransition,
} from "@pwragent/shared";
import {
  PERMISSION_TRANSITION_ENTRY_PREFIX,
  buildPermissionTransitionActivityEntries,
  injectPermissionTransitions,
  isPermissionTransitionEntry,
} from "../permission-transition-entries";

const t1: ThreadPermissionTransition = {
  id: "01HQ-Q",
  fromExecutionMode: "default",
  toExecutionMode: "full-access",
  status: "queued",
  occurredAt: 1_000,
  queueId: "queue-1",
};
const t2: ThreadPermissionTransition = {
  id: "01HQ-A",
  fromExecutionMode: "default",
  toExecutionMode: "full-access",
  status: "applied",
  occurredAt: 2_000,
  queueId: "queue-1",
};
const t3: ThreadPermissionTransition = {
  id: "01HQ-C",
  fromExecutionMode: "default",
  toExecutionMode: "full-access",
  status: "cancelled",
  occurredAt: 1_500,
  queueId: "queue-1",
};

describe("permission-transition-entries", () => {
  it("builds synthetic activity entries with prefixed ids", () => {
    const entries = buildPermissionTransitionActivityEntries([t1, t2, t3]);
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry.type).toBe("activity");
      expect(entry.id.startsWith(PERMISSION_TRANSITION_ENTRY_PREFIX)).toBe(true);
      expect(isPermissionTransitionEntry(entry)).toBe(true);
    }
  });

  it("renders queued transitions with warning tone and a clock icon", () => {
    const [entry] = buildPermissionTransitionActivityEntries([t1]);
    expect(entry.tone).toBe("warning");
    expect(entry.summary).toMatch(/Permissions queue/);
    expect(entry.summary).toMatch(/Default Access/);
    expect(entry.summary).toMatch(/Full Access/);
  });

  it("renders applied-from-queue transitions with warning tone (queueId present)", () => {
    const [entry] = buildPermissionTransitionActivityEntries([t2]);
    expect(entry.tone).toBe("warning");
    expect(entry.summary).toMatch(/Permissions changed/);
  });

  it("renders apply-immediately transitions without warning tone (no queueId)", () => {
    const apply: ThreadPermissionTransition = {
      ...t2,
      id: "01HQ-Z",
      queueId: undefined,
    };
    const [entry] = buildPermissionTransitionActivityEntries([apply]);
    expect(entry.tone).toBeUndefined();
  });

  it("renders cancelled transitions with warning tone", () => {
    const [entry] = buildPermissionTransitionActivityEntries([t3]);
    expect(entry.tone).toBe("warning");
    expect(entry.summary).toMatch(/Cancelled queued permissions change/);
  });

  it("returns the original entries array when transitions is empty", () => {
    const original: AppServerThreadEntry[] = [];
    expect(injectPermissionTransitions(original, undefined)).toBe(original);
    expect(injectPermissionTransitions(original, [])).toBe(original);
  });

  it("merges and orders synthetic entries by occurredAt", () => {
    const existing: AppServerThreadEntry[] = [
      {
        type: "message",
        id: "msg-1",
        role: "user",
        phase: "final",
        createdAt: 500,
        text: "hi",
      },
      {
        type: "message",
        id: "msg-2",
        role: "assistant",
        phase: "final",
        createdAt: 2_500,
        text: "hello",
      },
    ];

    const merged = injectPermissionTransitions(existing, [t1, t2, t3]);
    expect(merged.map((entry) => entry.id)).toEqual([
      "msg-1",
      `${PERMISSION_TRANSITION_ENTRY_PREFIX}${t1.id}`,
      `${PERMISSION_TRANSITION_ENTRY_PREFIX}${t3.id}`,
      `${PERMISSION_TRANSITION_ENTRY_PREFIX}${t2.id}`,
      "msg-2",
    ]);
  });

  it("inserts synthetic entries after coincident existing entries", () => {
    const existing: AppServerThreadEntry[] = [
      {
        type: "message",
        id: "msg-coincident",
        role: "assistant",
        phase: "final",
        createdAt: 1_000,
        text: "hello",
      },
    ];
    const merged = injectPermissionTransitions(existing, [t1]);
    expect(merged.map((entry) => entry.id)).toEqual([
      "msg-coincident",
      `${PERMISSION_TRANSITION_ENTRY_PREFIX}${t1.id}`,
    ]);
  });
});
