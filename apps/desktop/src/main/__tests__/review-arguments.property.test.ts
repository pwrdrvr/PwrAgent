import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { buildPwrAgentThreadOrchestrationToolDefinitions } from "../agent-tools/pwragent-thread-orchestration-agent-tools";
import { messagingReviewHarness } from "./fixtures/messaging-review-harness";

const url = (number: number, repo = "project") => `https://github.com/fixture/${repo}/pull/${number}`;
const member = fc.record({
  number: fc.integer({ min: 1, max: 5 }),
  repo: fc.constantFrom("project", "other"),
  spelling: fc.constantFrom("number", "hash", "url", "trailingSlash"),
});

describe("combined review arguments", () => {
  it("messaging preserves the order of distinct attached PRs and refuses the entire invalid list", async () => {
    const fixture = await messagingReviewHarness();
    const attached = Array.from({ length: 10 }, (_, index) => ({
      provider: "github.com", org: "fixture", repo: "project", number: index + 1,
      url: url(index + 1), state: "passing" as const, lifecycleState: "open" as const,
    }));
    fixture.thread.prs = attached;
    try {
      const valid = fc.uniqueArray(fc.integer({ min: 1, max: 10 }), { minLength: 2, maxLength: 9, size: "max" })
        .chain(numbers => fc.tuple(...numbers.map(number => member.map(entry => ({ ...entry, number, repo: "project" })))));
      await fc.assert(fc.asyncProperty(
        fc.oneof(valid, fc.array(member, { minLength: 2, maxLength: 9, size: "max" })),
        fc.constantFrom(" ", ",", ", "),
        async (entries, separator) => {
          // The model starts from PR identities and renders them into command text.
          // A number always names a project PR, even when a full URL names another repo.
          const expected = entries.map(entry => url(entry.number,
            entry.spelling === "number" || entry.spelling === "hash" ? "project" : entry.repo));
          const validList = expected.length <= 8 && new Set(expected).size === expected.length
            && expected.every(value => attached.some(pr => pr.url === value));
          const argument = entries.map(({ number, repo, spelling }) => {
            if (spelling === "number") return String(number);
            if (spelling === "hash") return `#${number}`;
            return url(number, repo) + (spelling === "trailingSlash" ? "/" : "");
          }).join(separator);

          fixture.requests.length = 0;
          await fixture.command(["--pr", ...argument.split(" ")]);
          expect(fixture.requests.map(request => request.target)).toEqual(validList
            ? [{ type: "pullRequests", pullRequests: expected.map(url => ({ url })) }]
            : []);
          if (validList) expect(fixture.requests[0]).toMatchObject({ runMode: "pwragent-sub-agent", afterReview: "wait" });
        },
      ));
    } finally {
      await fixture.close();
    }
  });

  it("the agent tool admits only a complete, ordered list of two to eight distinct PRs from one repository", async () => {
    const handler = vi.fn(() => ({ ok: false as const, error: { code: "internal_error" as const, message: "Received normalized arguments" } }));
    const tool = buildPwrAgentThreadOrchestrationToolDefinitions(handler).find(entry => entry.name === "start_review")!;
    const valid = fc.uniqueArray(fc.integer({ min: 1, max: 10 }), { minLength: 1, maxLength: 9, size: "max" })
      .map(numbers => numbers.map(number => ({ number, repo: "project", malformed: false, capitalized: false })));
    const arbitrary = fc.array(fc.record({
      number: fc.integer({ min: 1, max: 5 }),
      repo: fc.constantFrom("project", "other"),
      malformed: fc.boolean(),
      capitalized: fc.boolean(),
    }), { maxLength: 9, size: "max" });
    await fc.assert(fc.asyncProperty(fc.oneof(valid, arbitrary), fc.boolean(), async (entries, padded) => {
      const identities = entries.map(entry => url(entry.number, entry.repo));
      const expected = identities.map((value, index) => entries[index]?.capitalized
        ? value.replace("/fixture/", "/Fixture/") : value);
      const validList = entries.length >= 2 && entries.length <= 8
        && !entries.some(entry => entry.malformed)
        && new Set(entries.map(entry => entry.repo)).size === 1
        && new Set(identities).size === identities.length;
      const pullRequests = entries.map((entry, index) => ({
        url: entry.malformed ? `https://gitlab.com/fixture/project/pull/${entry.number}`
          : padded ? ` ${expected[index]}/ ` : expected[index],
      }));
      handler.mockClear();
      const result = await tool.dispatch({ target: { type: "pullRequests", pullRequests } }, {
        backend: "codex", threadId: "fixture", transport: "mcp",
      });
      if (validList) {
        expect(handler).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
          args: { target: { type: "pullRequests", pullRequests: expected.map(url => ({ url })) } },
        }));
      } else {
        expect(handler).not.toHaveBeenCalled();
        expect(result).toMatchObject({ ok: false, code: "invalid_arguments" });
      }
    }));
  });

  it("preserves a single URL and rejects a duplicate or ambiguous number before submission", async () => {
    const fixture = await messagingReviewHarness();
    fixture.thread.prs = ["project", "other"].map(repo => ({
      provider: "github.com", org: "fixture", repo, number: 1,
      url: url(1, repo), state: "passing", lifecycleState: "open",
    }));
    try {
      await fixture.command(["--pr", url(1)]);
      expect(fixture.requests[0]).toMatchObject({ target: { type: "pullRequest", url: url(1) } });
      expect(fixture.requests[0]?.runMode).toBeUndefined();
      for (const args of [["1", "1"], [url(1), url(1)], [url(1), "1"], [url(1), ",,"], []]) {
        await fixture.command(["--pr", ...args]);
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.deliveries.at(-1)).toMatchObject({ kind: "error" });
      }
    } finally {
      await fixture.close();
    }
  });

  it("routes a Claude thread's combined review as /code-review even without a managed reviewer", async () => {
    const fixture = await messagingReviewHarness("telegram", 1, undefined, "claude");
    fixture.controls.startReview = false;
    fixture.controls.runner = false;
    fixture.controls.outcome = "scheduled";
    fixture.thread.reasoningEffort = "ultra";
    fixture.thread.prs = [1, 2].map(number => ({
      provider: "github.com", org: "fixture", repo: "project", number,
      url: url(number), state: "passing", lifecycleState: "open",
    }));
    try {
      await fixture.command(["--pr", "1,2"]);
      expect(fixture.requests).toEqual([{
        backend: "claude", threadId: fixture.thread.id, delivery: "inline",
        runMode: "claude-code-review", afterReview: "wait", reasoningEffort: "high",
        target: { type: "pullRequests", pullRequests: [{ url: url(1) }, { url: url(2) }] },
      }]);
      fixture.controls.combined = false;
      await fixture.command(["--pr", "1,2"]);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.deliveries.at(-1)).toMatchObject({ kind: "error", body: expect.stringContaining("Update") });
    } finally {
      await fixture.close();
    }
  });

  it("uses the bound Federation owner's capabilities and workspace", async () => {
    const fixture = await messagingReviewHarness();
    const target = { scope: "remote", instanceId: "fixture-owner" } as const;
    fixture.thread.prs = [1, 2].map(number => ({
      provider: "github.com", org: "fixture", repo: "project", number,
      url: url(number), state: "passing", lifecycleState: "open",
    }));
    const listBackends = vi.spyOn(fixture.backend, "listBackends");
    try {
      const binding = (await fixture.store.getBinding("fixture-binding"))!;
      await fixture.store.upsertBinding({
        ...binding, federatedThread: { target, backend: binding.backend, threadId: binding.threadId },
      });
      await fixture.command(["--pr", "1", "2"]);
      expect(listBackends).toHaveBeenCalledWith({ includeUnavailable: true, federationTarget: target });
      expect(fixture.requests).toEqual([expect.objectContaining({
        federationTarget: target, runMode: "pwragent-sub-agent", target: { type: "pullRequests", pullRequests: [{ url: url(1) }, { url: url(2) }] },
      })]);
    } finally {
      await fixture.close();
    }
  });
});
