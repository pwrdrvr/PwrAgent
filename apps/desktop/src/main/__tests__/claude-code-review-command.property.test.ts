import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerReviewTarget, PrSummary, StartReviewRequest } from "@pwragent/shared";
import { parseClaudeCodeReviewPullRequests } from "../claude/claude-review-findings";
import { prepareClaudeCodeReview } from "../app-server/claude-code-review-start";
import {
  CLAUDE_CODE_REVIEW_LEVELS,
  claudeCodeReviewCommand,
} from "../../shared/review-command";

const REPOSITORY = "github.com/fixture/project";
const url = (number: number, repo = "project") => `https://github.com/fixture/${repo}/pull/${number}`;
const level = fc.option(fc.constantFrom(...CLAUDE_CODE_REVIEW_LEVELS), { nil: undefined });
const members = fc.uniqueArray(
  fc.record({ number: fc.integer({ min: 1, max: 99_999 }), other: fc.boolean() }),
  { minLength: 1, maxLength: 8, selector: (member) => `${member.other}:${member.number}` },
);
const branch = fc.oneof(
  fc.stringMatching(/^[a-z][a-z0-9._/-]{0,30}$/),
  // Digits that are not a whole number, such as a version branch.
  fc.stringMatching(/^[0-9]{1,4}\.[0-9a-z.]{1,8}$/),
);
const path = fc.stringMatching(/^[a-zA-Z0-9_.][a-zA-Z0-9_. /-]{0,30}$/)
  .filter((value) => value.trim() === value && value.length > 0);

describe("claudeCodeReviewCommand", () => {
  it("names exactly the panel's pull requests, in order, as the review card reads them", () => {
    fc.assert(fc.property(members, level, (picked, chosenLevel) => {
      const urls = picked.map((member) => url(member.number, member.other ? "other" : "project"));
      const target: AppServerReviewTarget = urls.length === 1
        ? { type: "pullRequest", url: urls[0]! }
        : { type: "pullRequests", pullRequests: urls.map((value) => ({ url: value })) };
      const command = claudeCodeReviewCommand({ target, level: chosenLevel, repository: REPOSITORY });
      const named = parseClaudeCodeReviewPullRequests(command);
      expect(named.map((entry) => entry.number)).toEqual(picked.map((member) => member.number));
      // The checkout's own repository's pull requests are bare numbers; any
      // other is named in full, so the card never guesses its repository.
      named.forEach((entry, index) => {
        if (picked[index]!.other) expect(entry.url).toBe(urls[index]);
        else expect(entry.url).toBeUndefined();
      });
      expect(command.startsWith(chosenLevel ? `/code-review ${chosenLevel} ` : "/code-review ")).toBe(true);
    }));
  });

  it("names every pull request in full when the checkout's repository is unknown", () => {
    fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 99_999 }), { minLength: 1, maxLength: 8 }), (picked) => {
      const urls = picked.map((number) => url(number));
      const command = claudeCodeReviewCommand({
        target: { type: "pullRequests", pullRequests: urls.map((value) => ({ url: value })) },
        level: "high",
      });
      expect(parseClaudeCodeReviewPullRequests(command).map((entry) => entry.url)).toEqual(urls);
    }));
  });

  it("names no pull request for current changes, a branch, or a path", () => {
    fc.assert(fc.property(level, branch, path, (chosenLevel, branchName, pathName) => {
      for (const target of [
        { type: "uncommittedChanges" },
        { type: "branch", branch: branchName },
        { type: "path", path: pathName },
      ] satisfies AppServerReviewTarget[]) {
        const command = claudeCodeReviewCommand({ target, level: chosenLevel });
        // A path made only of digits would read as a pull request number,
        // so a relative path is written with "./".
        expect(parseClaudeCodeReviewPullRequests(command)).toEqual([]);
      }
    }));
  });

  it("refuses an effort it does not offer, and arguments that would read as flags", () => {
    expect(() => claudeCodeReviewCommand({ target: { type: "uncommittedChanges" }, level: "ultra" })).toThrow(/effort/);
    expect(() => claudeCodeReviewCommand({ target: { type: "branch", branch: "--fix" } })).toThrow();
    expect(() => claudeCodeReviewCommand({ target: { type: "path", path: "-x" } })).toThrow();
    expect(() => claudeCodeReviewCommand({ target: { type: "commit", sha: "a".repeat(40), title: null } })).toThrow();
    expect(claudeCodeReviewCommand({ target: { type: "path", path: "docs/my notes.md" }, level: "low" }))
      .toBe('/code-review low "./docs/my notes.md"');
    expect(claudeCodeReviewCommand({ target: { type: "path", path: "1" } })).toBe("/code-review ./1");
    expect(() => claudeCodeReviewCommand({ target: { type: "branch", branch: "#12" } })).toThrow(/pull request number/);
  });
});

describe("prepareClaudeCodeReview", () => {
  const attached = (numbers: number[]): PrSummary[] => numbers.map((number) => ({
    provider: "github.com", org: "fixture", repo: "project", number, url: url(number),
    state: "passing", title: `PR ${number}`, lifecycleState: "open",
  }));
  const request = (target: AppServerReviewTarget, extra: Partial<StartReviewRequest> = {}): StartReviewRequest => ({
    backend: "claude", threadId: "thread-1", target, runMode: "claude-code-review", reasoningEffort: "high", ...extra,
  });
  const onlyOrigin = async () => [{ host: "github.com", owner: "fixture", repo: "project" }];

  it("sends bare numbers when the checkout has exactly one GitHub remote", async () => {
    await expect(prepareClaudeCodeReview({
      request: request({ type: "pullRequests", pullRequests: [{ url: url(12) }, { url: url(13) }] }),
      threadCwd: "/work", prs: attached([12, 13]), resolveRepositories: onlyOrigin,
    })).resolves.toBe("/code-review high 12,13");
  });

  it("names pull requests in full beside a fork, where a bare number is ambiguous", async () => {
    await expect(prepareClaudeCodeReview({
      request: request({ type: "pullRequest", url: url(12) }),
      threadCwd: "/work", prs: attached([12]),
      resolveRepositories: async () => [
        { host: "github.com", owner: "fixture", repo: "project" },
        { host: "github.com", owner: "someone", repo: "project" },
      ],
    })).resolves.toBe(`/code-review high ${url(12)}`);
  });

  it("refuses a pull request the thread has not attached", async () => {
    await expect(prepareClaudeCodeReview({
      request: request({ type: "pullRequests", pullRequests: [{ url: url(12) }, { url: url(14) }] }),
      threadCwd: "/work", prs: attached([12, 13]), resolveRepositories: onlyOrigin,
    })).rejects.toThrow(/attached/);
  });

  it("runs only in a Claude thread, in its own workspace", async () => {
    await expect(prepareClaudeCodeReview({
      request: request({ type: "uncommittedChanges" }, { backend: "codex" }),
      threadCwd: "/work", prs: [],
    })).rejects.toThrow(/Claude thread/);
    await expect(prepareClaudeCodeReview({
      request: request({ type: "uncommittedChanges" }, { reviewBackend: "codex" }),
      threadCwd: "/work", prs: [],
    })).rejects.toThrow(/Claude thread/);
    await expect(prepareClaudeCodeReview({
      request: request({ type: "uncommittedChanges" }, { cwd: "/elsewhere" }),
      threadCwd: "/work", prs: [],
    })).rejects.toThrow(/own workspace/);
    await expect(prepareClaudeCodeReview({
      request: request({ type: "custom", instructions: "look" }),
      threadCwd: "/work", prs: [],
    })).rejects.toThrow(/no form/);
  });
});
