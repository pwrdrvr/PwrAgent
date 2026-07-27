import "@testing-library/jest-dom/vitest";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseGitHubPullRequestUrl,
  PullRequestLinkProvider,
} from "../../../lib/pull-request-links";
import { ThreadMarkdown } from "../ThreadMarkdown";

const PR_URL = "https://github.com/Giphy/giphy-services/pull/13290";

function prSummary(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    provider: "github.com",
    number: 13290,
    org: "Giphy",
    repo: "giphy-services",
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
      },
    ],
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pull request links in transcript markdown", () => {
  it("renders a known GitHub PR link with the shared live status chip", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderWithPullRequests(`Draft PR: [Giphy/giphy-services#13290](${PR_URL})`, [
      prSummary(),
    ]);

    const chip = screen.getByRole("button", {
      name: /Open Giphy\/giphy-services#13290 \(draft · checks pending\) in browser/,
    });
    expect(chip).toHaveClass("pr-chip", "pr-chip--pending", "pr-chip--draft");
    expect(chip).toHaveTextContent("Giphy/giphy-services#13290");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    fireEvent.click(chip);
    expect(open).toHaveBeenCalledWith(PR_URL, "_blank", "noopener,noreferrer");
  });

  it("hydrates the exact draft-PR link shape emitted by a completed thread", () => {
    renderWithPullRequests(
      `Draft PR: [#13290 — Document JDK 17 for EMR jobs](${PR_URL})`,
      [prSummary()],
    );

    expect(screen.getByRole("button", {
      name: /Open Giphy\/giphy-services#13290 \(draft · checks pending\) in browser/,
    })).toHaveTextContent("Giphy/giphy-services#13290");
    expect(screen.queryByRole("link", {
      name: "#13290 — Document JDK 17 for EMR jobs",
    })).not.toBeInTheDocument();
  });

  it("hydrates a bare PR number known on the active thread", () => {
    renderWithPullRequests("Rebased onto current origin/main, including #13290.", [
      prSummary(),
    ]);

    expect(screen.getByRole("button", {
      name: /Open Giphy\/giphy-services#13290 \(draft · checks pending\) in browser/,
    })).toBeInTheDocument();
  });

  it("hydrates a bare PR number known by a sibling thread in the same repository", () => {
    const activeThread = projectThread({
      id: "thread-active",
      path: "/repos/giphy-services",
    });
    const siblingThread = projectThread({
      id: "thread-sibling",
      path: "/repos/giphy-services",
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
      name: /Open Giphy\/giphy-services#13290 \(draft · checks pending\) in browser/,
    })).toBeInTheDocument();
  });

  it("leaves a bare number plain when the known PR belongs to another project", () => {
    const activeThread = projectThread({
      id: "thread-active",
      path: "/repos/current-project",
    });
    const unrelatedThread = projectThread({
      id: "thread-unrelated",
      path: "/repos/giphy-services",
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
      name: /Giphy\/giphy-services#13290/,
    })).not.toBeInTheDocument();
    expect(screen.getByText(/#13290/)).toBeInTheDocument();
  });

  it("leaves a bare number plain when it is ambiguous across linked repositories", () => {
    const firstPath = "/repos/giphy-services";
    const secondPath = "/repos/analytics";
    const activeThread = threadSummary([], {
      id: "thread-active",
      linkedDirectories: [
        {
          id: "active-first",
          kind: "worktree",
          label: "giphy-services",
          path: firstPath,
          worktreePath: "/worktrees/active-first",
        },
        {
          id: "active-second",
          kind: "worktree",
          label: "analytics",
          path: secondPath,
          worktreePath: "/worktrees/active-second",
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
          org: "Giphy",
          repo: "analytics",
          url: "https://github.com/Giphy/analytics/pull/13290",
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
      "Keep `#13290` literal and [issue #13290](https://github.com/Giphy/giphy-services/issues/13290) linked.",
      [prSummary()],
    );

    expect(screen.queryByRole("button", { name: /#13290/ })).not.toBeInTheDocument();
    expect(screen.getByText("#13290", { selector: "code" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "issue #13290" })).toBeInTheDocument();
  });

  it("hydrates a bare number when same-project PR metadata arrives later", () => {
    const activeThread = projectThread({
      id: "thread-active",
      path: "/repos/giphy-services",
    });
    const siblingWithoutPr = projectThread({
      id: "thread-sibling",
      path: "/repos/giphy-services",
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
      path: "/repos/giphy-services",
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
      name: /Open Giphy\/giphy-services#13290 \(draft · checks pending\) in browser/,
    })).toBeInTheDocument();
  });

  it("updates chip modes and a visible tooltip from live PR status metadata", () => {
    const text = `Draft PR: [Giphy/giphy-services#13290](${PR_URL})`;
    const { rerender } = renderWithPullRequests(text, [prSummary()]);

    const markdownNode = screen.getByText("Draft PR:").parentElement;
    const pendingChip = screen.getByRole("button", {
      name: /draft · checks pending/,
    });
    fireEvent.mouseEnter(pendingChip);
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
      "Giphy/giphy-services#13290 — merged",
    );
    expect(screen.getByText("Draft PR:").parentElement).toBe(markdownNode);
  });

  it("preserves an authored PR deep link while hydrating its live status", () => {
    const deepLink = `${PR_URL}/files?diff=split#discussion_r1`;
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderWithPullRequests(`Review [the changed files](${deepLink})`, [
      prSummary(),
    ]);

    const chip = screen.getByRole("button", {
      name: /Open Giphy\/giphy-services#13290 \(draft · checks pending\) in browser/,
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
    const text = `Draft PR: [Giphy/giphy-services#13290](${PR_URL})`;
    const { rerender } = renderWithPullRequests(text, [prSummary()]);

    const hydratedChip = screen.getByRole("button", {
      name: /draft · checks pending/,
    });
    fireEvent.mouseEnter(hydratedChip);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Document JDK 17 for EMR jobs",
    );

    rerender(
      <PullRequestLinkProvider threads={[threadSummary([])]}>
        <ThreadMarkdown text={text} />
      </PullRequestLinkProvider>,
    );

    const fallbackChip = screen.getByRole("button", {
      name: /Open Giphy\/giphy-services#13290 \(status unknown\) in browser/,
    });
    expect(fallbackChip).toHaveClass("pr-chip--unknown");
    expect(fallbackChip).not.toHaveClass("pr-chip--draft");
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Giphy/giphy-services#13290 — status unknown",
    );
    expect(screen.getByRole("tooltip")).not.toHaveTextContent(
      "Document JDK 17 for EMR jobs",
    );
  });

  it("renders an unhydrated bare GitHub PR URL as an unknown-status chip", () => {
    renderWithPullRequests(`Draft PR: ${PR_URL}`, []);

    const chip = screen.getByRole("button", {
      name: /Open Giphy\/giphy-services#13290 \(status unknown\) in browser/,
    });
    expect(chip).toHaveClass("pr-chip--unknown");
    expect(chip).toHaveTextContent("Giphy/giphy-services#13290");
  });

  it("leaves non-PR GitHub links as normal transcript links", () => {
    renderWithPullRequests(
      "Issue: [Giphy/giphy-services#13290](https://github.com/Giphy/giphy-services/issues/13290)",
      [],
    );

    expect(screen.queryByRole("button", { name: /Giphy\/giphy-services#13290/ }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Giphy/giphy-services#13290" }))
      .toBeInTheDocument();
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
    const href = `${PR_URL}/files?diff=split#discussion_r1`;
    expect(parseGitHubPullRequestUrl(href)).toMatchObject({
      provider: "github.com",
      org: "Giphy",
      repo: "giphy-services",
      number: 13290,
      state: "unknown",
      url: href,
    });
  });

  it("rejects issues, invalid numbers, non-GitHub hosts, and insecure URLs", () => {
    expect(parseGitHubPullRequestUrl(
      "https://github.com/Giphy/giphy-services/issues/13290",
    )).toBeUndefined();
    expect(parseGitHubPullRequestUrl(
      "https://github.com/Giphy/giphy-services/pull/not-a-number",
    )).toBeUndefined();
    expect(parseGitHubPullRequestUrl(
      "https://gitlab.com/Giphy/giphy-services/pull/13290",
    )).toBeUndefined();
    expect(parseGitHubPullRequestUrl(
      "http://github.com/Giphy/giphy-services/pull/13290",
    )).toBeUndefined();
    expect(parseGitHubPullRequestUrl(
      "https://github.com/%E0%A4%A/giphy-services/pull/13290",
    )).toBeUndefined();
  });
});
