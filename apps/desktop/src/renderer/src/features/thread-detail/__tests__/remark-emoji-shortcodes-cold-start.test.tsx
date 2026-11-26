import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ReactionEmojiCatalog } from "../../navigation/reaction-emoji-catalog";
import { getCachedEmojiCatalog } from "../../../lib/emoji-shortcodes";
import {
  MarkdownRenderingOptionsProvider,
  useIncrementalMarkdownRenderer,
} from "../../../lib/markdown-rendering-options";
import { ThreadMarkdown } from "../ThreadMarkdown";

const loaderControl = vi.hoisted(() => {
  let resolveLoader: ((catalog: ReactionEmojiCatalog) => void) | undefined;
  let pendingPromise: Promise<ReactionEmojiCatalog> | undefined;
  return {
    calls: 0,
    createPromise: (): Promise<ReactionEmojiCatalog> => {
      pendingPromise = new Promise<ReactionEmojiCatalog>((resolve) => {
        resolveLoader = resolve;
      });
      return pendingPromise;
    },
    resolve: (catalog: ReactionEmojiCatalog) => {
      resolveLoader?.(catalog);
      resolveLoader = undefined;
    },
    reset: () => {
      resolveLoader = undefined;
      pendingPromise = undefined;
      loaderControl.calls = 0;
    },
  };
});

vi.mock("../../navigation/reaction-emoji-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../navigation/reaction-emoji-catalog")>();
  return {
    ...actual,
    loadReactionEmojiCatalog: () => {
      loaderControl.calls += 1;
      return loaderControl.createPromise();
    },
  };
});

function RenderMarkdown(props: { incremental: boolean; text: string }) {
  return (
    <MarkdownRenderingOptionsProvider
      mathEnabled={false}
      incrementalEnabled={props.incremental}
    >
      <ThreadMarkdown text={props.text} />
    </MarkdownRenderingOptionsProvider>
  );
}

beforeAll(async () => {
  function Readiness() {
    return useIncrementalMarkdownRenderer() ? "ready" : "loading";
  }
  const view = render(
    <MarkdownRenderingOptionsProvider mathEnabled={false} incrementalEnabled>
      <Readiness />
    </MarkdownRenderingOptionsProvider>,
  );
  await waitFor(() => expect(view.container.textContent).toBe("ready"));
  cleanup();
});

afterEach(() => {
  cleanup();
});

describe("ThreadMarkdown cold-start deferred emoji catalog loading", () => {
  it("never loads the full catalog on prose, timestamps, code, or base shortcodes, and preserves mounted blocks", () => {
    expect(getCachedEmojiCatalog()).toBeUndefined();
    expect(loaderControl.calls).toBe(0);

    const prose = [
      "Meeting at 12:30:00 with std::vector, `:+1:`, and :+1:.",
      "",
      "```ts",
      "const literal = ':avocado:';",
      "```",
    ].join("\n");

    const standard = render(<RenderMarkdown incremental={false} text={prose} />);
    expect(standard.container.querySelector("p")?.textContent).toBe(
      "Meeting at 12:30:00 with std::vector, :+1:, and 👍.",
    );
    expect(standard.container.querySelector("pre code")?.textContent).toContain(":avocado:");
    expect(loaderControl.calls).toBe(0);
    standard.unmount();

    const firstParagraph = "Log entry at 12:30 for service: worker-1.\n\n";
    const incremental = render(<RenderMarkdown incremental={true} text={firstParagraph} />);
    const mountedFirstParagraph = incremental.container.querySelector("p");
    expect(mountedFirstParagraph).not.toBeNull();

    // Streaming a late timestamp and base shortcode must not trigger catalog load or replace frozen blocks.
    incremental.rerender(
      <RenderMarkdown
        incremental={true}
        text={`${firstParagraph}Timestamp 12:30:00 shipped :rocket:.\n\n`}
      />,
    );
    expect(incremental.container.querySelector("p")).toBe(mountedFirstParagraph);
    expect(incremental.container.textContent).toContain("12:30:00 shipped 🚀.");
    expect(loaderControl.calls).toBe(0);
    expect(getCachedEmojiCatalog()).toBeUndefined();
  });

  it("defers loading until an unresolved boundary-safe shortcode appears and re-renders both standard and incremental modes", async () => {
    expect(getCachedEmojiCatalog()).toBeUndefined();
    expect(loaderControl.calls).toBe(0);

    const standard = render(<RenderMarkdown incremental={false} text="Fresh :avocado: ready!" />);
    const incremental = render(<RenderMarkdown incremental={true} text="Fresh :avocado: ready!" />);

    expect(standard.container.textContent).toBe("Fresh :avocado: ready!");
    expect(incremental.container.textContent).toBe("Fresh :avocado: ready!");
    await waitFor(() => {
      expect(loaderControl.calls).toBe(1);
    });

    const { buildReactionEmojiCatalog } = await import(
      "../../navigation/reaction-emoji-catalog"
    );
    await act(async () => {
      loaderControl.resolve(buildReactionEmojiCatalog());
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(standard.container.textContent).toBe("Fresh 🥑 ready!");
      expect(incremental.container.textContent).toBe("Fresh 🥑 ready!");
    });
    expect(getCachedEmojiCatalog()).toBeDefined();
    expect(loaderControl.calls).toBe(1);
  });
});
