import fc from "fast-check";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import { inferPipeTables } from "../markdown-pipe-tables";

// The oracle is the transcript's own parser configuration: whatever GFM
// renders after inference is what the operator sees.
function render(markdown: string): string {
  return renderToStaticMarkup(createElement(ReactMarkdown, {
    children: markdown,
    remarkPlugins: [remarkBreaks, [remarkGfm, { singleTilde: false }]],
  }));
}

function tableCells(html: string, tag: "th" | "td"): string[] {
  return [...html.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>(.*?)</${tag}>`, "g"))]
    .map((match) => match[1] ?? "");
}

// Cells start with a letter or digit and never hold a dot, so a first cell
// can't read as an ordered-list marker (`1.`), which is left alone on purpose.
const cell = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9,→/]{0,8}$/);
const prose = fc.stringMatching(/^[A-Z][a-z ]{2,30}[a-z:]$/);

const pipeRows = fc.integer({ min: 2, max: 6 }).chain((columns) =>
  fc.record({
    rows: fc.array(fc.array(cell, { minLength: columns, maxLength: columns }), {
      minLength: 3,
      maxLength: 8,
    }),
    // Two columns count only with an outer pipe; see the module comment.
    outerPipe: columns < 3 ? fc.constant(true) : fc.boolean(),
  }),
);

function pipeLine(cells: string[], outerPipe: boolean): string {
  const body = cells.join(" | ");
  return outerPipe ? `| ${body} |` : body;
}

// Blocks that hold pipes but give inference nothing to do: fenced pipe
// lines, real GFM tables, and pipe runs too short or too narrow to count.
const inertBlock = fc.oneof(
  prose,
  fc.array(fc.array(cell, { minLength: 3, maxLength: 3 }), { minLength: 1, maxLength: 5 })
    .map((rows) => ["```", ...rows.map((row) => row.join(" | ")), "```"].join("\n")),
  fc.array(fc.array(cell, { minLength: 3, maxLength: 3 }), { minLength: 1, maxLength: 4 })
    .map(([header = [], ...rows]) =>
      [header, ["---", "---", "---"], ...rows].map((row) => pipeLine(row, true)).join("\n")
    ),
  fc.array(fc.array(cell, { minLength: 4, maxLength: 4 }), { minLength: 1, maxLength: 2 })
    .map((rows) => rows.map((row) => row.join(" | ")).join("\n")),
  fc.array(fc.array(cell, { minLength: 2, maxLength: 2 }), { minLength: 3, maxLength: 6 })
    .map((rows) => rows.map((row) => row.join(" | ")).join("\n")),
);

const mixedDocument = fc.array(
  fc.oneof(inertBlock, pipeRows.map(({ rows, outerPipe }) =>
    rows.map((row) => pipeLine(row, outerPipe)).join("\n")
  )),
  { minLength: 1, maxLength: 6 },
).chain((blocks) =>
  fc.array(fc.constantFrom("\n", "\n\n"), {
    minLength: blocks.length - 1,
    maxLength: blocks.length - 1,
  }).map((separators) =>
    blocks.reduce((document, block, index) =>
      index === 0 ? block : `${document}${separators[index - 1]}${block}`, "")
  ),
);

describe("inferPipeTables", () => {
  // Three or more lines with the same cell count are a table the author
  // wrote without GFM's delimiter row. The prose around them stays prose.
  it("renders same-count pipe lines between prose as one table of those rows", () => {
    fc.assert(fc.property(prose, pipeRows, prose, (before, { rows, outerPipe }, after) => {
      const markdown = [before, ...rows.map((row) => pipeLine(row, outerPipe)), after].join("\n");
      const html = render(inferPipeTables(markdown));

      expect(html.match(/<table>/g) ?? []).toHaveLength(1);
      expect(tableCells(html, "th")).toEqual(rows[0]);
      expect(tableCells(html, "td")).toEqual(rows.slice(1).flat());
      const [beforeTable = "", afterTable = ""] = html.split(/<table>[\s\S]*<\/table>/);
      expect(beforeTable).toContain(before);
      expect(afterTable).toContain(after);
    }));
  });

  it("changes nothing when no run qualifies", () => {
    fc.assert(fc.property(
      fc.array(inertBlock, { minLength: 1, maxLength: 6 }),
      (blocks) => {
        // Blank lines keep neighbouring short runs from joining into one.
        const markdown = blocks.join("\n\n");
        expect(inferPipeTables(markdown)).toBe(markdown);
      },
    ));
  });

  it("only inserts delimiter rows and blank lines, and is idempotent", () => {
    fc.assert(fc.property(mixedDocument, (markdown) => {
      const inferred = inferPipeTables(markdown);
      expect(inferPipeTables(inferred)).toBe(inferred);

      const original = markdown.split("\n");
      let next = 0;
      for (const line of inferred.split("\n")) {
        if (line === original[next]) {
          next += 1;
          continue;
        }
        expect(line).toMatch(/^(?:|\| ---(?: \| ---)+ \|)$/);
      }
      expect(next).toBe(original.length);
    }));
  });

  it("keeps a pipe inside a code span from counting as a cell boundary", () => {
    const markdown = [
      "name | `a|b` | note",
      "one | `c|d` | two",
      "three | `e|f` | four",
    ].join("\n");
    expect(inferPipeTables(markdown)).toBe(markdown);
  });

  it("leaves a real table's body rows alone", () => {
    const markdown = [
      "Intro",
      "| a | b | c |",
      "| --- | --- | --- |",
      "| 1 | 2 | 3 |",
      "| 4 | 5 | 6 |",
      "| 7 | 8 | 9 |",
    ].join("\n");
    expect(inferPipeTables(markdown)).toBe(markdown);
  });
});
