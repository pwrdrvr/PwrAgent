import "@testing-library/jest-dom/vitest";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseGitHubPullRequestUrl,
  parsePullRequestUrl,
  PullRequestLinkProvider,
} from "../../../lib/pull-request-links";
import { ThreadMarkdown } from "../ThreadMarkdown";
import { TOOLTIP_HOVER_DELAY_MS } from "../../../lib/useViewportTooltip";

const PR_URL = "https://github.com/ExampleOrg/catalog-service/pull/13290";

function prSummary(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    provider: "github.com",
    number: 13290,
    org: "ExampleOrg",
    repo: "catalog-service",
    title: "Document JDK 17 for EMR jobs",
    state: "pending",
    checkState: "pending",
    lifecycleState: "open",
    reviewState: "draft",
    mergeState: "mergeable",
    url: PR_URL,
    ...overrides,
  };
}

function threadSummary(
  prs: PrSummary[],
  overrides: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary {
  return {
    id: "thread-pr-link",
    title: "EMR JDK 17 guidance",
    titleSource: "derived",
    source: "codex",
    linkedDirectories: [],
    inbox: { inInbox: true, unread: false },
    prs,
    ...overrides,
  } as NavigationThreadSummary;
}

function renderWithPullRequests(
  text: string,
  prs: PrSummary[],
) {
  const thread = threadSummary(prs);
  return render(
    <PullRequestLinkProvider activeThread={thread} threads={[thread]}>
      <ThreadMarkdown text={text} />
    </PullRequestLinkProvider>,
  );
}

function projectThread(params: {
  id: string;
  path: string;
  prs?: PrSummary[];
  worktreePath?: string;
}): NavigationThreadSummary {
  const worktreePath = params.worktreePath ?? `${params.path}-${params.id}`;
  return threadSummary(params.prs ?? [], {
    id: params.id,
    projectKey: worktreePath,
    linkedDirectories: [
      {
        id: worktreePath,
        kind: "worktree",
        label: params.path.split("/").pop() ?? params.path,
        path: params.path,
        worktreePath,
        repositoryKey: `github.com/exampleorg/${params.path.split("/").pop()}`,
      },
    ],
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("pull request links in transcript markdown", () => {
  it("hydrates fork and upstream hover cards independently despite legacy source-repo identities", () => {
    vi.useFakeTimers();
    const fork = prSummary({ number: 38, org: "fork", repo: "diskhound", title: "Fork scan progress",
      url: "https://github.com/fork/diskhound/pull/38", additions: 100 });
    const upstream = { ...fork, title: "Upstream build warnings", additions: 8,
      url: "https://github.com/upstream/diskhound/pull/38" };
    renderWithPullRequests(`[Fork](${fork.url}) [Upstream](${upstream.url})`, [upstream, fork]);
    const forkChip = screen.getByRole("button", { name: /Open fork\/diskhound#38/ });
    fireEvent.mouseEnter(forkChip);
    act(() => { vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS); });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Fork scan progress");
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("Upstream build warnings");
    fireEvent.mouseLeave(forkChip);
    fireEvent.mouseEnter(screen.getByRole("button", { name: /Open upstream\/diskhound#38/ }));
    act(() => { vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS); });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Upstream build warnings");
    expect(screen.getByRole("tooltip")).toHaveTextContent("upstream/diskhound#38");
  });

  it("renders a known GitHub PR link with the shared live status chip", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderWithPullRequests(`Draft PR: [ExampleOrg/catalog-service#13290](${PR_URL})`, [
      prSummary(),
    ]);

    const chip = screen.getByRole("button", {
      name: /Open ExampleOrg\/catalog-service#13290 \(draft · checks pending\) in browser/,
    });
    expect(chip).toHaveClass("pr-chip", "pr-chip--pending", "pr-chip--draft");
    expect(chip).toHaveTextContent("ExampleOrg/catalog-service#13290");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    fireEvent.click(chip);
    expect(open).toHaveBeenCalledWith(PR_URL, "_blank", "noopener,noreferrer");
  });

  it("does not start a text selection from a mousedown on a PR chip", () => {
    const { container } = renderWithPullRequests(
      `Opened [ExampleOrg/catalog-service#13290](${PR_URL}) for review.`,
      [prSummary()],
    );
    const chip = container.querySelector<HTMLElement>("[data-pr-chip]");
    const label = chip?.querySelector(".pr-chip__label");
    const paragraph = container.querySelector("p");
    expect(label).not.toBeNull();
    expect(paragraph).not.toBeNull();

    // `user-select: all` would select the whole chip on this mousedown.
    expect(fireEvent.mouseDown(label!, { button: 0 })).toBe(false);
    // Extending a selection, a secondary button, and surrounding prose keep
    // the browser's default so a drag across the chip still selects it.
    expect(fireEvent.mouseDown(label!, { button: 0, shiftKey: true })).toBe(true);
    expect(fireEvent.mouseDown(label!, { button: 2 })).toBe(true);
    expect(fireEvent.mouseDown(paragraph!, { button: 0 })).toBe(true);
  });

  it("copies a selected PR chip as a full URL that can hydrate in any project", () => {
    const { container } = renderWithPullRequests(
      `> Deploy merged PR [ExampleOrg/catalog-service#13290](${PR_URL}) now.`,
      [prSummary()],
    );
    const quote = container.querySelector("blockquote");
    const markdown = container.querySelector(".thread-markdown");
    expect(quote).not.toBeNull();
    expect(markdown).not.toBeNull();

    const range = document.createRange();
    range.selectNodeContents(quote!);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const setData = vi.fn();
    fireEvent.copy(markdown!, {
      clipboardData: { setData },
    });

    expect(setData).toHaveBeenCalledWith(
      "text/plain",
      expect.stringContaining(PR_URL),
    );
    expect(setData).toHaveBeenCalledWith(
      "text/html",
      expect.stringContaining(
        `<a href="${PR_URL}">${PR_URL}</a>`,
      ),
    );
  });

  it("hydrates the exact draft-PR link shape emitted by a completed thread", () => {
    renderWithPullRequests(
      `Draft PR: [#13290 — Document JDK 17 for EMR jobs](${PR_URL})`,
      [prSummary()],
    );

    expect(screen.getByRole("button", {
      name: /Open ExampleOrg\/catalog-service#13290 \(draft · checks pending\) in browser/,
    })).toHaveTextContent("ExampleOrg/catalog-service#13290");
    expect(screen.queryByRole("link", {
      name: "#13290 — Document JDK 17 for EMR jobs",
    })).not.toBeInTheDocument();
  });

  it("renders GitLab merge request links with the shared live status chip", () => {
    const url = "https://gitlab.com/pwrdrvr/platform/PwrAgent/-/merge_requests/49";
    const pullRequest = prSummary({
      provider: "gitlab.com",
      org: "pwrdrvr/platform",
      repo: "PwrAgent",
      number: 49,
      url,
    });
    renderWithPullRequests(`Related change: [#49](${url})`, [pullRequest]);

    expect(screen.getByRole("button", {
      name: /Open pwrdrvr\/platform\/PwrAgent#49/,
    })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "#49" })).not.toBeInTheDocument();
  });

  it("hydrates a bare PR number known on the active thread", () => {
    renderWithPullRequests("Rebased onto current origin/main, including #13290.", [
      prSummary(),
    ]);

    expect(screen.getByRole("button", {
      name: /Open ExampleOrg\/catalog-service#13290 \(draft · checks pending\) in browser/,
    })).toBeInTheDocument();
  });

  it("renders one chip when prose names a PR by number and URL together", () => {
    renderWithPullRequests(
      `I opened PR #13290 (${PR_URL}). Then ${PR_URL} (#13290) again.`,
      [prSummary()],
    );

    expect(screen.getAllByRole("button", {
      name: /Open ExampleOrg\/catalog-service#13290/,
    })).toHaveLength(2);
    expect(screen.getByText(/I opened PR/)).not.toHaveTextContent("(");
  });

  it("hydrates a bare PR number known by a sibling thread in the same repository", () => {
    const activeThread = projectThread({
      id: "thread-active",
      path: "/repos/catalog-service",
    });
    const siblingThread = projectThread({
      id: "thread-sibling",
      path: "/repos/catalog-service",
      prs: [prSummary()],
    });

    render(
      <PullRequestLinkProvider
        activeThread={activeThread}
        threads={[activeThread, siblingThread]}
      >
        <ThreadMarkdown text="The related fix landed in #13290." />
      </PullRequestLinkProvider>,
    );

    expect(screen.getByRole("button", {
      name: /Open ExampleOrg\/catalog-service#13290 \(draft · checks pending\) in browser/,
    })).toBeInTheDocument();
  });

  it("excludes PRs from a sibling that also links repositories outside the active scope", () => {
    const activeThread = projectThread({
      id: "thread-active",
      path: "/repos/catalog-service",
    });
    const multiRepositorySibling = threadSummary([
      prSummary({
        org: "ExampleOrg",
        repo: "analytics",
        url: "https://github.com/ExampleOrg/analytics/pull/13290",
      }),
    ], {
      id: "thread-multi-repository",
      linkedDirectories: [
        {
          id: "sibling-catalog-service",
          kind: "worktree",
          label: "catalog-service",
          path: "/repos/catalog-service",
          worktreePath: "/worktrees/sibling-catalog-service",
        },
        {
          id: "sibling-analytics",
          kind: "worktree",
          label: "analytics",
          path: "/repos/analytics",
          worktreePath: "/worktrees/sibling-analytics",
        },
      ],
    });

    render(
      <PullRequestLinkProvider
        activeThread={activeThread}
        threads={[activeThread, multiRepositorySibling]}
      >
        <ThreadMarkdown text="Do not cross repositories for #13290." />
      </PullRequestLinkProvider>,
    );

    expect(screen.queryByRole("button", {
      name: /ExampleOrg\/analytics#13290/,
    })).not.toBeInTheDocument();
    expect(screen.getByText(/#13290/)).toBeInTheDocument();
  });

  it("leaves a bare number plain when the known PR belongs to another project", () => {
    const activeThread = projectThread({
      id: "thread-active",
      path: "/repos/current-project",
    });
    const unrelatedThread = projectThread({
      id: "thread-unrelated",
      path: "/repos/catalog-service",
      prs: [prSummary()],
    });

    render(
      <PullRequestLinkProvider
        activeThread={activeThread}
        threads={[activeThread, unrelatedThread]}
      >
        <ThreadMarkdown text="Do not guess at #13290." />
      </PullRequestLinkProvider>,
    );

    expect(screen.queryByRole("button", {
      name: /ExampleOrg\/catalog-service#13290/,
    })).not.toBeInTheDocument();
    expect(screen.getByText(/#13290/)).toBeInTheDocument();
  });

  it("keeps review finding numbers plain when a same-directory thread carries foreign PRs", () => {
    const activeThread = projectThread({ id: "active", path: "/repos/catalog-service", prs: [prSummary()] });
    const sibling = projectThread({
      id: "sibling", path: "/repos/catalog-service",
      prs: [1, 2].map((number) => prSummary({
        number, repo: "unrelated", url: `https://github.com/ExampleOrg/unrelated/pull/${number}`,
      })),
    });
    render(
      <PullRequestLinkProvider activeThread={activeThread} threads={[activeThread, sibling]}>
        <ThreadMarkdown text={"- **Addressed #1:** Preview links preserve selection.\n- **Addressed #2:** Screens follow the visible mount.\n\nPR #13290 checks passed."} />
      </PullRequestLinkProvider>,
    );
    expect(screen.getByText("Addressed #1:")).toBeInTheDocument();
    expect(screen.getByText("Addressed #2:")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /unrelated#/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /catalog-service#13290/ })).toBeInTheDocument();
  });

  it("leaves a bare number plain when it is ambiguous across linked repositories", () => {
    const firstPath = "/repos/catalog-service";
    const secondPath = "/repos/analytics";
    const activeThread = threadSummary([], {
      id: "thread-active",
      linkedDirectories: [
        {
          id: "active-first",
          kind: "worktree",
          label: "catalog-service",
          path: firstPath,
          worktreePath: "/worktrees/active-first",
          repositoryKey: "github.com/exampleorg/catalog-service",
        },
        {
          id: "active-second",
          kind: "worktree",
          label: "analytics",
          path: secondPath,
          worktreePath: "/worktrees/active-second",
          repositoryKey: "github.com/exampleorg/analytics",
        },
      ],
    });
    const firstSibling = projectThread({
      id: "thread-first",
      path: firstPath,
      prs: [prSummary()],
    });
    const secondSibling = projectThread({
      id: "thread-second",
      path: secondPath,
      prs: [
        prSummary({
          org: "ExampleOrg",
          repo: "analytics",
          url: "https://github.com/ExampleOrg/analytics/pull/13290",
        }),
      ],
    });

    render(
      <PullRequestLinkProvider
        activeThread={activeThread}
        threads={[activeThread, firstSibling, secondSibling]}
      >
        <ThreadMarkdown text="Ambiguous reference #13290 stays plain." />
      </PullRequestLinkProvider>,
    );

    expect(screen.queryByRole("button", { name: /#13290/ })).not.toBeInTheDocument();
    expect(screen.getByText(/#13290/)).toBeInTheDocument();
  });

  it("does not hydrate PR-style text inside code or an authored non-PR link", () => {
    renderWithPullRequests(
      "Keep `#13290` literal and [issue #13290](https://github.com/ExampleOrg/catalog-service/issues/13290) linked.",
      [prSummary()],
    );

    expect(screen.queryByRole("button", { name: /#13290/ })).not.toBeInTheDocument();
    expect(screen.getByText("#13290", { selector: "code" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "issue #13290" })).toBeInTheDocument();
  });

  it("hydrates a bare number when same-project PR metadata arrives later", () => {
    const activeThread = projectThread({
      id: "thread-active",
      path: "/repos/catalog-service",
    });
    const siblingWithoutPr = projectThread({
      id: "thread-sibling",
      path: "/repos/catalog-service",
    });
    const { rerender } = render(
      <PullRequestLinkProvider
        activeThread={activeThread}
        threads={[activeThread, siblingWithoutPr]}
      >
        <ThreadMarkdown text="Waiting on #13290." />
      </PullRequestLinkProvider>,
    );
    expect(screen.queryByRole("button", { name: /#13290/ })).not.toBeInTheDocument();

    const siblingWithPr = projectThread({
      id: "thread-sibling",
      path: "/repos/catalog-service",
      prs: [prSummary()],
    });
    rerender(
      <PullRequestLinkProvider
        activeThread={activeThread}
        threads={[activeThread, siblingWithPr]}
      >
        <ThreadMarkdown text="Waiting on #13290." />
      </PullRequestLinkProvider>,
    );

    expect(screen.getByRole("button", {
      name: /Open ExampleOrg\/catalog-service#13290 \(draft · checks pending\) in browser/,
    })).toBeInTheDocument();
  });

  it("updates chip modes and a visible tooltip from live PR status metadata", () => {
    const text = `Draft PR: [ExampleOrg/catalog-service#13290](${PR_URL})`;
    const { rerender } = renderWithPullRequests(text, [prSummary()]);

    const markdownNode = screen.getByText("Draft PR:").parentElement;
    const pendingChip = screen.getByRole("button", {
      name: /draft · checks pending/,
    });
    fireEvent.focus(pendingChip);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Document JDK 17 for EMR jobs",
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "draft · checks pending",
    );

    rerender(
      <PullRequestLinkProvider
        threads={[
          threadSummary([
            prSummary({
              title: "Document JDK 17 for EMR and Spark jobs",
              state: "merged",
              checkState: "passing",
              lifecycleState: "merged",
              reviewState: "ready_for_review",
            }),
          ]),
        ]}
      >
        <ThreadMarkdown text={text} />
      </PullRequestLinkProvider>,
    );

    const mergedChip = screen.getByRole("button", { name: /\(merged\) in browser/ });
    expect(mergedChip).toHaveClass("pr-chip--merged");
    expect(mergedChip).not.toHaveClass("pr-chip--draft");
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Document JDK 17 for EMR and Spark jobs",
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "ExampleOrg/catalog-service#13290",
    );
    expect(
      screen.getByRole("tooltip").querySelector(".pr-status-card__phase"),
    ).toHaveTextContent("merged");
    expect(screen.getByText("Draft PR:").parentElement).toBe(markdownNode);
  });

  it("keeps URL and shorthand chips mounted when a status refresh compacts the sidebar preview", () => {
    const deepUrl = `${PR_URL}/files#diff-123`;
    const text = `Check ${deepUrl} or #13290.`;
    const otherPrs = Array.from({ length: 16 }, (_, index) => prSummary({
      number: index + 1,
      url: PR_URL.replace(/\d+$/, String(index + 1)),
      state: "passing",
      checkState: "passing",
      createdAt: index + 2,
    }));
    const pending = prSummary({ createdAt: 1 });
    const passing = { ...pending, state: "passing", checkState: "passing" } satisfies PrSummary;
    const detail = (pr: PrSummary) => threadSummary([pr, ...otherPrs]);
    const preview = (prs: PrSummary[]) => ({ ...threadSummary(prs), prsTruncated: true, prCount: 17 });
    const transcript = (activeThread: NavigationThreadSummary, row: NavigationThreadSummary) => (
      <PullRequestLinkProvider activeThread={activeThread} threads={[row]}>
        <ThreadMarkdown text={text} />
      </PullRequestLinkProvider>
    );
    const view = render(transcript(detail(pending), preview([pending, ...otherPrs.slice(1)])));
    const chips = screen.getAllByRole("button", { name: /#13290.*draft · checks pending/ });
    expect(chips).toHaveLength(2);
    const dots = chips.map((chip) => chip.querySelector(".pr-chip__dot"));
    act(() => chips[0]?.focus());

    view.rerender(transcript(detail(passing), preview(otherPrs)));
    const updated = screen.getAllByRole("button", { name: /#13290.*draft · checks passing/ });
    expect(updated).toHaveLength(2);
    updated.forEach((chip, index) => {
      expect(chip).toBe(chips[index]);
      expect(chip.querySelector(".pr-chip__dot")).toBe(dots[index]);
    });
    expect(chips[0]).toHaveFocus();
    expect(chips[0]).toHaveAttribute("data-pr-url", deepUrl);
    expect(screen.getByRole("tooltip")).toHaveTextContent("draft · checks passing");
  });

  it("keeps a resolved shorthand chip while its same-repository sibling row refreshes", () => {
    const active = projectThread({ id: "active", path: "/repos/catalog-service" });
    const sibling = (prs: PrSummary[]) => projectThread({ id: "sibling", path: "/repos/catalog-service", prs });
    const transcript = (activeThread: NavigationThreadSummary, rows: NavigationThreadSummary[]) => (
      <PullRequestLinkProvider activeThread={activeThread} threads={rows}>
        <ThreadMarkdown text="The fix is in #13290." />
      </PullRequestLinkProvider>
    );
    const pending = prSummary();
    const passing = prSummary({ state: "passing", checkState: "passing" });
    const view = render(transcript(active, [active, sibling([pending])]));
    const chip = screen.getByRole("button", { name: /#13290.*draft · checks pending/ });
    const dot = chip.querySelector(".pr-chip__dot");

    view.rerender(transcript(active, [active]));
    expect(screen.getByRole("button", { name: /#13290.*draft · checks pending/ })).toBe(chip);
    view.rerender(transcript(active, [active, sibling([passing])]));
    expect(screen.getByRole("button", { name: /#13290.*draft · checks passing/ })).toBe(chip);
    expect(chip.querySelector(".pr-chip__dot")).toBe(dot);

    const other = projectThread({ id: "other", path: "/repos/analytics" });
    const competing = projectThread({ id: "competing", path: "/repos/analytics", prs: [prSummary({
      repo: "analytics", url: PR_URL.replace("catalog-service", "analytics"),
    })] });
    const bothRepositories = { ...active, linkedDirectories: [...active.linkedDirectories, ...other.linkedDirectories] };
    view.rerender(transcript(bothRepositories, [bothRepositories, sibling([passing]), competing]));
    expect(screen.queryByRole("button", { name: /#13290/ })).toBeNull();

    view.rerender(transcript(active, [active, sibling([passing])]));
    expect(screen.getByRole("button", { name: /#13290.*draft · checks passing/ })).toBeInTheDocument();
    view.rerender(transcript(other, [other]));
    expect(screen.queryByRole("button", { name: /#13290/ })).toBeNull();
    expect(screen.getByText(/The fix is in #13290\./)).toBeInTheDocument();
  });

  it.each([
    {
      field: "additions",
      initial: { additions: 12, deletions: 4 },
      updated: { additions: 18, deletions: 4 },
      selector: ".diff-stat__added",
      initialText: "+12",
      updatedText: "+18",
    },
    {
      field: "deletions",
      initial: { additions: 12, deletions: 4 },
      updated: { additions: 12, deletions: 9 },
      selector: ".diff-stat__removed",
      initialText: "-4",
      updatedText: "-9",
    },
    {
      field: "changedFiles",
      initial: { changedFiles: 3 },
      updated: { changedFiles: 6 },
      selector: ".pr-status-card__files",
      initialText: "3 files",
      updatedText: "6 files",
    },
    {
      field: "commitCount",
      initial: { commitCount: 2 },
      updated: { commitCount: 5 },
      selector: ".pr-status-card__caption",
      initialText: "2 commits",
      updatedText: "5 commits",
    },
    {
      field: "createdAt",
      initial: { createdAt: Date.parse("2026-08-08T12:00:00Z") },
      updated: { createdAt: Date.parse("2026-08-07T12:00:00Z") },
      selector: ".pr-status-card__row-value",
      initialText: "2d ago",
      updatedText: "3d ago",
    },
    {
      field: "mergedAt",
      initial: {
        state: "merged" as const,
        lifecycleState: "merged" as const,
        mergedAt: Date.parse("2026-08-10T10:00:00Z"),
      },
      updated: {
        state: "merged" as const,
        lifecycleState: "merged" as const,
        mergedAt: Date.parse("2026-08-10T09:00:00Z"),
      },
      selector: ".pr-status-card__row-value",
      initialText: "2h ago",
      updatedText: "3h ago",
    },
    {
      field: "closedAt",
      initial: {
        state: "closed" as const,
        lifecycleState: "closed" as const,
        closedAt: Date.parse("2026-08-10T10:00:00Z"),
      },
      updated: {
        state: "closed" as const,
        lifecycleState: "closed" as const,
        closedAt: Date.parse("2026-08-10T09:00:00Z"),
      },
      selector: ".pr-status-card__row-value",
      initialText: "2h ago",
      updatedText: "3h ago",
    },
  ])("updates a visible status card when only $field changes", ({
    initial,
    initialText,
    selector,
    updated,
    updatedText,
  }) => {
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2026-08-10T12:00:00Z"),
    );
    const text = `Draft PR: [ExampleOrg/catalog-service#13290](${PR_URL})`;
    const initialThread = threadSummary([prSummary(initial)]);
    const { rerender } = render(
      <PullRequestLinkProvider
        activeThread={initialThread}
        threads={[initialThread]}
      >
        <ThreadMarkdown text={text} />
      </PullRequestLinkProvider>,
    );
    const markdownNode = screen.getByText("Draft PR:").parentElement;
    fireEvent.focus(screen.getByRole("button", {
      name: /Open ExampleOrg\/catalog-service#13290/,
    }));
    expect(screen.getByRole("tooltip").querySelector(selector))
      .toHaveTextContent(initialText);

    const updatedThread = threadSummary([prSummary(updated)]);
    rerender(
      <PullRequestLinkProvider
        activeThread={updatedThread}
        threads={[updatedThread]}
      >
        <ThreadMarkdown text={text} />
      </PullRequestLinkProvider>,
    );

    expect(screen.getByRole("tooltip").querySelector(selector))
      .toHaveTextContent(updatedText);
    expect(screen.getByText("Draft PR:").parentElement).toBe(markdownNode);
  });

  it("preserves an authored PR deep link while hydrating its live status", () => {
    const deepLink = `${PR_URL}/files?diff=split`;
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderWithPullRequests(`Review [the changed files](${deepLink})`, [
      prSummary(),
    ]);

    const chip = screen.getByRole("button", {
      name: /Open ExampleOrg\/catalog-service#13290 \(draft · checks pending\) in browser/,
    });
    expect(chip).toHaveClass("pr-chip--pending", "pr-chip--draft");

    fireEvent.click(chip);
    expect(open).toHaveBeenCalledWith(
      deepLink,
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("returns to unknown status when the last matching PR metadata disappears", () => {
    const text = `Draft PR: [ExampleOrg/catalog-service#13290](${PR_URL})`;
    const { rerender } = renderWithPullRequests(text, [prSummary()]);

    const hydratedChip = screen.getByRole("button", {
      name: /draft · checks pending/,
    });
    fireEvent.focus(hydratedChip);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Document JDK 17 for EMR jobs",
    );

    rerender(
      <PullRequestLinkProvider threads={[threadSummary([])]}>
        <ThreadMarkdown text={text} />
      </PullRequestLinkProvider>,
    );

    const fallbackChip = screen.getByRole("button", {
      name: /Open ExampleOrg\/catalog-service#13290 \(status unknown\) in browser/,
    });
    expect(fallbackChip).toHaveClass("pr-chip--unknown");
    expect(fallbackChip).not.toHaveClass("pr-chip--draft");
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "ExampleOrg/catalog-service#13290",
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent("status unknown");
    // A PR with no status signal has no lifecycle word to show either.
    expect(
      screen.getByRole("tooltip").querySelector(".pr-status-card__phase"),
    ).toBeNull();
    expect(screen.getByRole("tooltip")).not.toHaveTextContent(
      "Document JDK 17 for EMR jobs",
    );
  });

  it("renders an unhydrated bare GitHub PR URL as an unknown-status chip", () => {
    renderWithPullRequests(`Draft PR: ${PR_URL}`, []);

    const chip = screen.getByRole("button", {
      name: /Open ExampleOrg\/catalog-service#13290 \(status unknown\) in browser/,
    });
    expect(chip).toHaveClass("pr-chip--unknown");
    expect(chip).toHaveTextContent("ExampleOrg/catalog-service#13290");
  });

  it("leaves non-PR GitHub links as normal transcript links", () => {
    renderWithPullRequests(
      "Issue: [ExampleOrg/catalog-service#13290](https://github.com/ExampleOrg/catalog-service/issues/13290)",
      [],
    );

    expect(screen.queryByRole("button", { name: /ExampleOrg\/catalog-service#13290/ }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ExampleOrg/catalog-service#13290" }))
      .toBeInTheDocument();
  });

  it("renders GitHub review comment permalinks as atomic PR chips", () => {
    const commentUrls = [
      `${PR_URL}#discussion_r3549020872`,
      `${PR_URL}#discussion_r3549020877`,
      `${PR_URL}#discussion_r3549138295`,
    ];
    renderWithPullRequests(commentUrls.join("\n\n"), [prSummary()]);

    expect(screen.getAllByRole("button", {
      name: /Open ExampleOrg\/catalog-service#13290/,
    })).toHaveLength(3);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("leaves PR links as normal links on surfaces without navigation metadata", () => {
    render(<ThreadMarkdown text={`Draft PR: [#13290](${PR_URL})`} />);

    expect(screen.queryByRole("button", { name: /#13290/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "#13290" })).toBeInTheDocument();
  });

  it("leaves bare PR-style text plain on surfaces without navigation metadata", () => {
    render(<ThreadMarkdown text="Related: #13290." />);

    expect(screen.queryByRole("button", { name: /#13290/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "#13290" })).not.toBeInTheDocument();
    expect(screen.getByText(/#13290/)).toBeInTheDocument();
  });
});

describe("parseGitHubPullRequestUrl", () => {
  it("accepts PR subpaths and query strings while preserving the target URL", () => {
    const href = `${PR_URL}/files?diff=split`;
    expect(parseGitHubPullRequestUrl(href)).toMatchObject({
      provider: "github.com",
      org: "ExampleOrg",
      repo: "catalog-service",
      number: 13290,
      state: "unknown",
      url: href,
    });
  });

  it("accepts GitHub pull request comment permalinks and preserves the target URL", () => {
    expect(parseGitHubPullRequestUrl(
      `${PR_URL}#discussion_r3549020872`,
    )?.url).toBe(`${PR_URL}#discussion_r3549020872`);
    expect(parseGitHubPullRequestUrl(
      `${PR_URL}#issuecomment-3549020872`,
    )?.url).toBe(`${PR_URL}#issuecomment-3549020872`);
    expect(parseGitHubPullRequestUrl(
      `${PR_URL}#pullrequestreview-3549020872`,
    )?.url).toBe(`${PR_URL}#pullrequestreview-3549020872`);
  });

  it("rejects issues, invalid numbers, non-GitHub hosts, and insecure URLs", () => {
    expect(parseGitHubPullRequestUrl(
      "https://github.com/ExampleOrg/catalog-service/issues/13290",
    )).toBeUndefined();
    expect(parseGitHubPullRequestUrl(
      "https://github.com/ExampleOrg/catalog-service/pull/not-a-number",
    )).toBeUndefined();
    expect(parseGitHubPullRequestUrl(
      "https://gitlab.com/ExampleOrg/catalog-service/pull/13290",
    )).toBeUndefined();
    expect(parseGitHubPullRequestUrl(
      "http://github.com/ExampleOrg/catalog-service/pull/13290",
    )).toBeUndefined();
    expect(parseGitHubPullRequestUrl(
      "https://github.com/%E0%A4%A/catalog-service/pull/13290",
    )).toBeUndefined();
  });
});

describe("parsePullRequestUrl", () => {
  it.each([
    {
      href: "https://github.corp.example/pwrdrvr/PwrAgent/pull/49/files",
      expected: {
        provider: "github.corp.example",
        org: "pwrdrvr",
        repo: "PwrAgent",
        number: 49,
      },
    },
    {
      href: "https://gitlab.com/pwrdrvr/platform/PwrAgent/-/merge_requests/49",
      expected: {
        provider: "gitlab.com",
        org: "pwrdrvr/platform",
        repo: "PwrAgent",
        number: 49,
      },
    },
  ])("parses forge-aware pull request links for $href", ({ href, expected }) => {
    expect(parsePullRequestUrl(href)).toMatchObject({
      ...expected,
      state: "unknown",
      url: href,
    });
  });
});
