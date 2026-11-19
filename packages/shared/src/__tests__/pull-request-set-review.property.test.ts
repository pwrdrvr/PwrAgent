import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  AppServerReviewPullRequest,
  AppServerReviewPullRequestSnapshot,
} from "../contracts/normalized-app-server";
import {
  PULL_REQUEST_SET_MAX,
  pullRequestSetProblem,
  pullRequestSetReviewInstructions,
  pullRequestStackOrder,
  reviewFindingPullRequests,
  samePullRequestSet,
} from "../pull-request-review";

type Member = { id: number; headRefName: string; baseRefName: string };

/**
 * Oracle: the stack order is the one permutation in which the first member's
 * base is no member's head and each later member is based on the head before
 * it. Found by trying every permutation, which is obviously right and small.
 */
function bruteForceStack(members: Member[]): Member[] | undefined {
  if (members.length < 2) return undefined;
  if (new Set(members.map((member) => member.headRefName)).size !== members.length) return undefined;
  const heads = new Set(members.map((member) => member.headRefName));
  const found: Member[][] = [];
  const permute = (prefix: Member[], rest: Member[]): void => {
    if (rest.length === 0) {
      const valid = !heads.has(prefix[0]!.baseRefName)
        && prefix.every((member, index) => index === 0 || member.baseRefName === prefix[index - 1]!.headRefName);
      if (valid) found.push(prefix);
      return;
    }
    rest.forEach((member, index) => permute([...prefix, member], rest.filter((_, other) => other !== index)));
  };
  permute([], members);
  return found.length === 1 ? found[0] : undefined;
}

const branchName = fc.constantFrom("main", "a", "b", "c", "d", "e", "f");
const memberList = fc.array(fc.record({ headRefName: branchName, baseRefName: branchName }), {
  minLength: 0, maxLength: 5,
}).map((members) => members.map((member, id) => ({ id, ...member })));

/** A real stack of n branches on main, shuffled, so chains are common. */
const shuffledStack = fc.integer({ min: 2, max: 6 }).chain((size) => {
  const chain: Member[] = Array.from({ length: size }, (_, index) => ({
    id: index,
    headRefName: `stack/${index + 1}`,
    baseRefName: index === 0 ? "main" : `stack/${index}`,
  }));
  return fc.shuffledSubarray(chain, { minLength: size, maxLength: size }).map((shuffled) => ({ chain, shuffled }));
});

const refs = (member: Member) => member;

describe("pullRequestStackOrder", () => {
  it("reads any shuffled stack bottom first", () => {
    fc.assert(fc.property(shuffledStack, ({ chain, shuffled }) => {
      expect(pullRequestStackOrder(shuffled, refs)?.map((member) => member.id))
        .toEqual(chain.map((member) => member.id));
    }));
  });

  it("agrees with trying every order, and finds no stack where there is none", () => {
    fc.assert(fc.property(memberList, (members) => {
      expect(pullRequestStackOrder(members, refs)?.map((member) => member.id))
        .toEqual(bruteForceStack(members)?.map((member) => member.id));
    }), { numRuns: 300 });
  });

  it("never invents a stack from a member with an unknown branch", () => {
    fc.assert(fc.property(shuffledStack, fc.nat(), ({ shuffled }, pick) => {
      const broken = shuffled.map((member, index) =>
        index === pick % shuffled.length ? { ...member, baseRefName: "" } : member);
      expect(pullRequestStackOrder(broken, refs)).toBeUndefined();
    }));
  });
});

const pullRequest = (number: number): AppServerReviewPullRequest => ({
  provider: "github.com", org: "fixture", repo: "project", number,
  url: `https://github.com/fixture/project/pull/${number}`,
  headRefName: `branch-${number}`, baseRefName: "main",
});
const sha = (seed: number): string => seed.toString(16).padStart(40, "0");
const snapshot = (number: number, changedPaths?: string[]): AppServerReviewPullRequestSnapshot => ({
  pullRequest: pullRequest(number),
  baseCommit: sha(number * 3 + 1), headCommit: sha(number * 3 + 2), mergeBaseCommit: sha(number * 3 + 3),
  capturedAt: 1,
  ...(changedPaths ? { changedPaths } : {}),
});

const paths = fc.constantFrom("src/a.ts", "src/b.ts", "docs/c.md", "d.ts", "src/nested/a.ts");
const snapshotSet = fc.array(
  fc.option(fc.uniqueArray(paths, { maxLength: 4 }), { nil: undefined }),
  { minLength: 2, maxLength: 5 },
).map((lists) => lists.map((changed, index) => snapshot(index + 1, changed)));

describe("reviewFindingPullRequests", () => {
  const workspacePath = "/work/checkout";

  it("tags a finding with exactly the pull requests that changed its file", () => {
    fc.assert(fc.property(snapshotSet, paths, fc.boolean(), (snapshots, file, absolute) => {
      const tags = reviewFindingPullRequests(absolute ? `${workspacePath}/${file}` : file, {
        workspacePath, pullRequestSnapshots: snapshots,
      });
      const expected = snapshots.filter((entry) => entry.changedPaths?.includes(file));
      if (expected.length === 0 && snapshots.some((entry) => !entry.changedPaths)) {
        // "None" is not knowable while a snapshot's paths are unknown.
        expect(tags).toBeUndefined();
      } else {
        expect(tags?.map((entry) => entry.number)).toEqual(expected.map((entry) => entry.pullRequest.number));
      }
    }));
  });

  it("says nothing for a review of one pull request", () => {
    fc.assert(fc.property(paths, (file) => {
      expect(reviewFindingPullRequests(file, {
        workspacePath, pullRequestSnapshots: [snapshot(1, [file])],
      })).toBeUndefined();
    }));
  });

  it("matches a path in the repository checkout as well as the worktree", () => {
    expect(reviewFindingPullRequests("/repo/src/a.ts", {
      workspacePath, repositoryPath: "/repo",
      pullRequestSnapshots: [snapshot(1, ["src/a.ts"]), snapshot(2, ["src/b.ts"])],
    })?.map((entry) => entry.number)).toEqual([1]);
  });

  it("does not match a file only by a shorter trailing path inside the workspace", () => {
    // src/nested/a.ts is not a.ts at the root.
    expect(reviewFindingPullRequests(`${workspacePath}/src/nested/a.ts`, {
      workspacePath,
      pullRequestSnapshots: [snapshot(1, ["src/a.ts"]), snapshot(2, ["d.ts"])],
    })).toEqual([]);
  });
});

describe("pull request sets", () => {
  const url = (number: number, repo = "project") => `https://github.com/fixture/${repo}/pull/${number}`;

  it("takes two to eight distinct pull requests of one repository", () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 1, max: 12 }), { minLength: 0, maxLength: PULL_REQUEST_SET_MAX + 2 }),
      fc.boolean(),
      (numbers, otherRepository) => {
        const urls = numbers.map((number, index) => url(number, otherRepository && index === 1 ? "other" : "project"));
        const valid = urls.length >= 2 && urls.length <= PULL_REQUEST_SET_MAX
          && new Set(urls).size === urls.length && !(otherRepository && urls.length > 1);
        expect(pullRequestSetProblem(urls) === undefined).toBe(valid);
      },
    ));
  });

  it("is the same set only with the same pull requests in the same order", () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 1, max: 5 }), { maxLength: 4 }),
      fc.array(fc.integer({ min: 1, max: 5 }), { maxLength: 4 }),
      fc.boolean(),
      (left, right, slash) => {
        const same = samePullRequestSet(
          left.map((number) => ({ url: url(number) })),
          right.map((number) => ({ url: `${url(number)}${slash ? "/" : ""}` })),
        );
        expect(same).toBe(JSON.stringify(left) === JSON.stringify(right));
      },
    ));
  });

  it("gives the reviewer every pull request once, at its own pinned commits, stack bottom first", () => {
    fc.assert(fc.property(shuffledStack, ({ chain, shuffled }) => {
      const snapshotOf = (member: Member) => ({
        ...snapshot(member.id + 1),
        pullRequest: { ...pullRequest(member.id + 1), headRefName: member.headRefName, baseRefName: member.baseRefName },
      });
      const text = pullRequestSetReviewInstructions({
        type: "pullRequests",
        pullRequests: shuffled.map((member) => ({ url: pullRequest(member.id + 1).url, snapshot: snapshotOf(member) })),
      });
      const positions = chain.map((member) => text.indexOf(`Pull request: ${pullRequest(member.id + 1).url};`));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      for (const member of chain) {
        const pinned = snapshotOf(member);
        expect(text).toContain(`git diff --no-ext-diff ${pinned.mergeBaseCommit} ${pinned.headCommit} --`);
      }
    }));
  });

  it("refuses to describe a pull request without its owner-captured commits", () => {
    expect(() => pullRequestSetReviewInstructions({
      type: "pullRequests",
      pullRequests: [{ url: url(1), snapshot: snapshot(1) }, { url: url(2) }],
    })).toThrow(/owner-resolved commit snapshot/);
  });
});
