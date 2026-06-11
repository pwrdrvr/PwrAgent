// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ThreadSearchResponse } from "@pwragent/shared";
import { ThreadSearchPanel } from "../ThreadSearchPanel";
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
});
