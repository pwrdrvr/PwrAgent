import { describe, expect, it } from "vitest";
import type { NavigationThreadSummary, PrSummary } from "../contracts/navigation";
import { buildNavigationSnapshotHash } from "../navigation-state";

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

describe("buildNavigationSnapshotHash", () => {
  it.each(hoverCardFields)(
    "changes when PR hover-card field $field changes",
    ({ field, value }) => {
      const baseline = buildHash(pullRequest({ [field]: value }));
      const changed = buildHash(pullRequest({ [field]: value + 1 }));

      expect(changed).not.toBe(baseline);
    },
  );
});

function buildHash(pr: PrSummary): string {
  return buildNavigationSnapshotHash({
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
