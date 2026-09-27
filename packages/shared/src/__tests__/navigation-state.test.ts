import { describe, expect, it } from "vitest";
import type {
  NavigationThreadSummary,
  PrSummary,
  ThreadOverlayState,
} from "../contracts/navigation";
import type { AppServerThreadSummary } from "../contracts/normalized-app-server";
import {
  serializeNavigationSnapshotForHash,
  materializeNavigationThreads,
} from "../navigation-state";

type HoverCardField = keyof Pick<
  PrSummary,
  | "additions"
  | "deletions"
  | "changedFiles"
  | "commitCount"
  | "createdAt"
  | "mergedAt"
  | "closedAt"
>;

const hoverCardFields: Array<{ field: HoverCardField; value: number }> = [
  { field: "additions", value: 12 },
  { field: "deletions", value: 4 },
  { field: "changedFiles", value: 3 },
  { field: "commitCount", value: 2 },
  { field: "createdAt", value: 1_723_118_400_000 },
  { field: "mergedAt", value: 1_723_204_800_000 },
  { field: "closedAt", value: 1_723_291_200_000 },
];

describe("serializeNavigationSnapshotForHash", () => {
  it.each(hoverCardFields)(
    "changes when PR hover-card field $field changes",
    ({ field, value }) => {
      const baseline = buildHash(pullRequest({ [field]: value }));
      const changed = buildHash(pullRequest({ [field]: value + 1 }));

      expect(changed).not.toBe(baseline);
    },
  );

  it("changes when the Token Miser override changes", () => {
    const thread = navigationThread({ tokenMiserEnabled: false });
    const baseline = serializeNavigationSnapshotForHash({
      backend: "codex",
      threads: [thread],
    });
    const changed = serializeNavigationSnapshotForHash({
      backend: "codex",
      threads: [{ ...thread, tokenMiserEnabled: true }],
    });

    expect(changed).not.toBe(baseline);
  });

  it("changes when the monitor job suggestion override changes", () => {
    const thread = navigationThread({ monitorJobSuggestionsEnabled: false });
    const baseline = buildNavigationSnapshotHash({
      backend: "codex",
      threads: [thread],
    });
    const changed = buildNavigationSnapshotHash({
      backend: "codex",
      threads: [{ ...thread, monitorJobSuggestionsEnabled: true }],
    });

    expect(changed).not.toBe(baseline);
  });
});

describe("materializeNavigationThreads", () => {
  it("refreshes navigation for queued, failed, and cancelled promotion without granting authority", () => {
    const thread = appServerThread();
    const overlay: ThreadOverlayState = {
      backend: "codex", threadId: thread.id, executionMode: "default", extraLinkedDirectories: [],
    };
    const changes: Array<ThreadOverlayState["queuedAgentChange"]> = [
      { agent: { name: "Fixture manager", instructions: "Fixture instructions" }, requestedAt: 1 },
      { agent: { name: "Fixture manager" }, requestedAt: 1, error: "Fixture refresh failed" },
      undefined,
    ];
    const hashes = changes.map((change) => {
      const threads = materializeNavigationThreads({
        firstSnapshot: false, overlayByThreadKey: { [`codex:${thread.id}`]: { ...overlay, queuedAgentChange: change } },
        previousKnownThreadKeys: [], threads: [thread],
      });
      expect(threads[0]?.agent).toBeUndefined();
      expect(threads[0]?.agentChange).toEqual(change ? { enabled: true, ...(change.error ? { error: change.error } : {}) } : undefined);
      expect(JSON.stringify(threads[0]?.agentChange) ?? "").not.toContain("Fixture instructions");
      return buildNavigationSnapshotHash({ backend: "codex", threads });
    });
    expect(new Set(hashes).size).toBe(3);
  });

  it("projects the persisted Token Miser override onto navigation", () => {
    const thread = appServerThread();
    const overlay: ThreadOverlayState = {
      backend: "codex",
      threadId: thread.id,
      executionMode: "default",
      extraLinkedDirectories: [],
      tokenMiserEnabled: true,
    };

    const [materialized] = materializeNavigationThreads({
      firstSnapshot: false,
      overlayByThreadKey: { [`codex:${thread.id}`]: overlay },
      previousKnownThreadKeys: [],
      threads: [thread],
    });

    expect(materialized?.tokenMiserEnabled).toBe(true);
  });

  it("projects the persisted monitor job suggestion override onto navigation", () => {
    const thread = appServerThread();
    const overlay: ThreadOverlayState = {
      backend: "codex",
      threadId: thread.id,
      executionMode: "default",
      extraLinkedDirectories: [],
      monitorJobSuggestionsEnabled: true,
    };

    const [materialized] = materializeNavigationThreads({
      firstSnapshot: false,
      overlayByThreadKey: { [`codex:${thread.id}`]: overlay },
      previousKnownThreadKeys: [],
      threads: [thread],
    });

    expect(materialized?.monitorJobSuggestionsEnabled).toBe(true);
  });
});

function buildHash(pr: PrSummary): string {
  return serializeNavigationSnapshotForHash({
    backend: "codex",
    threads: [
      {
        source: "codex",
        id: "thread-pr-hover-card",
        title: "Keep PR hover metadata live",
        titleSource: "derived",
        linkedDirectories: [],
        prs: [pr],
        inbox: { inInbox: true, unread: false },
      } as NavigationThreadSummary,
    ],
  });
}

function pullRequest(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    provider: "github.com",
    number: 1381,
    org: "pwrdrvr",
    repo: "PwrAgent",
    title: "Show structured PR hover metadata",
    state: "pending",
    url: "https://github.com/pwrdrvr/PwrAgent/pull/1381",
    ...overrides,
  };
}

function appServerThread(): AppServerThreadSummary {
  return {
    source: "codex",
    id: "thread-token-miser-navigation",
    title: "Keep Token Miser state live",
    titleSource: "derived",
    linkedDirectories: [],
  };
}

function navigationThread(
  overrides: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary {
  return {
    ...appServerThread(),
    inbox: { inInbox: true },
    ...overrides,
  };
}
