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
  // A `#` first column is common in review tables; it must stay the header.
  it("renders same-count pipe lines between prose as one table of those rows", () => {
    fc.assert(fc.property(prose, pipeRows, prose, fc.boolean(), (before, generated, after, hashColumn) => {
      const { outerPipe } = generated;
      const rows = hashColumn
        ? [["#", ...(generated.rows[0] ?? []).slice(1)], ...generated.rows.slice(1)]
        : generated.rows;
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

  // The delimiter row is ours, not the author's, so it must never reach the
  // reader as text. Under a list item an unindented delimiter is a lazy line,
  // which GFM won't start a table from.
  it("never shows an inserted delimiter row as text, in or out of a list item", () => {
    fc.assert(fc.property(
      fc.boolean(),
      pipeRows,
      fc.array(fc.constantFrom("", "  ", "   "), { minLength: 8, maxLength: 8 }),
      fc.boolean(),
      (inList, { rows, outerPipe }, indents, uniform) => {
        const lines = rows.map((row, index) =>
          `${uniform ? indents[0] : indents[index]}${pipeLine(row, outerPipe)}`
        );
        const html = render(inferPipeTables([inList ? "- Results:" : "Results:", ...lines].join("\n")));

        expect(html).not.toContain("---");
        if (uniform) {
          expect(html).toContain("<table>");
        }
      },
    ));
  });

  // Inference reads prose, never code: whatever sits around a code block, the
  // block renders exactly as the author wrote it.
  it("never changes what a code block contains", () => {
    const pipeRun = fc.array(fc.array(cell, { minLength: 3, maxLength: 3 }), { minLength: 3, maxLength: 4 })
      .map((rows) => rows.map((row) => row.join(" | ")).join("\n"));
    const fencedBlock = fc.tuple(
      fc.constantFrom("```", "```sh", "~~~"),
      fc.array(fc.oneof(fc.constant(""), prose, pipeRun), { minLength: 1, maxLength: 4 }),
    ).map(([open, body]) => [open, ...body, open.startsWith("~") ? "~~~" : "```"].join("\n"));
    const realTable = fc.array(fc.array(cell, { minLength: 2, maxLength: 2 }), { minLength: 1, maxLength: 3 })
      .map(([header = [], ...rows]) =>
        [header, ["---", "---"], ...rows].map((row) => pipeLine(row, true)).join("\n")
      );
    // Inline code at the start of a line, which is not a fence opener.
    const inlineTripleBacktick = cell.map((value) => `\`\`\`${value}\`\`\` passed.`);
    // A fence that opens on the line after a table's last row ends the table;
    // a blank line inside the fence must not end the fence.
    const tableThenFence = fc.tuple(realTable, fc.constantFrom("```", "~~~"), pipeRun).map(
      ([table, open, rows]) => [table, open, "", rows, open].join("\n"),
    );
    const codeDocument = fc.array(
      fc.oneof(fencedBlock, realTable, inlineTripleBacktick, prose, pipeRun, tableThenFence),
      { minLength: 2, maxLength: 6 },
    ).chain((blocks) =>
      fc.array(fc.constantFrom("\n", "\n\n"), {
        minLength: blocks.length - 1,
        maxLength: blocks.length - 1,
      }).map((separators) =>
        blocks.reduce((document, block, index) =>
          index === 0 ? block : `${document}${separators[index - 1]}${block}`, "")
      ),
    );
    const codeBlocks = (html: string): string[] =>
      [...html.matchAll(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map((match) => match[1] ?? "");

    fc.assert(fc.property(codeDocument, (markdown) => {
      expect(codeBlocks(render(inferPipeTables(markdown)))).toEqual(codeBlocks(render(markdown)));
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
