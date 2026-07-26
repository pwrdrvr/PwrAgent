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

function threadSummary(prs: PrSummary[]): NavigationThreadSummary {
  return {
    id: "thread-pr-link",
    title: "EMR JDK 17 guidance",
    titleSource: "derived",
    source: "codex",
    linkedDirectories: [],
    inbox: { inInbox: true, unread: false },
    prs,
  } as NavigationThreadSummary;
}

function renderWithPullRequests(
  text: string,
  prs: PrSummary[],
) {
  return render(
    <PullRequestLinkProvider threads={[threadSummary(prs)]}>
      <ThreadMarkdown text={text} />
    </PullRequestLinkProvider>,
  );
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
