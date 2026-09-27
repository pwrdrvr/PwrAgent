// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  NavigationThreadSummary,
  ThreadSearchResponse,
} from "@pwragent/shared";
import { basename, highlightSnippet, ThreadSearchPanel } from "../ThreadSearchPanel";
import type { DesktopApi } from "../../../lib/desktop-api";

describe("ThreadSearchPanel", () => {
  it("toggles accessible search syntax help", () => {
    render(<ThreadSearchPanel onOpenResult={vi.fn()} />);
    const help = screen.getByRole("button", { name: "Search help" });
    expect(help).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(help);
    expect(help).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: "Search syntax" })).toHaveTextContent("build in:@disk");
    fireEvent.click(help);
    expect(screen.queryByRole("region", { name: "Search syntax" })).not.toBeInTheDocument();
  });

  it("scopes client-side PR matches using the text remaining after mentions", async () => {
    const searchThreads = vi.fn(async (): Promise<ThreadSearchResponse> => ({
      backend: "all", contentMode: "available", fetchedAt: 1000, filters: {},
      query: "#779 @disk", results: [], searchedScopes: [], semanticMode: "disabled",
      unavailableScopes: [],
    }));
    const threads: NavigationThreadSummary[] = ["DiskHound", "Other"].map((projectKey) => ({
      id: projectKey, title: `${projectKey} thread`, titleSource: "explicit", source: "codex",
      projectKey, linkedDirectories: [], inbox: { inInbox: true },
      prs: [{ provider: "github.com", number: 779, org: "example", repo: projectKey,
        state: "pending", url: `https://github.com/example/${projectKey}/pull/779` }],
    }));
    render(<ThreadSearchPanel desktopApi={{ searchThreads } as DesktopApi}
      threads={threads} onOpenResult={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search threads"), { target: { value: "#779 @disk" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("DiskHound thread")).toBeInTheDocument();
    expect(screen.queryByText("Other thread")).not.toBeInTheDocument();
    expect(searchThreads).toHaveBeenCalledWith(expect.objectContaining({ query: "#779 @disk" }));
  });

  it("submits a search and opens a result", async () => {
    const searchThreads = vi.fn(async (): Promise<ThreadSearchResponse> => ({
      backend: "all",
      contentMode: "available",
      fetchedAt: 1_000,
      filters: { backend: "all", includeArchived: false },
      query: "branch drift",
      results: [
        {
          backend: "codex",
          confidence: "medium",
          identityKey: "codex:thread-1",
          linkedDirectories: [],
          matchReasons: [{ kind: "provider_content_match" }],
          score: 25,
          snippets: [
            {
              scope: "provider_content",
              text: "Asked about branch drift screenshots.",
            },
          ],
          source: "codex",
          threadId: "thread-1",
          title: "Screenshots",
        },
      ],
      searchedScopes: ["metadata", "projection"],
      semanticMode: "disabled",
      unavailableScopes: [],
    }));
    const onOpenResult = vi.fn();

    render(
      <ThreadSearchPanel
        desktopApi={{ searchThreads } as DesktopApi}
        onOpenResult={onOpenResult}
      />,
    );

    fireEvent.change(screen.getByLabelText("Search threads"), {
      target: { value: "branch drift" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Screenshots")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Screenshots/ }));

    await waitFor(() => {
      expect(onOpenResult).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
      });
    });
  });

  it("closes on Escape, including after typing a query", () => {
    const onClose = vi.fn();
    render(<ThreadSearchPanel onOpenResult={vi.fn()} onClose={onClose} />);

    const input = screen.getByLabelText("Search threads");
    fireEvent.change(input, { target: { value: "still typing" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("finds and marks Agent threads from navigation metadata", async () => {
    const searchThreads = vi.fn(async (): Promise<ThreadSearchResponse> => ({
      backend: "all",
      contentMode: "available",
      fetchedAt: 1_000,
      filters: {},
      query: "Agent",
      results: [],
      searchedScopes: ["metadata"],
      semanticMode: "disabled",
      unavailableScopes: [],
    }));
    const threads: NavigationThreadSummary[] = [
      {
        id: "agent-1",
        title: "You are Jeeves",
        titleSource: "explicit",
        source: "codex",
        inbox: { inInbox: true },
        linkedDirectories: [],
        agent: {
          name: "Jeeves",
          instructions: "Help people decide what to do next.",
          instructionLineCount: 1,
          instructionsTooLong: false,
          updatedAt: 1_000,
        },
      },
    ];

    render(
      <ThreadSearchPanel
        desktopApi={{ searchThreads } as DesktopApi}
        onOpenResult={vi.fn()}
        threads={threads}
      />,
    );

    fireEvent.change(screen.getByLabelText("Search threads"), {
      target: { value: "Agent" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("You are Jeeves")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent thread")).toHaveTextContent("Agent");
    expect(screen.getByText("Agent match")).toBeInTheDocument();
  });

  it("labels remote search results and preserves their federation target", async () => {
    const onOpenResult = vi.fn();
    const searchThreads = vi.fn(async (): Promise<ThreadSearchResponse> => ({
      backend: "all",
      contentMode: "available",
      fetchedAt: 1_000,
      filters: { backend: "all", includeArchived: false },
      query: "deploy",
      results: [
        {
          backend: "codex",
          confidence: "medium",
          identityKey: "remote:client_one:codex:thread-1",
          linkedDirectories: [],
          matchReasons: [{ kind: "title_token_overlap" }],
          score: 10,
          snippets: [{ scope: "metadata", text: "Deploy release" }],
          source: "codex",
          threadId: "thread-1",
          title: "Deploy release",
          federation: {
            ref: {
              backend: "codex",
              target: { scope: "remote", instanceId: "client_one" },
              threadId: "thread-1",
            },
            instanceLabel: "Studio Mac",
            peerStatus: "connected",
          },
        },
      ],
      searchedScopes: ["metadata"],
      semanticMode: "disabled",
      unavailableScopes: [],
    }));

    render(
      <ThreadSearchPanel
        desktopApi={{ searchThreads } as DesktopApi}
        onOpenResult={onOpenResult}
      />,
    );
    fireEvent.change(screen.getByLabelText("Search threads"), {
      target: { value: "deploy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Studio Mac")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Deploy release/ }));

    expect(onOpenResult).toHaveBeenCalledWith({
      backend: "codex",
      federation: {
        ref: {
          backend: "codex",
          target: { scope: "remote", instanceId: "client_one" },
          threadId: "thread-1",
        },
        instanceLabel: "Studio Mac",
        peerStatus: "connected",
      },
      threadId: "thread-1",
    });
  });
});

describe("basename", () => {
  it("returns the final segment of a posix path", () => {
    expect(basename("/Users/me/code/PwrAgnt")).toBe("PwrAgnt");
  });

  it("returns the final segment of a windows path", () => {
    expect(basename("C:\\Users\\me\\PwrAgnt")).toBe("PwrAgnt");
  });

  it("ignores a trailing slash", () => {
    expect(basename("/a/b/")).toBe("b");
  });

  it("returns a bare name unchanged", () => {
    expect(basename("PwrAgnt")).toBe("PwrAgnt");
  });
});

describe("highlightSnippet", () => {
  it("highlights whole quoted phrases with or without quotes in the snippet", () => {
    const text = 'An Ad Hoc task, an "ad hoc" fix, and ad with hoc later';
    const { container } = render(<>{highlightSnippet(text, '"ad hoc"')}</>);
    expect(Array.from(container.querySelectorAll("mark"), (mark) => mark.textContent))
      .toEqual(["Ad Hoc", "ad hoc"]);
    expect(container.textContent).toBe(text);
  });

  it("highlights a quoted literal mention and unquoted terms together", () => {
    const { container } = render(<>{highlightSnippet("Fix @disk handling", 'fix "@disk"')}</>);
    expect(Array.from(container.querySelectorAll("mark"), (mark) => mark.textContent))
      .toEqual(["Fix", "@disk"]);
  });

  it("wraps each query token occurrence in a <mark>, case-insensitively", () => {
    const { container } = render(<>{highlightSnippet("the Bar and a bar", "bar")}</>);
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(2);
    expect(marks[0]).toHaveTextContent("Bar");
    expect(marks[1]).toHaveTextContent("bar");
    // The full text is preserved, just segmented.
    expect(container.textContent).toBe("the Bar and a bar");
  });

  it("treats regex-special characters in the query as literals", () => {
    const { container } = render(<>{highlightSnippet("use a+b not axb", "a+b")}</>);
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent("a+b");
  });

  it("renders no marks and preserves text when nothing matches", () => {
    const { container } = render(<>{highlightSnippet("hello world", "zzz")}</>);
    expect(container.querySelectorAll("mark")).toHaveLength(0);
    expect(container.textContent).toBe("hello world");
  });

  it("ignores query tokens shorter than two characters", () => {
    const { container } = render(<>{highlightSnippet("a apple", "a")}</>);
    expect(container.querySelectorAll("mark")).toHaveLength(0);
  });
});
