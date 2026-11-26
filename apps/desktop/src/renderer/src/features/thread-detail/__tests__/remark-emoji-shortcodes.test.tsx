import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadEmojiCatalog } from "../../../lib/emoji-shortcodes";
import {
  MarkdownRenderingOptionsProvider,
  useIncrementalMarkdownRenderer,
} from "../../../lib/markdown-rendering-options";
import { ThreadMarkdown } from "../ThreadMarkdown";

function RenderMarkdown(props: { incremental?: boolean; text: string }) {
  return (
    <MarkdownRenderingOptionsProvider
      mathEnabled={false}
      incrementalEnabled={props.incremental ?? false}
    >
      <ThreadMarkdown text={props.text} />
    </MarkdownRenderingOptionsProvider>
  );
}

beforeAll(async () => {
  await loadEmojiCatalog();
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

describe.each([false, true])(
  "ThreadMarkdown :shortcode: expansion (incremental=%s)",
  (incremental) => {
    it("expands known shortcodes in prose, emphasis, parentheticals, and lists", () => {
      const markdown = [
        "Ship it :rocket:! :+1: and :thumbsup: (plus :avocado:).",
        "",
        "**:tada:**",
        "",
        "- Done :white_check_mark:",
      ].join("\n");

      const { container } = render(
        <RenderMarkdown incremental={incremental} text={markdown} />,
      );

      const paragraphs = container.querySelectorAll("p");
      expect(paragraphs[0]?.textContent).toBe("Ship it 🚀! 👍 and 👍 (plus 🥑).");
      expect(container.querySelector("strong")?.textContent).toBe("🎉");
      expect(container.querySelector("li")?.textContent).toBe("Done ✅");
    });

    it("strictly skips inline code, fenced code blocks, links/URLs, non-boundary colons, and unknown shortcodes", () => {
      const markdown = [
        "Inline `:+1:` and `:rocket:` stay literal.",
        "",
        "Link [:thumbsup:](https://example.com/:rocket:/path) and https://example.com/:+1:/ok.",
        "",
        "Identifiers: std::vector, foo:bar:baz, foo:+1:bar, 12:30:00, `:code`:+1:, foo**:+1:**bar, :unknown_emoji:.",
        "",
        "```ts",
        "const ok = ':+1:'; // :rocket:",
        "```",
      ].join("\n");

      const { container } = render(
        <RenderMarkdown incremental={incremental} text={markdown} />,
      );

      expect(container.querySelectorAll("code")[0]?.textContent).toBe(":+1:");
      expect(container.querySelectorAll("code")[1]?.textContent).toBe(":rocket:");
      const links = container.querySelectorAll("a");
      expect(links[0]?.textContent).toBe(":thumbsup:");
      expect(links[0]).toHaveAttribute("href", "https://example.com/:rocket:/path");
      expect(links[1]?.textContent).toBe("https://example.com/:+1:/ok");

      const preCode = container.querySelector("pre code");
      expect(preCode?.textContent).toContain(":+1:");
      expect(preCode?.textContent).toContain(":rocket:");

      expect(container.textContent).toContain("std::vector");
      expect(container.textContent).toContain("foo:bar:baz");
      expect(container.textContent).toContain("foo:+1:bar");
      expect(container.textContent).toContain("12:30:00");
      expect(container.textContent).toContain("foo:+1:bar");
      expect(container.textContent).toContain(":unknown_emoji:");
      expect(container.textContent).not.toContain("👍");
      expect(container.textContent).not.toContain("🚀");
    });
  },
);

describe("IncrementalMarkdown streaming parity for emoji shortcodes", () => {
  it("matches standard ThreadMarkdown across streaming cuts", () => {
    const text = [
      "First paragraph with :+1: and `:+1:`.\n\n",
      "Second with :rocket: and std::vector and 12:30:00.\n\n",
      "```ts\nconst x = ':tada:';\n```\n\n",
      "Closing :avocado:!\n\n",
    ].join("");

    const incrementalView = render(
      <StrictMode>
        <RenderMarkdown incremental text="" />
      </StrictMode>,
    );

    const cuts = [5, 22, 39, 60, 95, text.length];
    for (const end of cuts) {
      const slice = text.slice(0, end);
      incrementalView.rerender(
        <StrictMode>
          <RenderMarkdown incremental text={slice} />
        </StrictMode>,
      );
      const standardView = render(<RenderMarkdown incremental={false} text={slice} />);
      expect(incrementalView.container.innerHTML, `cut=${end}`).toBe(
        standardView.container.innerHTML,
      );
      standardView.unmount();
    }
  });
});
