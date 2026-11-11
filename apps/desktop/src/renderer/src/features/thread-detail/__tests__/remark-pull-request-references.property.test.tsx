import { render } from "@testing-library/react";
import fc from "fast-check";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import { remarkPullRequestReferences } from "../remark-pull-request-references";

type MdastNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
};

const PR_BASE = "https://github.com/ExampleOrg/catalog-service/pull/";

/**
 * Runs the transcript's real GFM + PR-reference pipeline and flattens the
 * first paragraph: text stays text, every link becomes `<url>`. A PR chip is
 * exactly a link the renderer turns into one, so the `<…>` tokens are the
 * chips the operator sees.
 */
function renderedTokens(text: string): string {
  let paragraph: MdastNode | undefined;
  const observe = () => (tree: MdastNode) => {
    paragraph = tree.children?.find((child) => child.type === "paragraph");
  };
  render(
    <Markdown remarkPlugins={[
      [remarkGfm, { singleTilde: false }],
      remarkPullRequestReferences,
      observe,
    ]}
    >
      {text}
    </Markdown>,
  ).unmount();
  return (paragraph?.children ?? [])
    .map((node) => node.type === "link" ? `<${node.url}>` : node.value ?? "")
    .join("");
}

const prose = fc.stringMatching(/^[a-z]+( [a-z]+){0,3}$/);
const prNumber = fc.integer({ min: 1, max: 99_999 });

describe("remarkPullRequestReferences redundant pairs", () => {
  it("renders one chip when a bare number and its own PR URL name one PR", () => {
    fc.assert(fc.property(
      prose,
      prose,
      prNumber,
      prNumber,
      fc.boolean(),
      fc.boolean(),
      (before, after, bareNumber, urlNumber, numberFirst, autolink) => {
        const url = `${PR_BASE}${urlNumber}`;
        const urlText = autolink ? url : `[PR ${urlNumber}](${url})`;
        const pair = numberFirst
          ? `#${bareNumber} (${urlText})`
          : `${urlText} (#${bareNumber})`;
        const text = `${before} ${pair}. ${after}`;

        const bareChip = `<pwragent://pull-request/${bareNumber}>`;
        const urlChip = `<${url}>`;
        const expectedPair = bareNumber !== urlNumber
          ? numberFirst
            ? `${bareChip} (${urlChip})`
            : `${urlChip} (${bareChip})`
          : urlChip;

        expect(renderedTokens(text)).toBe(`${before} ${expectedPair}. ${after}`);
      },
    ), { numRuns: 200 });
  });

  it("leaves a parenthesized number with no adjacent PR link alone", () => {
    fc.assert(fc.property(prose, prNumber, (before, number) => {
      expect(renderedTokens(`${before} (#${number}) and #${number} (soon).`))
        .toBe(
          `${before} (<pwragent://pull-request/${number}>) and `
          + `<pwragent://pull-request/${number}> (soon).`,
        );
    }));
  });

  it("collapses the exact transcript text from a Claude thread", () => {
    expect(renderedTokens(
      "I opened PR #3623 (https://github.com/pwrdrvr/PwrAgent/pull/3623). "
      + "The canonical case now takes about 670 ms.",
    )).toBe(
      "I opened PR <https://github.com/pwrdrvr/PwrAgent/pull/3623>. "
      + "The canonical case now takes about 670 ms.",
    );
  });
});
