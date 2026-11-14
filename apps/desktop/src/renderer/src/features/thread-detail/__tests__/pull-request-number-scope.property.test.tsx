import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import { render } from "@testing-library/react";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PullRequestLinkProvider,
  useLivePullRequestNumber,
} from "../../../lib/pull-request-links";

function pr(repo: string, number: number): PrSummary {
  return {
    provider: "github.com", org: "example", repo, number, state: "merged",
    url: `https://github.com/example/${repo}/pull/${number}`,
  };
}

function thread(id: string, repositoryKey?: string, peer?: string): NavigationThreadSummary {
  return {
    id, source: "codex", title: id, titleSource: "derived",
    inbox: { inInbox: true, unread: false },
    projectKey: "/worktrees/apps",
    linkedDirectories: [{ id: "apps", label: "apps", kind: "worktree",
      path: "/repos/apps", worktreePath: "/worktrees/apps", repositoryKey }],
    ...(peer ? { federation: {
      ref: { target: { scope: "remote", instanceId: peer }, backend: "codex", threadId: id },
      instanceLabel: peer,
    } } : {}),
  } as NavigationThreadSummary;
}

function NumberReference({ number }: { number: number }) {
  const resolved = useLivePullRequestNumber(number);
  return <span>{resolved?.url ?? `#${number}`}</span>;
}

function resolve(active: NavigationThreadSummary, threads: NavigationThreadSummary[], number: number) {
  const view = render(
    <PullRequestLinkProvider activeThread={active} threads={threads}>
      <NumberReference number={number} />
    </PullRequestLinkProvider>,
  );
  const result = view.container.textContent;
  view.unmount();
  return result;
}

describe("bare PR number repository scope", () => {
  // Directory membership and attachment history do not establish that a PR
  // belongs to the active checkout. Its owner's repository identity does.
  it("never imports foreign PR history from a thread in the same directory", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 99_999 }), (number) => {
      const active = thread("active", "github.com/example/apps");
      const sibling = { ...thread("sibling"), prs: [pr("unrelated", number)] };
      expect(resolve(active, [active, sibling], number)).toBe(`#${number}`);
    }), { numRuns: 25 });
  });

  it("treats identical filesystem paths on different owners as unrelated", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 99_999 }), (number) => {
      const active = thread("active", undefined, "owner");
      const local = { ...thread("local"), prs: [pr("unrelated", number)] };
      expect(resolve(active, [active, local], number)).toBe(`#${number}`);
    }), { numRuns: 25 });
  });

  it("does not replace a mounted thread with a local row sharing its backend and id", () => {
    const active = { ...thread("same-id", "github.com/example/apps", "owner"), prs: [pr("apps", 73)] };
    const local = { ...thread("same-id"), prs: [pr("rgit", 1), pr("rgit", 2)] };
    expect(resolve(active, [local, active], 1)).toBe("#1");
    expect(resolve(active, [local, active], 2)).toBe("#2");
    expect(resolve(active, [local, active], 73)).toBe(pr("apps", 73).url);
  });

  it("leaves same-owner sibling numbers plain until the repository identity arrives", () => {
    const active = thread("active");
    const sibling = { ...thread("sibling"), prs: [pr("apps", 1), pr("rgit", 2)] };
    const view = render(
      <PullRequestLinkProvider activeThread={active} threads={[active, sibling]}>
        <NumberReference number={1} /><NumberReference number={2} />
      </PullRequestLinkProvider>,
    );
    expect(view.container.textContent).toBe("#1#2");
    const identified = { ...active, primaryGitRepository: "github.com/example/apps" };
    view.rerender(
      <PullRequestLinkProvider activeThread={identified} threads={[identified, sibling]}>
        <NumberReference number={1} /><NumberReference number={2} />
      </PullRequestLinkProvider>,
    );
    expect(view.container.textContent).toBe(`${pr("apps", 1).url}#2`);
    view.unmount();
  });

  it("resolves a matching repository across owners and checkout paths", () => {
    const active = thread("active", "github.com/example/apps", "owner");
    const sibling = { ...thread("local"), linkedDirectories: [], prs: [pr("apps", 1)] };
    expect(resolve(active, [active, sibling], 1)).toBe(pr("apps", 1).url);
  });

  it("does not let foreign matches make a known repository's reference ambiguous", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 99_999 }), fc.boolean(), (number, reverse) => {
      const active = thread("active", "github.com/example/apps");
      const matching = { ...thread("matching"), prs: [pr("apps", number)] };
      const foreign = { ...thread("foreign"), prs: [pr("rgit", number)] };
      const siblings = reverse ? [foreign, matching] : [matching, foreign];
      expect(resolve(active, [active, ...siblings], number)).toBe(pr("apps", number).url);
    }), { numRuns: 25 });
  });

  it("retains the selected thread's attachments before its navigation row loads", () => {
    const active = { ...thread("active"), prs: [pr("apps", 73)] };
    expect(resolve(active, [], 73)).toBe(pr("apps", 73).url);
  });
});
