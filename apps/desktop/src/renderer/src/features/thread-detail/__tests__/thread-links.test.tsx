import "@testing-library/jest-dom/vitest";
import type { AppServerBackendKind, NavigationThreadSummary } from "@pwragent/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThreadLinkProvider } from "../../../lib/thread-links";
import { ThreadMarkdown } from "../ThreadMarkdown";

const CHILD_THREAD_ID = "019f5d79-a595-73f2-84d9-a0976762c303";

function threadSummary(
  overrides: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary {
  return {
    id: CHILD_THREAD_ID,
    title: "RELATED query deranking issue",
    titleSource: "generated",
    source: "codex",
    linkedDirectories: [],
    inbox: { unread: false },
    ...overrides,
  } as NavigationThreadSummary;
}

function renderWithLinks(
  text: string,
  options: {
    onShowThread?: (request: { backend: AppServerBackendKind; threadId: string }) => void;
    threads?: NavigationThreadSummary[];
  } = {},
) {
  const onShowThread = options.onShowThread ?? vi.fn();
  return render(
    <ThreadLinkProvider
      onShowThread={onShowThread}
      threads={options.threads ?? [threadSummary()]}
    >
      <ThreadMarkdown text={text} />
    </ThreadLinkProvider>,
  );
}

describe("thread links in transcript markdown", () => {
  it("renders a pwragent thread link as a chip showing the thread's live title", () => {
    renderWithLinks(
      `Created [the handoff](pwragent://thread/${CHILD_THREAD_ID}?backend=codex)`,
    );

    // The chip prefers the thread's current title over whatever the author
    // wrote, so a renamed thread does not keep showing a stale label.
    expect(
      screen.getByRole("button", { name: "Open thread RELATED query deranking issue" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "the handoff" })).not.toBeInTheDocument();
  });

  it("navigates to the thread when the chip is clicked", () => {
    const onShowThread = vi.fn();
    renderWithLinks(`See [handoff](pwragent://thread/${CHILD_THREAD_ID})`, {
      onShowThread,
    });

    fireEvent.click(screen.getByRole("button", { name: /Open thread/ }));

    expect(onShowThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: CHILD_THREAD_ID,
    });
  });

  it("linkifies a bare thread id written as inline code", () => {
    // The shape every pre-protocol handoff message used.
    renderWithLinks(`Created the PwrAgent handoff thread: \`${CHILD_THREAD_ID}\``);

    expect(
      screen.getByRole("button", { name: "Open thread RELATED query deranking issue" }),
    ).toBeInTheDocument();
  });

  it("leaves inline code alone when it is not a known thread id", () => {
    renderWithLinks("Run `pnpm lint:eslint` and check `019f0000-not-a-thread`");

    expect(screen.queryByRole("button", { name: /Open thread/ })).not.toBeInTheDocument();
    expect(screen.getByText("pnpm lint:eslint")).toBeInTheDocument();
  });

  it("does not linkify a thread id inside a fenced code block", () => {
    renderWithLinks(["```", CHILD_THREAD_ID, "```"].join("\n"));

    expect(screen.queryByRole("button", { name: /Open thread/ })).not.toBeInTheDocument();
  });

  it("degrades an unresolvable thread link to plain text, never a dead anchor", () => {
    // A thread from another profile, or one since deleted. It must not become
    // an <a> — `pwragent:` is absent from the external-open allowlist, so the
    // click would silently do nothing.
    const { container } = renderWithLinks(
      "See [other profile's thread](pwragent://thread/unknown-thread-id)",
    );

    expect(screen.queryByRole("button", { name: /Open thread/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container.textContent).toContain("See other profile's thread");
  });

  it("renders plain text on surfaces that have no thread navigation", () => {
    // Activity / Changelog / markdown-file windows mount ThreadMarkdown with
    // no ThreadLinkProvider above it.
    const { container } = render(
      <ThreadMarkdown text={`See [handoff](pwragent://thread/${CHILD_THREAD_ID})`} />,
    );

    expect(screen.queryByRole("button", { name: /Open thread/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container.textContent).toContain("See handoff");
  });

  it("prefers the backend named in the link when two backends share a thread id", () => {
    const onShowThread = vi.fn();
    renderWithLinks(`[t](pwragent://thread/${CHILD_THREAD_ID}?backend=acp%3Aclaude-code)`, {
      onShowThread,
      threads: [
        threadSummary({ source: "codex", title: "Codex thread" }),
        threadSummary({ source: "acp:claude-code", title: "ACP thread" }),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Open thread ACP thread" }));

    expect(onShowThread).toHaveBeenCalledWith({
      backend: "acp:claude-code",
      threadId: CHILD_THREAD_ID,
    });
  });

  it("upgrades a link to a chip once its thread appears in the snapshot", () => {
    // The provider keys its context on thread *membership*, not on the churny
    // array reference, so this proves a newly-hydrated thread (the handoff
    // case) still flips a plain-text link into a chip.
    const text = `See [handoff](pwragent://thread/${CHILD_THREAD_ID})`;
    const onShowThread = vi.fn();
    const { rerender } = render(
      <ThreadLinkProvider onShowThread={onShowThread} threads={[]}>
        <ThreadMarkdown text={text} />
      </ThreadLinkProvider>,
    );

    expect(screen.queryByRole("button", { name: /Open thread/ })).not.toBeInTheDocument();

    rerender(
      <ThreadLinkProvider onShowThread={onShowThread} threads={[threadSummary()]}>
        <ThreadMarkdown text={text} />
      </ThreadLinkProvider>,
    );

    expect(
      screen.getByRole("button", { name: "Open thread RELATED query deranking issue" }),
    ).toBeInTheDocument();
  });
});
