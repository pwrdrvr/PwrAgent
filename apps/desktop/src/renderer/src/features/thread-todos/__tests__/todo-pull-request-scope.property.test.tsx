import type { NavigationThreadSummary, PrSummary, ThreadTodo } from "@pwragent/shared";
import { render } from "@testing-library/react";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PullRequestLinkProvider } from "../../../lib/pull-request-links";
import { TodoPullRequestChip } from "../TodoPullRequestChip";

const PROJECT = "/repos/apps";

function pr(repo: string, number: number): PrSummary {
  return { provider: "github.com", org: "example", repo, number, state: "merged",
    url: `https://github.com/example/${repo}/pull/${number}` };
}

function thread(id: string, prs: PrSummary[], peer?: string): NavigationThreadSummary {
  return {
    id, source: "codex", title: id, titleSource: "derived", prs,
    inbox: { inInbox: true, unread: false }, projectKey: `${PROJECT}-${id}`,
    linkedDirectories: [{ id, label: "apps", kind: "worktree", path: PROJECT,
      worktreePath: `${PROJECT}-${id}`, repositoryKey: "github.com/example/apps" }],
    ...(peer ? { federation: { instanceLabel: peer,
      ref: { backend: "codex", threadId: id, target: { scope: "remote", instanceId: peer } },
    } } : {}),
  } as NavigationThreadSummary;
}

function todo(peer?: string): ThreadTodo {
  return {
    id: "merge", backend: "codex", threadId: "raiser", kind: "merge", status: "open",
    title: "Ready to merge", createdAt: 0, updatedAt: 0,
    sourceProject: { key: `directory:${PROJECT}`, label: "apps", path: PROJECT },
    ...(peer ? { federationTarget: { scope: "remote", instanceId: peer } } : {}),
  } as ThreadTodo;
}

function resolved(threads: NavigationThreadSummary[], number: number, peer?: string) {
  const view = render(
    <PullRequestLinkProvider threads={threads}>
      <TodoPullRequestChip todo={todo(peer)} pullRequest={String(number)} />
    </PullRequestLinkProvider>,
  );
  const result = view.container.querySelector("[data-pr-url]")?.getAttribute("data-pr-url")
    ?? view.container.textContent;
  view.unmount();
  return result;
}

describe("to-do PR number scope", () => {
  // The project's owner supplies repository identity. Sharing a project path
  // does not make a sibling's historical PR part of that repository.
  it("never resolves a foreign attachment merely because its thread shares the project path", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 99_999 }), (number) => {
      expect(resolved([thread("raiser", []), thread("sibling", [pr("rgit", number)])], number))
        .toBe(`#${number}`);
    }), { numRuns: 25 });
  });

  it("matches the card's owning thread regardless of row order and backend/id collisions", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 99_999 }), fc.boolean(), (number, reverse) => {
      const local = thread("raiser", [pr("local-history", number)]);
      const remote = thread("raiser", [pr("remote-history", number)], "owner");
      const rows = reverse ? [remote, local] : [local, remote];
      expect(resolved(rows, number)).toBe(pr("local-history", number).url);
      expect(resolved(rows, number, "owner")).toBe(pr("remote-history", number).url);
    }), { numRuns: 25 });
  });

  it("keeps owner-specific resolutions separate in the snapshot cache", () => {
    const rows = [thread("raiser", [pr("local-history", 1)]), thread("raiser", [pr("remote-history", 1)], "owner")];
    const view = render(
      <PullRequestLinkProvider threads={rows}>
        <div data-testid="local"><TodoPullRequestChip todo={todo()} pullRequest="1" /></div>
        <div data-testid="remote"><TodoPullRequestChip todo={todo("owner")} pullRequest="1" /></div>
      </PullRequestLinkProvider>,
    );
    expect(view.getByTestId("local").querySelector("[data-pr-url]")?.getAttribute("data-pr-url"))
      .toBe(pr("local-history", 1).url);
    expect(view.getByTestId("remote").querySelector("[data-pr-url]")?.getAttribute("data-pr-url"))
      .toBe(pr("remote-history", 1).url);
    view.unmount();
  });

  it("does not infer a remote project's repository from the viewer's identical path", () => {
    const owner = { ...thread("raiser", [], "owner"), linkedDirectories: [] };
    expect(resolved([owner, thread("sibling", [pr("apps", 1)])], 1, "owner")).toBe("#1");
  });

  it("keeps sibling numbers plain while the project's repository identity is unknown", () => {
    const owner = { ...thread("raiser", []), linkedDirectories: [] };
    const sibling = { ...thread("sibling", [pr("apps", 1)]), linkedDirectories: [{
      id: "apps", label: "apps", kind: "local" as const, path: PROJECT,
    }] };
    expect(resolved([owner, sibling], 1)).toBe("#1");
  });

  it("resolves only the target project's repository when the raising thread links several projects", () => {
    const owner = { ...thread("raiser", []), primaryGitRepository: "github.com/example/rgit",
      linkedDirectories: [
        { id: "rgit", label: "rgit", kind: "local" as const, path: "/repos/rgit", repositoryKey: "github.com/example/rgit" },
        ...thread("raiser", []).linkedDirectories,
      ] };
    const foreign = thread("foreign", [pr("rgit", 1)]);
    const matching = thread("matching", [pr("apps", 1)]);
    expect(resolved([owner, foreign, matching], 1)).toBe(pr("apps", 1).url);
  });

  it("updates a mounted chip when its card's federation owner changes", () => {
    const rows = [thread("raiser", [pr("local-history", 1)]), thread("raiser", [pr("remote-history", 1)], "owner")];
    const ui = (peer?: string) => (
      <PullRequestLinkProvider threads={rows}>
        <TodoPullRequestChip todo={todo(peer)} pullRequest="1" />
      </PullRequestLinkProvider>
    );
    const view = render(ui());
    view.rerender(ui("owner"));
    expect(view.container.querySelector("[data-pr-url]")?.getAttribute("data-pr-url"))
      .toBe(pr("remote-history", 1).url);
    view.unmount();
  });

  it("follows repository metadata arriving and disappearing without admitting foreign history", () => {
    fc.assert(fc.property(
      fc.array(fc.boolean(), { minLength: 2, maxLength: 6 }),
      (knownStates) => {
        const ui = (known: boolean) => {
          const owner = { ...thread("raiser", []), linkedDirectories: [{
            id: "apps", label: "apps", kind: "local" as const, path: PROJECT,
            ...(known ? { repositoryKey: "github.com/example/apps" } : {}),
          }] };
          const sibling = { ...thread("sibling", [pr("apps", 1), pr("rgit", 2)]), linkedDirectories: [] };
          return (
            <PullRequestLinkProvider threads={[owner, sibling]}>
              <TodoPullRequestChip todo={todo()} pullRequest="1" />
              <TodoPullRequestChip todo={todo()} pullRequest="2" />
            </PullRequestLinkProvider>
          );
        };
        const view = render(ui(false));
        for (const known of [false, true, false, ...knownStates]) {
          view.rerender(ui(known));
          const chip = view.container.querySelector("[data-pr-url]");
          expect(chip?.getAttribute("data-pr-url")).toBe(known ? pr("apps", 1).url : undefined);
          expect(view.container.textContent).toContain("#2");
        }
        view.unmount();
      },
    ), { numRuns: 25 });
  });

  it("does not broaden an authoritative project identity with a sibling's conflicting metadata", () => {
    const owner = thread("raiser", []);
    const sibling = { ...thread("sibling", [pr("rgit", 1)]),
      primaryGitRepository: "github.com/example/rgit" };
    expect(resolved([owner, sibling], 1)).toBe("#1");
  });

  it("does not choose a colliding local thread before the remote raising row loads", () => {
    expect(resolved([thread("raiser", [pr("local-history", 1)])], 1, "owner")).toBe("#1");
  });

  it("keeps an ambiguous own-thread number plain rather than falling back to its project", () => {
    const owner = thread("raiser", [pr("apps", 1), pr("historical", 1)]);
    expect(resolved([owner, thread("sibling", [pr("apps", 1)])], 1)).toBe("#1");
  });
});
