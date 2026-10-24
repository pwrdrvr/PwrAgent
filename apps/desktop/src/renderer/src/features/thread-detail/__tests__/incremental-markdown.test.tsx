import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import ReactMarkdown from "react-markdown";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadMarkdown } from "../ThreadMarkdown";
import { advanceIncrementalParse, type AdvanceOptions, type IncrementalParseState } from "@ai-markdown/engine";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { remarkPullRequestReferences } from "../remark-pull-request-references";
import { remarkTableProfile } from "../remark-table-profile";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

vi.mock("hast-util-to-jsx-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("hast-util-to-jsx-runtime")>();
  return { ...actual, toJsxRuntime: vi.fn(actual.toJsxRuntime) };
});

const baseline = vi.hoisted(() => ({ enabled: false }));
vi.mock("../IncrementalMarkdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../IncrementalMarkdown")>();
  return {
    IncrementalMarkdown: (props: Parameters<typeof actual.IncrementalMarkdown>[0]) => {
      const { mathFlow: _mathFlow, ...markdownProps } = props;
      return baseline.enabled ? <ReactMarkdown {...markdownProps} /> : <actual.IncrementalMarkdown {...props} />;
    },
  };
});

afterEach(() => {
  cleanup();
  baseline.enabled = false;
  vi.clearAllMocks();
});

const fixtures = {
  prose: "First **complete** paragraph.\n\nSecond with `code` and #42.\n\nThird paragraph.\n\n",
  references: "[Known]: https://example.com/a\n\nFirst [known].\n\nLater [missing].\n\n[missing]: https://example.com/b\n\nLast [known].\n\n",
  containers: "Intro.\n\n3. First\n\n   - Nested\n\n     continuation\n\n   - Next\n\n> quote\n>\n> paragraph\n\nEnd.\n\n",
  tables: "Intro.\n\n| Name | Value |\n| --- | --- |\n| A | **bold** |\n| B | [link](https://example.com) |\n\nEnd.\n\n",
  fences: "Intro.\n\n```ts\n// [not a ref]\n\nconst text = '**literal**';\n```\n\nEnd.\n\n",
  html: "Intro.\n\n<div>\n\ninside\n\n</div>\n\n<script>bad()</script>\n\n[unsafe](javascript:bad)\n\nEnd.\n\n",
  footnotes: "Intro.\n\nA note[^a].\n\n[^a]: First\n\n    continuation\n\nAnother[^b].\n\n[^b]: Second\n\nEnd.\n\n",
  tasks: "Intro.\n\n- [x] first\n\n- [ ] second\n\nEnd.\n\n",
  inline: "Intro.\n\nA **strong _nested_** span and ~~strike~~, ~literal~, \\*escaped*.\n\nA [link](https://example.com/a?q=1&b=2) and ![image](https://example.com/a.png).\n\nEnd.\n\n",
  headings: "Intro.\n\nSetext\n---\n\n# ATX\n\n---\n\n    indented code\n\n    continued\n\nEnd.\n\n",
};

it.each(Object.entries(fixtures))("matches the original production renderer at streaming cuts: %s", (_name, text) => {
  const actual = render(<StrictMode><ThreadMarkdown text="" /></StrictMode>);
  const cuts = [...new Set([1, ...Array.from({ length: Math.ceil(text.length / 7) }, (_, i) => Math.min((i + 1) * 7, text.length))])];
  for (const end of cuts) {
    const content = text.slice(0, end);
    baseline.enabled = false;
    actual.rerender(<StrictMode><ThreadMarkdown text={content} /></StrictMode>);
    baseline.enabled = true;
    const expected = render(<ThreadMarkdown text={content} />);
    expect(actual.container.innerHTML, `cut ${end}`).toBe(expected.container.innerHTML);
    expected.unmount();
  }
  // A replacement or truncation must discard the old append lineage.
  for (const content of ["Replacement\n\n", "Short", text]) {
    baseline.enabled = false;
    actual.rerender(<StrictMode><ThreadMarkdown text={content} /></StrictMode>);
    baseline.enabled = true;
    const expected = render(<ThreadMarkdown text={content} />);
    expect(actual.container.innerHTML).toBe(expected.container.innerHTML);
    expected.unmount();
  }
});

it("keeps completed production block nodes mounted without rebuilding their JSX", () => {
  const paragraph = "Complete **paragraph**.\n\n";
  const actual = render(<ThreadMarkdown text={paragraph} />);
  const first = actual.container.querySelector("p");
  for (let i = 2; i <= 64; i += 1) actual.rerender(<ThreadMarkdown text={paragraph.repeat(i)} />);
  expect(actual.container.querySelector("p")).toBe(first);
  // A new paragraph and its separator may render; frozen paragraphs do not.
  expect(vi.mocked(toJsxRuntime).mock.calls.length).toBeLessThanOrEqual(128);
});

it.each([16, 32, 64])("measures source work and AST equivalence for %i appends", (chunks) => {
  let characters = 0;
  const observe = () => (_tree: unknown, file: { value: unknown }) => {
    characters += String(file.value).length;
  };
  const plugins: AdvanceOptions["remarkPlugins"] = [remarkBreaks, [remarkGfm, { singleTilde: false }], remarkPullRequestReferences, remarkTableProfile, observe];
  const options: AdvanceOptions = { remarkPlugins: plugins, rehypePlugins: [], remarkRehypeOptions: undefined, depsKey: [plugins],
    defListEnabled: false, gfmTaskListItems: true, mathFlow: false };
  let state: IncrementalParseState | null = null;
  const chunk = "A complete **paragraph** with `code`.\n\n";
  let incrementalFrames = 0;
  for (let i = 1; i <= chunks; i += 1) {
    const content = chunk.repeat(i);
    const result = advanceIncrementalParse(state, content, options);
    const measured = characters;
    const full = advanceIncrementalParse(null, content, options);
    characters = measured;
    expect(result.mdast).toEqual(full.mdast);
    expect(result.hast).toEqual(full.hast);
    state = result.nextState;
    if (result.usedIncremental) incrementalFrames += 1;
  }
  expect(incrementalFrames).toBe(chunks - 1);
  expect(characters).toBeLessThanOrEqual(chunk.length * chunks * 2);
});

it("matches full math parsing across flow-math cuts and parser configuration changes", () => {
  const prosePlugins: AdvanceOptions["remarkPlugins"] = [remarkBreaks, [remarkGfm, { singleTilde: false }], remarkTableProfile];
  const mathPlugins: AdvanceOptions["remarkPlugins"] = [[remarkMath, { singleDollarTextMath: false }], ...prosePlugins];
  const rehypePlugins: AdvanceOptions["rehypePlugins"] = [[rehypeKatex, { maxExpand: 1000, maxSize: 20, trust: false }]];
  const prose = "Intro.\n\n";
  const content = prose + String.raw`$$
\gdef\fixture{x}
$$

$$
\fixture + \frac{a}{b}
$$

End.

`;
  let state: IncrementalParseState | null = null;
  const plainOptions: AdvanceOptions = {
    remarkPlugins: prosePlugins, rehypePlugins: [], remarkRehypeOptions: undefined,
    depsKey: [prosePlugins], defListEnabled: false, gfmTaskListItems: true, mathFlow: false,
  };
  state = advanceIncrementalParse(null, prose, plainOptions).nextState;
  const options: AdvanceOptions = {
    ...plainOptions, remarkPlugins: mathPlugins, rehypePlugins, depsKey: [mathPlugins, rehypePlugins], mathFlow: true,
  };
  for (let end = prose.length; end <= content.length; end += 1) {
    const text = content.slice(0, end);
    const result = advanceIncrementalParse(state, text, options);
    const full = advanceIncrementalParse(null, text, options);
    expect(result.mdast, `cut ${end}`).toEqual(full.mdast);
    expect(result.hast, `cut ${end}`).toEqual(full.hast);
    state = result.nextState;
  }
  const disabled = advanceIncrementalParse(state, content, plainOptions);
  expect(disabled.usedIncremental).toBe(false);
  expect(disabled.hast).toEqual(advanceIncrementalParse(null, content, plainOptions).hast);
});
