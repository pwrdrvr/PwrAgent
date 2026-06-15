// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ThreadSearchResponse } from "@pwragent/shared";
import { basename, highlightSnippet, ThreadSearchPanel } from "../ThreadSearchPanel";
import type { DesktopApi } from "../../../lib/desktop-api";

describe("ThreadSearchPanel", () => {
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
