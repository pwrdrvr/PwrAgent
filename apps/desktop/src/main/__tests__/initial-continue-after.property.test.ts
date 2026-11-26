import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import {
  INITIAL_THREAD_DEPENDENCY_CONDITIONS,
  parseInitialThreadContinueAfter,
  resolveInitialThreadContinueAfter,
  type InitialThreadDependencyCondition,
  type ThreadDependencyCiRun,
} from "@pwragent/shared/contracts/thread-dependencies";
import { parseCiRunUrl } from "../app-server/thread-dependency-ci-runs";
import { validateDependencyCreate } from "../app-server/thread-dependency-coordinator";

const BACKENDS = ["codex", "claude", "acp:antigravity"] as const satisfies readonly AppServerBackendKind[];

const validConditionArb: fc.Arbitrary<InitialThreadDependencyCondition> = fc.oneof(
  // Thread condition omitting backend & threadId (defaults to parent/raising thread)
  fc.record({
    when: fc.constantFrom("turn_completed", "pr_attached", "ci_passed", "pr_merged", "merge_build", "marked_done" as const),
    prUrl: fc.option(fc.constant("https://github.com/pwrdrvr/PwrGit/pull/688"), { nil: undefined }),
    headSha: fc.option(fc.constant("0c748a9d18e2e698aacae7bd836d7060636e81d5"), { nil: undefined }),
    turnId: fc.option(fc.constant("turn-parent-1"), { nil: undefined }),
    title: fc.option(fc.constant("Parent thread"), { nil: undefined }),
  }).map((c) => {
    const out: InitialThreadDependencyCondition = { when: c.when };
    if (c.title) out.title = c.title;
    if (c.when === "turn_completed" && c.turnId) out.turnId = c.turnId;
    if (c.when === "pr_attached" || c.when === "ci_passed" || c.when === "pr_merged") {
      if (c.prUrl) out.prUrl = c.prUrl;
      if (c.headSha) out.headSha = c.headSha;
    }
    if (c.when === "merge_build" && c.prUrl) out.prUrl = c.prUrl;
    return out;
  }),
  // Explicit thread condition
  fc.record({
    backend: fc.constantFrom(...BACKENDS),
    threadId: fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0),
    when: fc.constantFrom("turn_completed", "pr_attached", "ci_passed", "pr_merged", "merge_build", "marked_done" as const),
  }),
  // Remote marked_done condition
  fc.record({
    backend: fc.constantFrom(...BACKENDS),
    threadId: fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0),
    when: fc.constant("marked_done" as const),
    target: fc.record({
      scope: fc.constant("remote" as const),
      instanceId: fc.constantFrom("pwr_peer_1", "pwr_peer_2"),
    }),
  }),
  // Subject marked_done condition
  fc.record({
    when: fc.constant("marked_done" as const),
    subject: fc.string({ minLength: 1, maxLength: 60 }).filter((s) => s.trim().length > 0),
  }),
  // CI run condition (including generated run IDs, :443, query/fragment suffixes)
  fc.record({
    when: fc.constant("ci_run" as const),
    ciRun: fc.oneof(
      fc.tuple(
        fc.integer({ min: 1, max: 9_000_000_000_000 }),
        fc.constantFrom("", "?check_suite_focus=true", "#step:3:1", "?attempt=2#logs"),
      ).map(([runId, suffix]): ThreadDependencyCiRun => ({
        url: `https://github.com/pwrdrvr/PwrAgent/actions/runs/${runId}${suffix}`,
      })),
      fc.tuple(
        fc.integer({ min: 1, max: 9_000_000_000_000 }),
        fc.constantFrom("gitlab.com", "gitlab.com:443"),
        fc.constantFrom("", "?tab=jobs", "#job-1"),
      ).map(([runId, host, suffix]): ThreadDependencyCiRun => ({
        url: `https://${host}/pwrdrvr/pwragent/-/pipelines/${runId}${suffix}`,
        on: ["finished"],
      })),
      fc.constant<ThreadDependencyCiRun>({
        url: "https://github.com/pwrdrvr/PwrAgent/actions/runs/555",
        on: ["approval_gate"],
        environments: ["prod"],
      }),
    ),
  }),
);

describe("initial Continue After contract properties", () => {
  it("every parsed and resolved InitialThreadContinueAfter passes validateDependencyCreate (differential oracle)", () => {
    fc.assert(
      fc.property(
        fc.array(validConditionArb, { minLength: 1, maxLength: 16, size: "max" }),
        fc.constantFrom<"all" | "any" | undefined>("all", "any", undefined),
        fc.constantFrom<"notify" | "wait" | undefined>("notify", "wait", undefined),
        fc.constantFrom<"agent" | "operator" | undefined>("agent", "operator", undefined),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.constantFrom(...BACKENDS),
        fc.constantFrom(...BACKENDS),
        (conditions, mode, onFailure, deliver, handoff, holdMerge, wakeOnFailure, sourceBackend, childBackend) => {
          const hasMergeBuild = conditions.some((c) => c.when === "merge_build");
          const candidate: Record<string, unknown> = {
            conditions,
            continuation: "Fetch origin/main, rebase onto origin/main, verify, push, and open the PR.",
            ...(mode ? { mode } : {}),
            ...(onFailure ? { onFailure } : {}),
            ...(deliver ? { deliver } : {}),
            ...(deliver === "operator" && handoff ? { handoff: true } : {}),
            ...(deliver === "operator" ? { steps: ["Rebase onto main", "Open PR"] } : {}),
            ...(holdMerge && !hasMergeBuild ? { holdMerge: true } : {}),
            ...(wakeOnFailure && deliver !== "operator" ? { wakeOn: "failure" } : {}),
          };
          const parsed = parseInitialThreadContinueAfter(candidate);
          expect(parsed.ok).toBe(true);
          if (!parsed.ok) return;
          const resolved = resolveInitialThreadContinueAfter(parsed.value, {
            backend: sourceBackend,
            threadId: "parent-thread-1",
            title: "Parent PR #688",
          });
          expect(() =>
            validateDependencyCreate({
              action: "create",
              backend: childBackend,
              threadId: "child-thread-1",
              ...resolved,
            }),
          ).not.toThrow();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("omitting both backend and threadId defaults to parent; providing only one is always rejected", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...BACKENDS),
        fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim().length > 0),
        fc.constantFrom("turn_completed", "pr_attached", "ci_passed", "pr_merged", "merge_build", "marked_done" as const),
        (sourceBackend, sourceThreadId, when) => {
          // Omitting both -> resolves to source thread
          const omitted = parseInitialThreadContinueAfter({
            conditions: [{ when }],
            continuation: "Continue after parent.",
          });
          expect(omitted.ok).toBe(true);
          if (omitted.ok) {
            const resolved = resolveInitialThreadContinueAfter(omitted.value, {
              backend: sourceBackend,
              threadId: sourceThreadId,
              title: "Parent Title",
            });
            expect(resolved.conditions[0]).toMatchObject({
              backend: sourceBackend,
              threadId: sourceThreadId,
              when,
              title: "Parent Title",
            });
          }

          // Only backend -> rejected
          expect(
            parseInitialThreadContinueAfter({
              conditions: [{ backend: sourceBackend, when }],
              continuation: "Continue.",
            }).ok,
          ).toBe(false);

          // Only threadId -> rejected
          expect(
            parseInitialThreadContinueAfter({
              conditions: [{ threadId: "other-thread", when }],
              continuation: "Continue.",
            }).ok,
          ).toBe(false);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("rejects unsupported initial conditions and enforces exact condition/step/length bounds", () => {
    for (const disallowed of ["compaction_completed", "local_file", "resource_checkout", "unknown"]) {
      const result = parseInitialThreadContinueAfter({
        conditions: [{ when: disallowed }],
        continuation: "Continue.",
      });
      expect(result.ok).toBe(false);
    }

    // Condition count bounds: 0 and 17 fail; 16 succeeds
    expect(parseInitialThreadContinueAfter({ conditions: [], continuation: "Go" }).ok).toBe(false);
    expect(
      parseInitialThreadContinueAfter({
        conditions: Array.from({ length: 16 }, () => ({ when: "pr_merged" })),
        continuation: "Go",
      }).ok,
    ).toBe(true);
    expect(
      parseInitialThreadContinueAfter({
        conditions: Array.from({ length: 17 }, () => ({ when: "pr_merged" })),
        continuation: "Go",
      }).ok,
    ).toBe(false);

    // Continuation length bounds: 8000 succeeds, 8001 fails
    expect(
      parseInitialThreadContinueAfter({
        conditions: [{ when: "pr_merged" }],
        continuation: "a".repeat(8000),
      }).ok,
    ).toBe(true);
    expect(
      parseInitialThreadContinueAfter({
        conditions: [{ when: "pr_merged" }],
        continuation: "a".repeat(8001),
      }).ok,
    ).toBe(false);

    // Steps bounds: 12 succeeds with deliver: operator, 13 fails
    expect(
      parseInitialThreadContinueAfter({
        conditions: [{ when: "pr_merged" }],
        deliver: "operator",
        steps: Array.from({ length: 12 }, (_, i) => `Step ${i + 1}`),
        continuation: "Go",
      }).ok,
    ).toBe(true);
    expect(
      parseInitialThreadContinueAfter({
        conditions: [{ when: "pr_merged" }],
        deliver: "operator",
        steps: Array.from({ length: 13 }, (_, i) => `Step ${i + 1}`),
        continuation: "Go",
      }).ok,
    ).toBe(false);

    // Bad ciRun URL fails fast
    expect(
      parseInitialThreadContinueAfter({
        conditions: [{ when: "ci_run", ciRun: { url: "https://example.com/not-a-run" } }],
        continuation: "Go",
      }).ok,
    ).toBe(false);

    // Non-safe-integer run IDs fail fast before worktree/thread creation
    expect(
      parseInitialThreadContinueAfter({
        conditions: [{ when: "ci_run", ciRun: { url: "https://github.com/owner/repo/actions/runs/9999999999999999999" } }],
        continuation: "Go",
      }).ok,
    ).toBe(false);

    // Browser-copied URLs with query/fragment and explicit :443 match parseCiRunUrl
    for (const validUrl of [
      "https://github.com/owner/repo/actions/runs/123456?check_suite_focus=true#step:3:1",
      "https://gitlab.com:443/group/project/-/pipelines/987654?tab=jobs#top",
    ]) {
      expect(parseInitialThreadContinueAfter({
        conditions: [{ when: "ci_run", ciRun: { url: validUrl } }],
        continuation: "Go",
      }).ok).toBe(true);
    }

    expect(INITIAL_THREAD_DEPENDENCY_CONDITIONS).not.toContain("compaction_completed");
  });

  it("matches parseCiRunUrl on github.com and gitlab.com URLs across run ID ranges, ports, credentials, queries, and fragments", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("https://", "http://", "https://user:pass@"),
        fc.constantFrom("github.com", "github.com:443", "gitlab.com", "gitlab.com:443", "gitlab.com:8443"),
        fc.oneof(
          fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }).map(String),
          fc.constantFrom("0", "9007199254740992", "9999999999999999999", "abc"),
        ),
        fc.constantFrom("", "/", "?check_suite_focus=true", "#step:3:1", "?a=1#b"),
        (scheme, host, runId, suffix) => {
          const path = host.startsWith("gitlab.com")
            ? `/group/project/-/pipelines/${runId}`
            : `/owner/repo/actions/runs/${runId}`;
          const url = `${scheme}${host}${path}${suffix}`;
          const parsed = parseInitialThreadContinueAfter({
            conditions: [{ when: "ci_run", ciRun: { url } }],
            continuation: "Go",
          });
          // On github.com / gitlab.com (without custom GHE hosts), parity must be exact
          // except non-443 ports on gitlab.com are neither github.com nor gitlab.com in parseCiRunUrl.
          if (host === "gitlab.com:8443") {
            expect(parsed.ok).toBe(false);
          } else {
            expect(parsed.ok).toBe(Boolean(parseCiRunUrl(url)));
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

