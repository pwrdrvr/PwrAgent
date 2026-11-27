import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  classifyPlainFirstColumnPin,
  remarkTableProfile,
  type ColumnKind,
  type PinFirstColumnRecommendation,
} from "../remark-table-profile";

type TestNode = {
  type: string;
  value?: string;
  alt?: string;
  url?: string;
  children?: TestNode[];
  data?: { hProperties?: Record<string, unknown> };
};

function textCell(value: string): TestNode {
  return {
    type: "tableCell",
    children: value === "" ? [] : [{ type: "text", value }],
  };
}

function imageCell(alt: string, url: string): TestNode {
  return {
    type: "tableCell",
    children: [{ type: "image", alt, url }],
  };
}

function buildTable(rows: TestNode[][]): TestNode {
  return {
    type: "root",
    children: [
      {
        type: "table",
        children: rows.map((cells) => ({
          type: "tableRow",
          children: cells,
        })),
      },
    ],
  };
}

function mathCell(children: TestNode[]): TestNode {
  return {
    type: "tableCell",
    children,
  };
}

function inlineMath(value: string): TestNode {
  return {
    type: "inlineMath",
    value,
  };
}

function strongCell(value: string): TestNode {
  return {
    type: "tableCell",
    children: [{ type: "strong", children: [{ type: "text", value }] }],
  };
}

function inlineCodeCell(value: string): TestNode {
  return {
    type: "tableCell",
    children: [{ type: "inlineCode", value }],
  };
}

function profileTableMeta(rows: TestNode[][]): Record<string, unknown> | undefined {
  const tree = buildTable(rows);
  remarkTableProfile()(tree);
  const table = tree.children?.[0];
  return table?.data?.hProperties;
}

function profilePinRecommendation(rows: TestNode[][]): PinFirstColumnRecommendation {
  const value = profileTableMeta(rows)?.["data-pin-first-col"];
  return value === "auto" || value === "eligible" ? value : "none";
}

function profileTableCells(rows: TestNode[][]): Array<Array<Record<string, unknown> | undefined>> {
  const tree = buildTable(rows);
  remarkTableProfile()(tree);
  const table = tree.children?.[0];
  return (table?.children ?? []).map((row) =>
    (row.children ?? []).map((cell) => cell.data?.hProperties),
  );
}

function profileTable(rows: TestNode[][]): ColumnKind[][] {
  return profileTableCells(rows).map((row) =>
    row.map((props) => props?.["data-col-kind"] as ColumnKind),
  );
}

function profileTextTable(rows: string[][]): ColumnKind[] {
  return profileTable(rows.map((row) => row.map(textCell)))[0] ?? [];
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

const shortTagArb = fc.constantFrom("", "✓", "✗", "P1", "P2", "P3", "#", "1", "OK");
const shortLabelArb = fc.constantFrom("Found", "Missed", "Billing", "Shadow", "`6/6` ref");
const longHeaderArb = fc.oneof(
  fc.stringMatching(/^[A-Za-z0-9]{41,65}$/),
  fc.array(fc.stringMatching(/^[A-Za-z]{3,8}$/), { minLength: 5, maxLength: 9 })
    .map((words) => words.join(" ")),
);
const cjkLongCellArb = fc.string({
  unit: fc.constantFrom("日", "本", "語", "表", "見", "出", "し"),
  minLength: 21,
  maxLength: 38,
});

describe("remarkTableProfile properties", () => {
  it("never classifies a column with a prose-sized header as tag or label", () => {
    fc.assert(
      fc.property(
        longHeaderArb,
        fc.array(fc.oneof(shortTagArb, shortLabelArb), { minLength: 0, maxLength: 6 }),
        (header, body) => {
          const kinds = profileTextTable([[header], ...body.map((cell) => [cell])]);
          expect(kinds[0]).toBe("prose");
        },
      ),
    );
  });

  it("never lets a shorter multi-word cell be masked by a longer single-word cell", () => {
    const multiWordArb = fc
      .array(fc.stringMatching(/^[a-z]{1,3}$/), { minLength: 5, maxLength: 8 })
      .map((words) => words.join(" "));
    fc.assert(
      fc.property(
        multiWordArb,
        fc.integer({ min: 1, max: 12 }),
        (multiWord, extraLen) => {
          const singleWord = "x".repeat(Math.min(40, multiWord.length + extraLen));
          fc.pre(singleWord.length > multiWord.length && singleWord.length <= 40);
          fc.pre(countWords(multiWord) > 4);
          const kinds = profileTextTable([["Col"], [multiWord], [singleWord]]);
          expect(kinds[0]).toBe("prose");
        },
      ),
    );
  });

  it("classifies fullwidth CJK cells exceeding 40 visual columns as prose even when length <= 40", () => {
    fc.assert(
      fc.property(cjkLongCellArb, (cjkText) => {
        expect(cjkText.length).toBeLessThanOrEqual(40);
        const kinds = profileTextTable([["Col"], [cjkText]]);
        expect(kinds[0]).toBe("prose");
      }),
    );
  });

  it("stamps every row in a column with the same kind, including ragged rows", () => {
    const cellArb = fc.oneof(shortTagArb, shortLabelArb, longHeaderArb, cjkLongCellArb);
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }).chain((cols) =>
          fc.array(
            fc.array(cellArb, { minLength: 1, maxLength: cols }),
            { minLength: 1, maxLength: 6 },
          ),
        ),
        (rows) => {
          const matrix = profileTable(rows.map((row) => row.map(textCell)));
          const columnCount = Math.max(...rows.map((row) => row.length));
          for (let col = 0; col < columnCount; col++) {
            const seen = new Set(
              matrix.map((row) => row[col]).filter((kind) => kind !== undefined),
            );
            expect(seen.size).toBe(1);
          }
        },
      ),
    );
  });
  it("marks formula-only cells with data-cell-math=only and never marks mixed prose+math or non-math cells", () => {
    const mathExprArb = fc.constantFrom(
      "n",
      "O(n \\log n)",
      "p < 0.05",
      "\\sum_{i=1}^{n} \\frac{a_i x_i + b_i y_i}{\\sqrt{c_i^2 + d_i^2}}",
    );
    const whitespaceArb = fc.constantFrom("", " ", "  ", "\t");
    const wrapperArb = fc.constantFrom<"none" | "strong" | "emphasis" | "delete">(
      "none",
      "strong",
      "emphasis",
      "delete",
    );
    const proseTokenArb = fc.stringMatching(/^[A-Za-z0-9.,;:()_-]{1,18}$/);

    const wrapNode = (
      wrapper: "none" | "strong" | "emphasis" | "delete",
      node: TestNode,
    ): TestNode =>
      wrapper === "none" ? node : { type: wrapper, children: [node] };

    fc.assert(
      fc.property(
        mathExprArb,
        whitespaceArb,
        whitespaceArb,
        wrapperArb,
        proseTokenArb,
        fc.boolean(),
        (expr, leadSpace, trailSpace, wrapper, proseToken, proseBefore) => {
          const mathNode = wrapNode(wrapper, inlineMath(expr));
          const formulaOnlyChildren: TestNode[] = [];
          if (leadSpace) formulaOnlyChildren.push({ type: "text", value: leadSpace });
          formulaOnlyChildren.push(mathNode);
          if (trailSpace) formulaOnlyChildren.push({ type: "text", value: trailSpace });

          const mixedChildren: TestNode[] = proseBefore
            ? [{ type: "text", value: `${proseToken} ` }, mathNode]
            : [mathNode, { type: "text", value: ` ${proseToken}` }];

          const plainChildren: TestNode[] = [{ type: "text", value: proseToken }];

          const props = profileTableCells([
            [textCell("Formula"), textCell("Mixed"), textCell("Plain")],
            [
              mathCell(formulaOnlyChildren),
              mathCell(mixedChildren),
              mathCell(plainChildren),
            ],
          ]);

          expect(props[1]?.[0]?.["data-cell-math"]).toBe("only");
          expect(props[1]?.[1]?.["data-cell-math"]).toBeUndefined();
          expect(props[1]?.[2]?.["data-cell-math"]).toBeUndefined();
        },
      ),
    );
  });
});

describe("remarkTableProfile regression counterexamples", () => {
  it("does not mark mixed prose+inline-math cells as math-only while marking standalone formula cells", () => {
    const props = profileTableCells([
      [textCell("Metric"), textCell("Formula"), textCell("Notes")],
      [
        textCell("Complexity"),
        mathCell([
          inlineMath(
            "\\sum_{i=1}^{n} \\frac{a_i x_i + b_i y_i}{\\sqrt{c_i^2 + d_i^2}} = \\int_0^\\infty e^{-t^2}\\,dt",
          ),
        ]),
        mathCell([
          { type: "text", value: "This algorithm achieves " },
          inlineMath("O(n \\log n)"),
          { type: "text", value: " worst-case time across balanced trees." },
        ]),
      ],
    ]);

    expect(props[1]?.[0]?.["data-cell-math"]).toBeUndefined();
    expect(props[1]?.[1]?.["data-cell-math"]).toBe("only");
    expect(props[1]?.[2]?.["data-col-kind"]).toBe("prose");
    expect(props[1]?.[2]?.["data-cell-math"]).toBeUndefined();
  });
  it("promotes short body columns to prose when the column header is long or multi-word", () => {
    const kinds = profileTextTable([
      [
        "Historical Codex Built-in Review (Ref)",
        "Pre-#4459 #4445 (v2) — PwrAgent / Codex (6:21, 5.25M tok, $1.06)",
        "Severity Classification for Production Rollout",
      ],
      ["Found", "Missed", "P1"],
      ["6/6 ref", "Found", "P2"],
    ]);

    expect(kinds).toEqual(["prose", "prose", "prose"]);
  });

  it("keeps compact single-word headers over tag values as tag, and promotes multi-word headers to label", () => {
    const kinds = profileTextTable([
      ["Severity", "Build Status", "Note"],
      ["P0", "✓", "Detailed explanation spanning multiple words in a prose column"],
      ["P1", "✗", "Another prose description"],
    ]);

    expect(kinds).toEqual(["tag", "label", "prose"]);
  });

  it("treats a multi-word short cell as prose even alongside a longer single-word label", () => {
    const kinds = profileTextTable([
      ["Summary"],
      ["a b c d e f g h i j"],
      ["abcdefghijklmnopqrstuvwxyz"],
    ]);

    expect(kinds).toEqual(["prose"]);
  });

  it("uses visual column width so wide CJK strings become prose and ZWJ emoji stay tag", () => {
    const kinds = profileTextTable([
      ["OK", "Label"],
      ["👨‍👩‍👧‍👦", "日本語のとても長いテーブルヘッダーとセル内容の折り返しテスト確認用文字列"],
    ]);

    expect(kinds).toEqual(["tag", "prose"]);
  });

  it("measures image alt/url text instead of treating image cells as empty tags", () => {
    const matrix = profileTable([
      [textCell("Preview")],
      [imageCell("Architecture diagram showing service boundaries", "https://example.com/diagram.png")],
    ]);

    expect(matrix[0]).toEqual(["prose"]);
    expect(matrix[1]).toEqual(["prose"]);
  });
});

describe("first-column pin heuristic properties", () => {
  function boldRowTitleMatrix(cols: number, titles: readonly string[]): TestNode[][] {
    const header = [
      textCell("Capability"),
      ...Array.from({ length: cols - 1 }, (_, index) => textCell(`System ${index}`)),
    ];
    const body = titles.map((title, rowIndex) => [
      strongCell(title),
      ...Array.from({ length: cols - 1 }, (_, colIndex) =>
        textCell(`Detailed explanation for row ${rowIndex} col ${colIndex}`),
      ),
    ]);
    return [header, ...body];
  }

  it("never recommends pinning tables with fewer than 3 columns or fewer than 2 data rows", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 0, max: 5 }),
        (cols, dataRowCount) => {
          fc.pre(cols < 3 || dataRowCount < 2);
          const header = Array.from({ length: cols }, (_, index) => textCell(`Col ${index}`));
          const body = Array.from({ length: dataRowCount }, (_, rowIndex) =>
            Array.from({ length: cols }, (_, colIndex) =>
              colIndex === 0 ? strongCell(`Row Title ${rowIndex}`) : textCell(`Value ${rowIndex}-${colIndex}`),
            ),
          );
          expect(profilePinRecommendation([header, ...body])).toBe("none");
        },
      ),
    );
  });

  it("auto-pins compact bold row-title first columns across 3+ column comparison matrices", () => {
    const titleArb = fc
      .array(fc.stringMatching(/^[A-Za-z][A-Za-z0-9/&-]{1,9}$/), {
        minLength: 2,
        maxLength: 7,
      })
      .map((words) => words.join(" "))
      .filter((title) => title.length <= 60);

    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 6 }),
        fc.uniqueArray(titleArb, {
          minLength: 2,
          maxLength: 8,
          selector: (title) => title.toLowerCase(),
        }),
        (cols, titles) => {
          // These ASCII titles are one display column per character. Auto-pinning
          // requires an average width of at most 54 columns across the titles.
          const totalTitleWidth = titles.reduce((total, title) => total + title.length, 0);
          fc.pre(totalTitleWidth <= 54 * titles.length);
          expect(profilePinRecommendation(boldRowTitleMatrix(cols, titles))).toBe("auto");
        },
      ),
    );
  });

  it("auto-pins bold row titles averaging exactly 54 display columns", () => {
    // The titles are 55 and 53 columns wide, so only their average is at the limit.
    const matrix = boldRowTitleMatrix(3, [
      "Managed gateway configuration for external tool servers",
      "Dynamic tool discovery with a configurable schema cap",
    ]);
    expect(profilePinRecommendation(matrix)).toBe("auto");
  });

  it("offers manual pinning when bold row titles average over 54 characters", () => {
    const matrix = boldRowTitleMatrix(3, [
      "a&AA Aa-&/-&A& Aaa0a0&-a AaA/A/-a-A A000&a&a a-&&-a& a0a",
      "Aaa&a00a A/&-aA A--/---Aa aa0a-A-0-- A/AA/// a/& aa-0",
    ]);
    expect(profilePinRecommendation(matrix)).toBe("eligible");
  });

  it("never auto-pins repetitive status columns or purely numeric index columns", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 6 }),
        fc.integer({ min: 4, max: 10 }),
        (cols, rowCount) => {
          const header = Array.from({ length: cols }, (_, index) => textCell(`Col ${index}`));
          const repetitiveBody = Array.from({ length: rowCount }, (_, rowIndex) => [
            strongCell(rowIndex % 2 === 0 ? "Yes" : "No"),
            ...Array.from({ length: cols - 1 }, (_, colIndex) =>
              textCell(`Value ${rowIndex}-${colIndex}`),
            ),
          ]);
          expect(profilePinRecommendation([header, ...repetitiveBody])).toBe("eligible");

          const numericBody = Array.from({ length: rowCount }, (_, rowIndex) => [
            textCell(String(rowIndex + 1)),
            ...Array.from({ length: cols - 1 }, (_, colIndex) =>
              textCell(`Value ${rowIndex}-${colIndex}`),
            ),
          ]);
          expect(profilePinRecommendation([header, ...numericBody])).toBe("eligible");
        },
      ),
    );
  });

  it("auto-pins distinct inline-code key columns and never auto-pins multi-sentence prose columns", () => {
    const codeKeyTable = [
      [textCell("Setting"), textCell("Default"), textCell("Notes")],
      [inlineCodeCell("general.theme"), textCell("tangerine"), textCell("Active theme token set")],
      [inlineCodeCell("general.density"), textCell("compact"), textCell("Row height preset")],
      [inlineCodeCell("general.motion"), textCell("standard"), textCell("Animation preference")],
    ];
    expect(profilePinRecommendation(codeKeyTable)).toBe("auto");

    const proseFirstColTable = [
      [textCell("Description"), textCell("Owner"), textCell("Status")],
      [
        textCell(
          "This first sentence describes a complicated migration step in detail. This second sentence explains why rolling it back requires manual database recovery.",
        ),
        textCell("Platform"),
        textCell("Open"),
      ],
      [
        textCell(
          "Another very long multi-sentence explanation that spans well past a reasonable row title width. It definitely should stay scrollable instead of pinning.",
        ),
        textCell("Desktop"),
        textCell("Done"),
      ],
    ];
    expect(profilePinRecommendation(proseFirstColTable)).toBe("eligible");
  });

  it("matches the MCP Gateway Comparison Matrix regression fixture with 45-char bold row titles", () => {
    const matrix = [
      [textCell("Capability"), textCell("PwrAgent"), textCell("t3code"), textCell("orca"), textCell("bb")],
      [strongCell("Managed External MCP Gateway / Broker"), textCell("Full broker"), textCell("None"), textCell("Relay"), textCell("None")],
      [strongCell("Transports Supported"), textCell("Streamable HTTP, Stdio"), textCell("HTTP"), textCell("Stdio"), textCell("HTTP")],
      [strongCell("Dynamic / Lazy Tool Discovery & Schema Budget"), textCell("search_mcp_tools"), textCell("tool_search"), textCell("Full"), textCell("None")],
      [strongCell("External \"Use App as MCP Server\""), textCell("Loopback"), textCell("Yes"), textCell("No"), textCell("No")],
    ];
    const meta = profileTableMeta(matrix);
    expect(meta?.["data-pin-first-col"]).toBe("auto");
    expect(meta?.["data-table-cols"]).toBe("5");
    expect(meta?.["data-table-rows"]).toBe("4");
  });

  it("classifies plain CSV/TSV first columns consistently", () => {
    expect(classifyPlainFirstColumnPin(["us-east-1", "us-west-2", "eu-west-1"], 4, false)).toBe("auto");
    expect(classifyPlainFirstColumnPin(["1", "2", "3"], 4, true)).toBe("eligible");
    expect(classifyPlainFirstColumnPin(["ok", "ok", "ok"], 4, false)).toBe("eligible");
    expect(classifyPlainFirstColumnPin(["only-one"], 4, false)).toBe("none");
    expect(classifyPlainFirstColumnPin(["a", "b"], 2, false)).toBe("none");
  });
});
