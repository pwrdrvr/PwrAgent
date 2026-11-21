import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ReviewRunMode } from "@pwragent/shared/contracts/agent";
import type { AppServerReviewTarget } from "@pwragent/shared/contracts/normalized-app-server";
import { messagingReviewTargetForMode, resolveMessagingReviewRunMode } from "../messaging/core/messaging-review-claude-code";
import { messagingModules } from "./fixtures/messaging-controller-modules";
import { messagingReviewHarness } from "./fixtures/messaging-review-harness";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { SqliteMessagingRequestStore } from "../storage/messaging-request-store";
import { StateDb } from "../state/state-db";

const prUrl = "https://github.com/fixture/project/pull/7";
const targets: AppServerReviewTarget[] = [
  { type: "uncommittedChanges" },
  { type: "baseBranch", branch: "main" },
  { type: "commit", sha: "abc1234", title: null },
  { type: "custom", instructions: "Fixture" },
  { type: "pullRequest", url: prUrl },
  { type: "pullRequests", pullRequests: [{ url: prUrl }, { url: `${prUrl}1` }] },
  { type: "branch", branch: "feature/fixture" },
  { type: "path", path: "src" },
];

describe("messaging review mode rules", () => {
  /**
   * Oracle, written out case by case: an owner without modes keeps the
   * request; a managed review is the PwrAgent Sub Agent; otherwise an
   * unset request, or Claude Code, is Claude Code where it is available and
   * the Codex Sub Agent elsewhere; any other request stands.
   */
  it("resolves the run mode the picker shows and submits", () => {
    fc.assert(fc.property(
      fc.boolean(), fc.boolean(), fc.boolean(),
      fc.constantFrom<ReviewRunMode | undefined>(undefined, "codex-sub-agent", "pwragent-sub-agent", "claude-code-review"),
      (modeSupported, managed, claudeCodeAvailable, requested) => {
        let expected: ReviewRunMode | undefined;
        if (!modeSupported) expected = requested;
        else if (managed) expected = "pwragent-sub-agent";
        else if (requested === "codex-sub-agent" || requested === "pwragent-sub-agent") expected = requested;
        else expected = claudeCodeAvailable ? "claude-code-review" : "codex-sub-agent";
        expect(resolveMessagingReviewRunMode({ claudeCodeAvailable, managed, modeSupported, requested })).toEqual(expected);
      },
    ));
  });

  /**
   * Oracle: Claude Code takes current changes, pull requests, a branch and
   * a path, and replaces anything else with current changes. Every other
   * mode replaces a branch or path with the base branch.
   */
  it("keeps only a target the mode can review", () => {
    fc.assert(fc.property(
      fc.constantFrom(...targets),
      fc.constantFrom<ReviewRunMode | undefined>(undefined, "codex-sub-agent", "pwragent-sub-agent", "claude-code-review"),
      (target, runMode) => {
        const claudeTakes = new Set(["uncommittedChanges", "pullRequest", "pullRequests", "branch", "path"]);
        const expected = runMode === "claude-code-review"
          ? claudeTakes.has(target.type) ? target : { type: "uncommittedChanges" }
          : target.type === "branch" || target.type === "path" ? { type: "baseBranch", branch: "trunk" } : target;
        expect(messagingReviewTargetForMode(target, runMode, "trunk")).toEqual(expected);
      },
    ));
  });
});

describe("messaging /review on a Claude thread", () => {
  const claudeFixture = async () => {
    const fixture = await messagingReviewHarness("telegram", 1, undefined, "claude");
    const { tempDir, dbPath } = createTempStateDb("pwragent-claude-review-picker-");
    const db = StateDb.open(dbPath);
    fixture.controllerOptions.requestStore = new SqliteMessagingRequestStore(db.raw);
    fixture.controllerOptions.adapter.retainedSourceConnectionId = () => "fixture-connection";
    fixture.controllerOptions.adapter.authorizeRetainedSource = () => true;
    // A Claude owner advertises Claude Code's review, not review/start.
    fixture.controls.startReview = false;
    fixture.controls.runner = false;
    fixture.thread.prs = [{
      provider: "github.com", org: "fixture", repo: "project", number: 7, title: "Fixture change",
      url: prUrl, state: "passing", lifecycleState: "open",
    }];
    const text = (value: string) => fixture.controller.handleInboundEvent(fixture.event(value));
    const close = async () => {
      await fixture.close();
      db.close();
      await removeTempStateDbDir(tempDir);
    };
    return { fixture, text, close };
  };

  /**
   * Rule: the picker opens in Claude Code mode on current changes at high
   * effort, offers the targets /code-review takes, previews the command, and
   * starts exactly the scope, effort and Auto-fix choice the operator made.
   */
  it("starts the Claude Code review the operator configured", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("changes", "pullRequest", "branch", "path"),
      fc.option(fc.constantFrom("low", "medium", "high", "xhigh", "max"), { nil: undefined }),
      fc.boolean(),
      async (scope, effort, toggleAutoFix) => {
        const { fixture, text, close } = await claudeFixture();
        try {
          await fixture.command();
          expect(fixture.review().review).toMatchObject({
            phase: "summary", runMode: "claude-code-review", codeReviewLevel: "high",
            target: { type: "uncommittedChanges" },
          });
          expect(fixture.review().body).toContain("Command: /code-review high");
          await fixture.click("review:summary:target");
          expect(fixture.review().actions.map(action => action.id)).toEqual(expect.arrayContaining([
            "review:target:current-changes", "review:target:pull-request", "review:target:branch", "review:target:path",
          ]));
          expect(fixture.review().actions.map(action => action.id)).not.toContain("review:target:commit");
          let expected: AppServerReviewTarget = { type: "uncommittedChanges" };
          if (scope === "changes") {
            await fixture.click("review:target:current-changes");
          } else if (scope === "pullRequest") {
            await fixture.click("review:target:pull-request");
            await fixture.click("review:pull-request:0");
            expected = { type: "pullRequest", url: prUrl };
          } else if (scope === "branch") {
            await fixture.click("review:target:branch");
            await text("feature/fixture");
            expected = { type: "branch", branch: "feature/fixture" };
          } else {
            await fixture.click("review:target:path");
            await text("src/app");
            expected = { type: "path", path: "src/app" };
          }
          if (effort) {
            await fixture.click("review:summary:code-review-effort");
            await fixture.click(`review:code-review-effort:${effort}`);
          }
          if (toggleAutoFix) await fixture.click("review:summary:auto-fix");
          expect(fixture.review().review).toMatchObject({ phase: "summary", target: expected });
          await fixture.click("review:summary:start");
          expect(fixture.requests).toEqual([expect.objectContaining({
            backend: "claude", runMode: "claude-code-review", reasoningEffort: effort ?? "high",
            afterReview: toggleAutoFix ? "wait" : "auto-fix", target: expected,
          })]);
          expect(fixture.requests[0]).not.toHaveProperty("reviewBackend");
        } finally {
          await close();
        }
      },
    ), { numRuns: 12 });
  });

  /**
   * Rule: from messaging, a Claude Code review starts at the thread's own
   * effort when /code-review takes it, in the picker and for a bare
   * /code-review; any other effort falls back to high.
   */
  it("reviews at the thread's own effort", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("low", "medium", "high", "xhigh", "max", "ultra", undefined),
      fc.boolean(),
      async (threadEffort, bare) => {
        const { fixture, close } = await claudeFixture();
        fixture.thread.reasoningEffort = threadEffort;
        const expected = threadEffort && threadEffort !== "ultra" ? threadEffort : "high";
        try {
          if (bare) {
            await fixture.controller.handleInboundEvent({
              ...fixture.event(), kind: "command", command: "code-review", args: [], rawText: "/code-review",
            });
          } else {
            await fixture.command();
            expect(fixture.review().review.codeReviewLevel).toBe(expected);
            await fixture.click("review:summary:start");
          }
          expect(fixture.requests).toEqual([expect.objectContaining({ reasoningEffort: expected })]);
        } finally {
          await close();
        }
      },
    ), { numRuns: 14 });
  });

  /**
   * Rule: an explicit mode the owner cannot run stands, so Start fails rather
   * than running another engine (docs/review-execution-modes.md).
   */
  it("keeps an explicit mode the owner cannot run", async () => {
    const { fixture, close } = await claudeFixture();
    try {
      await fixture.command();
      const pending = (await fixture.pending())!;
      await messagingModules(fixture.controller).reviews.updateReviewPendingIntent(
        pending, fixture.event(), { phase: "summary", runMode: "pwragent-sub-agent" },
      );
      // This owner advertises no managed reviewer, so the mode cannot run.
      expect(fixture.review().review.runMode).toBe("pwragent-sub-agent");
    } finally {
      await close();
    }
  });

  /**
   * Rule: the mode screen does not claim the PwrAgent Sub Agent is required
   * while it offers Claude Code; leaving the reviewer returns to Claude Code.
   */
  it("explains the Claude Code way out of another provider's reviewer", async () => {
    const { fixture, close } = await claudeFixture();
    fixture.controls.runner = true;
    try {
      await fixture.command();
      await fixture.click("review:summary:reviewer");
      const codex = fixture.review().actions.find(action => action.fallbackText === "codex");
      await fixture.click(codex!.id);
      await fixture.click("review:reviewer:model:default");
      await fixture.click("review:summary:mode");
      expect(fixture.review().body).toContain("Claude Code reviews as this thread instead");
      expect(fixture.review().actions.map(action => action.id)).toContain("review:mode:claude-code-review");
      await fixture.click("review:back");
      await fixture.click("review:summary:reviewer");
      await fixture.click("review:reviewer:inherit");
      expect(fixture.review().review).toMatchObject({ runMode: "claude-code-review" });
    } finally {
      await close();
    }
  });

  /**
   * Rule: a target the command cannot carry (a branch that reads as a PR
   * number) is refused at Start, with the picker kept, and nothing is sent.
   */
  it("refuses a branch /code-review would read as a pull request", async () => {
    const { fixture, text, close } = await claudeFixture();
    try {
      await fixture.command();
      await fixture.click("review:summary:target");
      await fixture.click("review:target:branch");
      await text("12");
      expect(fixture.review().body).toContain("reads as a pull request number");
      await fixture.click("review:summary:start");
      expect(fixture.requests).toEqual([]);
      expect(fixture.deliveries.at(-1)).toMatchObject({ kind: "error", body: expect.stringContaining("pull request number") });
      expect(await fixture.pending()).toBeDefined();
    } finally {
      await close();
    }
  });

  /** Rule: a managed review is refused while the thread's provider is unavailable. */
  it("refuses another provider's review while the owner is unavailable", async () => {
    const { fixture, close } = await claudeFixture();
    fixture.controls.runner = true;
    try {
      await fixture.command();
      await fixture.click("review:summary:reviewer");
      const codex = fixture.review().actions.find(action => action.fallbackText === "codex");
      await fixture.click(codex!.id);
      await fixture.click("review:reviewer:model:default");
      fixture.controls.available = false;
      await fixture.click("review:summary:start");
      expect(fixture.requests).toEqual([]);
      expect(fixture.deliveries.at(-1)).toMatchObject({ kind: "error", title: "Review unavailable" });
    } finally {
      await close();
    }
  });

  /**
   * Rule: another provider's reviewer runs the review on the PwrAgent Sub
   * Agent even though a Claude owner has no review/start; choosing Claude
   * Code again drops that reviewer.
   */
  it("hands a review to another provider and back to Claude Code", async () => {
    const { fixture, close } = await claudeFixture();
    // Reviewers are offered only from providers that run managed reviews.
    fixture.controls.runner = true;
    try {
      await fixture.command();
      await fixture.click("review:summary:reviewer");
      const codex = fixture.review().actions.find(action => action.fallbackText === "codex");
      expect(codex).toBeDefined();
      await fixture.click(codex!.id);
      await fixture.click("review:reviewer:model:default");
      expect(fixture.review().review).toMatchObject({ runMode: "pwragent-sub-agent", reviewer: { backend: "codex" } });
      await fixture.click("review:summary:mode");
      await fixture.click("review:mode:claude-code-review");
      expect(fixture.review().review).toMatchObject({ runMode: "claude-code-review" });
      expect(fixture.review().review.reviewer).toBeUndefined();
      await fixture.click("review:summary:reviewer");
      await fixture.click(codex!.id);
      await fixture.click("review:reviewer:model:default");
      await fixture.click("review:summary:start");
      expect(fixture.requests).toEqual([expect.objectContaining({
        backend: "claude", runMode: "pwragent-sub-agent", reviewBackend: "codex",
      })]);
    } finally {
      await close();
    }
  });
});
