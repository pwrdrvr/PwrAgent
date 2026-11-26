import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  advanceIncrementalParse,
  type AdvanceOptions,
  type IncrementalParseState,
} from "@ai-markdown/engine";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { buildReactionEmojiCatalog } from "../../navigation/reaction-emoji-catalog";
import { loadEmojiCatalog } from "../../../lib/emoji-shortcodes";
import {
  MarkdownRenderingOptionsProvider,
  useIncrementalMarkdownRenderer,
} from "../../../lib/markdown-rendering-options";
import { remarkEmojiShortcodes } from "../remark-emoji-shortcodes";
import { remarkPullRequestReferences } from "../remark-pull-request-references";
import { remarkTableProfile } from "../remark-table-profile";
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
        "**:tada:** and (**:+1:**) and foo (**:+1:**) vs foo(**:+1:**) and ***:+1:***",
        "",
        "- Done :white_check_mark:",
      ].join("\n");

      const { container } = render(
        <RenderMarkdown incremental={incremental} text={markdown} />,
      );

      const paragraphs = container.querySelectorAll("p");
      expect(paragraphs[0]?.textContent).toBe("Ship it 🚀! 👍 and 👍 (plus 🥑).");
      expect(paragraphs[1]?.textContent).toBe(
        "🎉 and (👍) and foo (👍) vs foo(:+1:) and 👍",
      );
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

  it("keeps streaming parse work strictly linear across appends with timestamps, colons, and shortcodes", () => {
    const catalog = buildReactionEmojiCatalog();
    let parsedCharacters = 0;
    const onMissingCatalog = vi.fn();
    const observe = () => (_tree: unknown, file: { value: unknown }) => {
      parsedCharacters += String(file.value).length;
    };
    const plugins: AdvanceOptions["remarkPlugins"] = [
      remarkBreaks,
      [remarkGfm, { singleTilde: false }],
      remarkPullRequestReferences,
      [remarkEmojiShortcodes, { catalog, onMissingCatalog }],
      remarkTableProfile,
      observe,
    ];
    const options: AdvanceOptions = {
      remarkPlugins: plugins,
      rehypePlugins: [],
      remarkRehypeOptions: undefined,
      depsKey: [plugins],
      defListEnabled: false,
      gfmTaskListItems: true,
      mathFlow: false,
    };

    let state: IncrementalParseState | null = null;
    let content = "";
    let incrementalFrames = 0;
    const chunks = 64;
    for (let index = 0; index < chunks; index += 1) {
      content +=
        index === 48
          ? "Shipped at 12:30:00 with :avocado: and (**:+1:**).\n\n"
          : `Log entry at 12:30 for service: worker-${index} :rocket:.\n\n`;
      const result = advanceIncrementalParse(state, content, options);
      state = result.nextState;
      if (result.usedIncremental) {
        incrementalFrames += 1;
      }
    }

    expect(incrementalFrames).toBe(chunks - 1);
    expect(parsedCharacters).toBeLessThanOrEqual(content.length * 2);
    expect(onMissingCatalog).not.toHaveBeenCalled();
  });

  it("accumulates up to two trailing characters across nested formatting children and skips empty text siblings", () => {
    const catalog = buildReactionEmojiCatalog();
    const transform = remarkEmojiShortcodes({ catalog });

    // `strong([text("a"), delete([text("(")])])` followed by `:+1:)` must NOT expand.
    const blockedTree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "strong",
              children: [
                { type: "text", value: "a" },
                { type: "delete", children: [{ type: "text", value: "(" }] },
              ],
            },
            { type: "text", value: ":+1:)" },
          ],
        },
      ],
    };
    transform(blockedTree);
    expect(blockedTree.children[0]!.children[1]!.value).toBe(":+1:)");

    // `strong([text(" "), delete([text("(")])])` followed by `:+1:)` DOES expand.
    const allowedTree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "strong",
              children: [
                { type: "text", value: " " },
                { type: "delete", children: [{ type: "text", value: "(" }] },
              ],
            },
            { type: "text", value: ":+1:)" },
          ],
        },
      ],
    };
    transform(allowedTree);
    expect(allowedTree.children[0]!.children[1]!.value).toBe("👍)");

    // Empty text siblings around formatted shortcodes do not break boundary checks.
    const emptySiblingTree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "ok " },
            { type: "text", value: "" },
            { type: "strong", children: [{ type: "text", value: ":+1:" }] },
            { type: "text", value: "" },
          ],
        },
      ],
    };
    transform(emptySiblingTree);
    expect(emptySiblingTree.children[0]!.children[2]!.children![0]!.value).toBe("👍");
  });
});
