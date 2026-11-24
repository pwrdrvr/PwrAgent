import "@testing-library/jest-dom/vitest";
import fc from "fast-check";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../../../lib/desktop-api";
import { Composer, type ComposerProps } from "../Composer";

/**
 * Rule: a review card that names its pull request opens the review panel on
 * Attached PR with that PR alone checked, whichever attached PR's branch is
 * checked out and however dirty the checkout is. A card naming a PR the
 * thread does not have opens the panel exactly as a bare card does.
 *
 * The offer card's action used to carry no PR. On a thread with two attached
 * PRs whose checkout was the other PR's branch, the panel fell back to Base
 * branch and would have reviewed the wrong change against main.
 *
 * While the panel belongs to the card, the composer reports the card's id,
 * so the card can wait on the panel; Cancel reports none.
 */

afterEach(cleanup);

const codexBackend: BackendSummary = {
  kind: "codex",
  label: "OpenAI",
  available: true,
  methods: ["thread/start", "turn/start", "review/start"],
  capabilities: {
    listThreads: true,
    createThread: true,
    forkThread: true,
    resumeThread: true,
    archiveThread: true,
    restoreThread: true,
    archiveWorktree: true,
    restoreWorktree: true,
    renameThread: true,
    readThread: true,
    startTurn: true,
    startReview: true,
    reviewRunMode: true,
    reviewAutoFix: true,
    reviewPullRequestSet: true,
    reviewCodexSubAgent: true,
    reviewRunner: true,
    interruptTurn: true,
    steerTurn: true,
    transcriptPagination: false,
    toolUse: false,
    approvalRequests: true,
    multiDirectoryThreads: true,
  },
  executionModes: [
    { mode: "default", label: "Default Access", available: true, isDefault: true },
  ],
};

const desktopApi: DesktopApi = { onAgentEvent: () => () => undefined };

function makePr(number: number): PrSummary {
  return {
    provider: "github.com",
    org: "fixture",
    repo: "project",
    number,
    title: `Change ${number}`,
    url: `https://github.com/fixture/project/pull/${number}`,
    state: "passing",
    lifecycleState: "open",
    headRefName: `change-${number}`,
    baseRefName: "main",
    headSha: String(number % 10).repeat(40),
  };
}

function makeThread(prs: PrSummary[], branch: string, dirty: boolean): NavigationThreadSummary {
  return {
    id: "thread-review",
    source: "codex",
    title: "Review PRs",
    titleSource: "explicit",
    gitBranch: branch,
    observedGitBranch: branch,
    gitWorkingState: dirty
      ? { dirtyFiles: 2, untrackedFiles: 1, unpushedCommits: 0, dirtyAdditions: 4, dirtyDeletions: 1 }
      : { dirtyFiles: 0, untrackedFiles: 0, unpushedCommits: 0, dirtyAdditions: 0, dirtyDeletions: 0 },
    projectKey: "/repo/project",
    linkedDirectories: [{ id: "one", kind: "local", label: "Project", path: "/repo/project" }],
    inbox: { inInbox: false },
    prs,
  };
}

function activeTarget(): string | null {
  return screen.getByRole("group", { name: "Review target" })
    .querySelector("[aria-pressed='true']")
    ?.getAttribute("data-review-target") ?? null;
}

function checkedPullRequestUrls(): string[] {
  return [...document.querySelectorAll<HTMLInputElement>("input.review-pr-picker__input")]
    .filter((input) => input.checked)
    .map((input) => input.value);
}

function renderRequest(
  thread: NavigationThreadSummary,
  request: ComposerProps["reviewRequest"],
  onReviewSetupTodoChange?: (todoId: string | undefined) => void,
) {
  return render(
    <Composer
      backends={[codexBackend]}
      desktopApi={desktopApi}
      directory={{
        key: "project",
        kind: "directory",
        label: "Project",
        path: "/repo/project",
        gitStatus: { originRepository: "github.com/fixture/project", syncState: "untracked" },
      }}
      disabled={false}
      onReviewSetupTodoChange={onReviewSetupTodoChange}
      reviewRequest={request}
      skills={[]}
      thread={thread}
    />,
  );
}

const scenario = fc.record({
  numbers: fc.uniqueArray(fc.integer({ min: 1, max: 9_999 }), { minLength: 1, maxLength: 4 }),
  checkoutIndex: fc.option(fc.nat(), { nil: undefined }),
  pick: fc.nat(),
  dirty: fc.boolean(),
});

describe("a review card's pull request", () => {
  it("opens the panel on the card's PR alone, whatever is checked out", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ numbers, checkoutIndex, pick, dirty }) => {
        const prs = numbers.map(makePr);
        const branch = checkoutIndex === undefined
          ? "unrelated-branch"
          : prs[checkoutIndex % prs.length]!.headRefName!;
        const wanted = prs[pick % prs.length]!;
        const view = renderRequest(makeThread(prs, branch, dirty), {
          id: 1,
          threadId: "thread-review",
          backend: "codex",
          todo: { id: "todo-review" },
          todoTitle: `Review #${wanted.number}`,
          // The offer's URL may differ from the attachment's in case or a
          // trailing slash; it still names the same PR.
          pullRequest: `${wanted.url.toUpperCase().replace("HTTPS://", "https://")}/`,
        });
        await act(async () => undefined);
        expect(activeTarget()).toBe("pullRequest");
        expect(checkedPullRequestUrls()).toEqual([wanted.url]);
        view.unmount();
      }),
      { numRuns: 25 },
    );
  });

  it("opens a card naming an unattached PR as a bare card opens", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ numbers, checkoutIndex, dirty }) => {
        const prs = numbers.map(makePr);
        const branch = checkoutIndex === undefined
          ? "unrelated-branch"
          : prs[checkoutIndex % prs.length]!.headRefName!;
        const thread = makeThread(prs, branch, dirty);
        const base = { id: 1, threadId: thread.id, backend: "codex" as const, todo: { id: "todo-review" } };

        const bare = renderRequest(thread, base);
        await act(async () => undefined);
        const expected = { target: activeTarget(), checked: checkedPullRequestUrls() };
        bare.unmount();

        const named = renderRequest(thread, { ...base, pullRequest: "https://github.com/fixture/project/pull/10000" });
        await act(async () => undefined);
        expect({ target: activeTarget(), checked: checkedPullRequestUrls() }).toEqual(expected);
        named.unmount();
      }),
      { numRuns: 15 },
    );
  });

  it("reports the card while its panel is open, and none after Cancel", async () => {
    const prs = [makePr(4346), makePr(4337)];
    const reports = vi.fn();
    renderRequest(makeThread(prs, "change-4337", true), {
      id: 1,
      threadId: "thread-review",
      backend: "codex",
      todo: { id: "todo-review" },
      todoTitle: "Review #4346 Change 4346",
      pullRequest: prs[0]!.url,
    }, reports);
    await act(async () => undefined);
    expect(reports).toHaveBeenLastCalledWith("todo-review");
    expect(screen.getByText("From to-do")).toBeInTheDocument();
    expect(screen.getByText("Review #4346 Change 4346")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(reports).toHaveBeenLastCalledWith(undefined);
    expect(screen.queryByRole("group", { name: "Review target" })).not.toBeInTheDocument();
  });
});
