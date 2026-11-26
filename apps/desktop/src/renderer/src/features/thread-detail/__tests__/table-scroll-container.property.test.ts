import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeHorizontalScrollEdges } from "../TableScrollContainer";
import {
  computePinnedFirstColumnState,
  computeStickyHeaderState,
  extractTableTitleFromMarkdown,
  matchesTableRowFilter,
  normalizeExtractedTableMarkdown,
  serializeTableCellsToCsv,
} from "../table-sticky-model";

// Simple RFC 4180 CSV parser oracle used to verify lossless round-tripping.
function parseCsvOracle(input: string): string[][] {
  if (input === "") {
    return [];
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let index = 0;

  while (index < input.length) {
    const ch = input[index]!;
    if (inQuotes) {
      if (ch === "\"") {
        if (input[index + 1] === "\"") {
          cell += "\"";
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      cell += ch;
      index += 1;
      continue;
    }

    if (ch === "\"" && cell === "") {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      index += 1;
      continue;
    }
    if (ch === "\r" && input[index + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      index += 2;
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      index += 1;
      continue;
    }
    cell += ch;
    index += 1;
  }

  row.push(cell);
  rows.push(row);
  return rows;
}

describe("computeHorizontalScrollEdges properties", () => {
  it("never shows edge fades when content fits within the 1px sub-pixel tolerance", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000 }),
        fc.integer({ min: -50, max: 1 }),
        fc.integer({ min: 0, max: 200 }),
        (clientWidth, extra, scrollLeft) => {
          const scrollWidth = Math.max(0, clientWidth + extra);
          expect(
            computeHorizontalScrollEdges({ clientWidth, scrollLeft, scrollWidth }),
          ).toEqual({ left: false, right: false });
        },
      ),
    );
  });

  it("tracks left and right overflow monotonically across the full scroll range", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1_600 }),
        fc.integer({ min: 2, max: 2_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (clientWidth, overflow, fracA, fracB) => {
          const scrollWidth = clientWidth + overflow;
          const low = Math.min(fracA, fracB) * overflow;
          const high = Math.max(fracA, fracB) * overflow;

          const startEdges = computeHorizontalScrollEdges({
            clientWidth,
            scrollLeft: 0,
            scrollWidth,
          });
          expect(startEdges).toEqual({ left: false, right: true });

          const endEdges = computeHorizontalScrollEdges({
            clientWidth,
            scrollLeft: overflow,
            scrollWidth,
          });
          expect(endEdges).toEqual({ left: true, right: false });

          const lowEdges = computeHorizontalScrollEdges({
            clientWidth,
            scrollLeft: low,
            scrollWidth,
          });
          const highEdges = computeHorizontalScrollEdges({
            clientWidth,
            scrollLeft: high,
            scrollWidth,
          });
          if (lowEdges.left) {
            expect(highEdges.left).toBe(true);
          }
          if (!lowEdges.right) {
            expect(highEdges.right).toBe(false);
          }
        },
      ),
    );
  });

  it("handles macOS rubber-band overscroll and non-finite layout metrics without flipping edges", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 1_600 }),
        fc.integer({ min: 10, max: 1_200 }),
        fc.integer({ min: 1, max: 200 }),
        (clientWidth, overflow, overshoot) => {
          const scrollWidth = clientWidth + overflow;
          expect(
            computeHorizontalScrollEdges({
              clientWidth,
              scrollLeft: -overshoot,
              scrollWidth,
            }),
          ).toEqual({ left: false, right: true });
          expect(
            computeHorizontalScrollEdges({
              clientWidth,
              scrollLeft: overflow + overshoot,
              scrollWidth,
            }),
          ).toEqual({ left: true, right: false });
        },
      ),
    );

    expect(
      computeHorizontalScrollEdges({
        clientWidth: Number.NaN,
        scrollLeft: 0,
        scrollWidth: 400,
      }),
    ).toEqual({ left: false, right: false });
  });
});

describe("computeStickyHeaderState properties and stateful scroll model", () => {
  it("always keeps sticky header offset strictly inside the table bounds and clears when off-screen", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 120, max: 1_400 }),
        fc.integer({ min: -2_000, max: 2_000 }),
        fc.integer({ min: 20, max: 2_500 }),
        fc.integer({ min: 16, max: 400 }),
        fc.integer({ min: 0, max: 120 }),
        (viewportTop, viewportHeight, tableTop, tableHeight, headerHeight, stickyTopInset) => {
          const viewportBottom = viewportTop + viewportHeight;
          const tableBottom = tableTop + tableHeight;
          const state = computeStickyHeaderState({
            headerHeight,
            stickyTopInset,
            tableBottom,
            tableTop,
            viewportBottom,
            viewportTop,
          });

          expect(Number.isFinite(state.offsetY)).toBe(true);
          expect(state.offsetY).toBeGreaterThanOrEqual(0);
          if (!state.active) {
            expect(state.offsetY).toBe(0);
          } else {
            expect(state.offsetY).toBeGreaterThan(0);
            expect(state.offsetY + headerHeight).toBeLessThanOrEqual(tableHeight);
            const effectiveViewportTop = viewportTop + stickyTopInset;
            expect(tableTop).toBeLessThan(effectiveViewportTop);
            expect(tableBottom).toBeGreaterThan(effectiveViewportTop);
            expect(headerHeight).toBeLessThan((viewportBottom - effectiveViewportTop) * 0.5);
          }
        },
      ),
    );
  });

  it("tracks monotonic sticky offset across arbitrary scroll, resize, inset, and table growth command sequences", () => {
    type ScrollWorld = {
      headerHeight: number;
      scrollTop: number;
      stickyTopInset: number;
      tableHeight: number;
      tableOffsetInDoc: number;
      viewportHeight: number;
      viewportTop: number;
    };

    type ScrollCmd = fc.Command<ScrollWorld, ScrollWorld>;

    const checkWorldInvariants = (world: ScrollWorld): void => {
      const tableTop = world.viewportTop + world.tableOffsetInDoc - world.scrollTop;
      const tableBottom = tableTop + world.tableHeight;
      const viewportBottom = world.viewportTop + world.viewportHeight;
      const state = computeStickyHeaderState({
        headerHeight: world.headerHeight,
        stickyTopInset: world.stickyTopInset,
        tableBottom,
        tableTop,
        viewportBottom,
        viewportTop: world.viewportTop,
      });

      const effectiveTop = world.viewportTop + world.stickyTopInset;
      const availableHeight = viewportBottom - effectiveTop;
      const canEverStick =
        availableHeight > 0
        && world.headerHeight > 0
        && world.headerHeight < availableHeight * 0.5
        && world.tableHeight - world.headerHeight > 1;

      if (!canEverStick) {
        expect(state).toEqual({ active: false, offsetY: 0 });
        return;
      }

      if (tableTop >= effectiveTop || tableBottom <= effectiveTop) {
        expect(state).toEqual({ active: false, offsetY: 0 });
        return;
      }

      const expectedRaw = Math.min(
        effectiveTop - tableTop,
        world.tableHeight - world.headerHeight,
      );
      if (expectedRaw <= 0.5) {
        expect(state).toEqual({ active: false, offsetY: 0 });
      } else {
        expect(state.active).toBe(true);
        // Header stays inside the table and within 0.5px of the ideal stick point.
        expect(state.offsetY + world.headerHeight).toBeLessThanOrEqual(world.tableHeight);
        expect(Math.abs(state.offsetY - expectedRaw)).toBeLessThanOrEqual(0.5);
      }
    };

    const scrollToCmd = (targetScrollTop: number): ScrollCmd => ({
      check: () => true,
      run: (model) => {
        model.scrollTop = targetScrollTop;
        checkWorldInvariants(model);
      },
      toString: () => `scrollTo(${targetScrollTop})`,
    });

    const scrollByCmd = (delta: number): ScrollCmd => ({
      check: () => true,
      run: (model) => {
        const previousTop = model.viewportTop + model.tableOffsetInDoc - model.scrollTop;
        const previousState = computeStickyHeaderState({
          headerHeight: model.headerHeight,
          stickyTopInset: model.stickyTopInset,
          tableBottom: previousTop + model.tableHeight,
          tableTop: previousTop,
          viewportBottom: model.viewportTop + model.viewportHeight,
          viewportTop: model.viewportTop,
        });

        model.scrollTop = Math.max(0, model.scrollTop + delta);
        const nextTop = model.viewportTop + model.tableOffsetInDoc - model.scrollTop;
        const nextState = computeStickyHeaderState({
          headerHeight: model.headerHeight,
          stickyTopInset: model.stickyTopInset,
          tableBottom: nextTop + model.tableHeight,
          tableTop: nextTop,
          viewportBottom: model.viewportTop + model.viewportHeight,
          viewportTop: model.viewportTop,
        });

        // While scrolling down inside the same table, offset never jumps backward.
        if (delta > 0 && previousState.active && nextState.active) {
          expect(nextState.offsetY).toBeGreaterThanOrEqual(previousState.offsetY);
        }
        checkWorldInvariants(model);
      },
      toString: () => `scrollBy(${delta})`,
    });

    const resizeViewportCmd = (nextHeight: number): ScrollCmd => ({
      check: () => true,
      run: (model) => {
        model.viewportHeight = nextHeight;
        checkWorldInvariants(model);
      },
      toString: () => `resizeViewport(${nextHeight})`,
    });

    const growTableCmd = (extraRowsHeight: number): ScrollCmd => ({
      check: () => true,
      run: (model) => {
        model.tableHeight = Math.max(24, model.tableHeight + extraRowsHeight);
        checkWorldInvariants(model);
      },
      toString: () => `growTable(${extraRowsHeight})`,
    });

    const setInsetCmd = (inset: number): ScrollCmd => ({
      check: () => true,
      run: (model) => {
        model.stickyTopInset = inset;
        checkWorldInvariants(model);
      },
      toString: () => `setInset(${inset})`,
    });

    const commandArb = fc.commands(
      [
        fc.integer({ min: 0, max: 3_000 }).map(scrollToCmd),
        fc.integer({ min: -500, max: 500 }).map(scrollByCmd),
        fc.integer({ min: 80, max: 1_200 }).map(resizeViewportCmd),
        fc.integer({ min: -200, max: 400 }).map(growTableCmd),
        fc.constantFrom(0, 28, 56, 84).map(setInsetCmd),
      ],
      { maxCommands: 30, size: "max" },
    );

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 120 }),
        fc.integer({ min: 200, max: 1_000 }),
        fc.integer({ min: 0, max: 1_200 }),
        fc.integer({ min: 80, max: 1_800 }),
        fc.integer({ min: 28, max: 120 }),
        commandArb,
        (viewportTop, viewportHeight, tableOffsetInDoc, tableHeight, headerHeight, commands) => {
          const initial: ScrollWorld = {
            headerHeight,
            scrollTop: 0,
            stickyTopInset: 0,
            tableHeight,
            tableOffsetInDoc,
            viewportHeight,
            viewportTop,
          };
          fc.modelRun(() => ({ model: initial, real: initial }), commands);
        },
      ),
    );
  });

  it("handles non-finite sticky metrics safely without activating", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(
        computeStickyHeaderState({
          headerHeight: 36,
          tableBottom: 600,
          tableTop: bad,
          viewportBottom: 800,
          viewportTop: 0,
        }),
      ).toEqual({ active: false, offsetY: 0 });
    }
  });
});

describe("computePinnedFirstColumnState properties and stateful pin model", () => {
  it("never pins when table fits, when ineligible, when user unpinned, or when remaining viewport < 120px", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 0, max: 1_600 }),
        fc.integer({ min: -40, max: 2_000 }),
        fc.integer({ min: -100, max: 1_600 }),
        fc.integer({ min: 0, max: 900 }),
        (desiredPinned, eligible, clientWidth, overflow, scrollLeft, firstColumnWidth) => {
          const scrollWidth = Math.max(0, clientWidth + overflow);
          const state = computePinnedFirstColumnState({
            clientWidth,
            desiredPinned,
            eligible,
            firstColumnWidth,
            scrollLeft,
            scrollWidth,
          });

          if (!desiredPinned || !eligible || overflow <= 1 || clientWidth <= 0 || firstColumnWidth <= 0) {
            expect(state).toEqual({ active: false, pinnedWidthPx: 0, scrolledUnder: false });
            return;
          }

          if (state.active) {
            expect(clientWidth - firstColumnWidth).toBeGreaterThanOrEqual(120);
            expect(state.pinnedWidthPx).toBe(Math.round(firstColumnWidth));
            expect(state.scrolledUnder).toBe(scrollLeft > 1);
          } else {
            expect(state.scrolledUnder).toBe(false);
            expect(state.pinnedWidthPx).toBe(0);
          }
        },
      ),
    );
  });

  it("maintains coherent 2D pin + horizontal-edge + sticky-header invariants across arbitrary user interaction sequences", () => {
    type Table2DWorld = {
      clientWidth: number;
      desiredPinned: boolean;
      eligible: boolean;
      firstColumnWidth: number;
      headerHeight: number;
      scrollLeft: number;
      scrollTop: number;
      scrollWidth: number;
      tableHeight: number;
      tableOffsetInDoc: number;
      viewportHeight: number;
    };

    const verify = (world: Table2DWorld): void => {
      const edges = computeHorizontalScrollEdges({
        clientWidth: world.clientWidth,
        scrollLeft: world.scrollLeft,
        scrollWidth: world.scrollWidth,
      });
      const pinned = computePinnedFirstColumnState({
        clientWidth: world.clientWidth,
        desiredPinned: world.desiredPinned,
        eligible: world.eligible,
        firstColumnWidth: world.firstColumnWidth,
        scrollLeft: world.scrollLeft,
        scrollWidth: world.scrollWidth,
      });
      const tableTop = world.tableOffsetInDoc - world.scrollTop;
      const sticky = computeStickyHeaderState({
        headerHeight: world.headerHeight,
        tableBottom: tableTop + world.tableHeight,
        tableTop,
        viewportBottom: world.viewportHeight,
        viewportTop: 0,
      });

      // Horizontal overflow & pinning coherence:
      if (world.scrollWidth - world.clientWidth <= 1) {
        expect(edges).toEqual({ left: false, right: false });
        expect(pinned.active).toBe(false);
      }
      if (pinned.scrolledUnder) {
        expect(pinned.active).toBe(true);
        expect(edges.left).toBe(true);
      }
      if (pinned.active) {
        expect(world.clientWidth - world.firstColumnWidth).toBeGreaterThanOrEqual(120);
      }
      // Vertical sticky coherence:
      if (sticky.active) {
        expect(sticky.offsetY).toBeGreaterThan(0);
        expect(sticky.offsetY + world.headerHeight).toBeLessThanOrEqual(world.tableHeight);
      } else {
        expect(sticky.offsetY).toBe(0);
      }
    };

    type Cmd = fc.Command<Table2DWorld, Table2DWorld>;
    const commandArb = fc.commands<Table2DWorld, Table2DWorld>(
      [
        fc.integer({ min: -80, max: 1_800 }).map(
          (nextLeft): Cmd => ({
            check: () => true,
            run: (model) => {
              model.scrollLeft = nextLeft;
              verify(model);
            },
            toString: () => `scrollX(${nextLeft})`,
          }),
        ),
        fc.integer({ min: 0, max: 2_400 }).map(
          (nextTop): Cmd => ({
            check: () => true,
            run: (model) => {
              model.scrollTop = nextTop;
              verify(model);
            },
            toString: () => `scrollY(${nextTop})`,
          }),
        ),
        fc.constant(null).map(
          (): Cmd => ({
            check: () => true,
            run: (model) => {
              model.desiredPinned = !model.desiredPinned;
              verify(model);
            },
            toString: () => "togglePin()",
          }),
        ),
        fc.integer({ min: 180, max: 1_500 }).map(
          (nextWidth): Cmd => ({
            check: () => true,
            run: (model) => {
              model.clientWidth = nextWidth;
              verify(model);
            },
            toString: () => `resizeWidth(${nextWidth})`,
          }),
        ),
        fc.integer({ min: 80, max: 520 }).map(
          (nextCol0): Cmd => ({
            check: () => true,
            run: (model) => {
              model.firstColumnWidth = nextCol0;
              verify(model);
            },
            toString: () => `resizeCol0(${nextCol0})`,
          }),
        ),
      ],
      { maxCommands: 25, size: "max" },
    );

    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 260, max: 1_200 }),
        fc.integer({ min: 260, max: 2_000 }),
        fc.integer({ min: 90, max: 320 }),
        commandArb,
        (desiredPinned, eligible, clientWidth, scrollWidth, firstColumnWidth, commands) => {
          const world: Table2DWorld = {
            clientWidth,
            desiredPinned,
            eligible,
            firstColumnWidth,
            headerHeight: 40,
            scrollLeft: 0,
            scrollTop: 0,
            scrollWidth,
            tableHeight: 720,
            tableOffsetInDoc: 200,
            viewportHeight: 640,
          };
          fc.modelRun(() => ({ model: world, real: world }), commands);
        },
      ),
    );
  });
});

describe("table viewer filter, CSV, and title extraction properties", () => {
  it("matches rows iff every whitespace-separated query token appears case-insensitively", () => {
    const wordArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,10}$/);
    fc.assert(
      fc.property(
        fc.array(wordArb, { minLength: 1, maxLength: 10 }),
        fc.array(wordArb, { minLength: 0, maxLength: 4 }),
        (rowWords, queryWords) => {
          const rowText = rowWords.join(" ");
          const query = queryWords.join("   ");
          const expected = queryWords.every((word) =>
            rowText.toLowerCase().includes(word.toLowerCase()),
          );
          expect(matchesTableRowFilter(rowText, query)).toBe(expected);
        },
      ),
    );
  });

  it("round-trips arbitrary cell strings cleanly through RFC 4180 CSV", () => {
    const cellCharArb = fc.constantFrom(
      "a",
      "B",
      "0",
      " ",
      ",",
      "\"",
      "\n",
      "\t",
      "|",
      "✓",
    );
    const cellArb = fc.string({ unit: cellCharArb, minLength: 0, maxLength: 16 });
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }).chain((cols) =>
          fc.array(fc.array(cellArb, { minLength: cols, maxLength: cols }), {
            minLength: 1,
            maxLength: 8,
          }),
        ),
        (rows) => {
          const csv = serializeTableCellsToCsv(rows);
          const parsed = parseCsvOracle(csv);
          expect(parsed).toEqual(rows);
        },
      ),
    );
  });

  it("extracts an immediately preceding ATX heading title and ignores non-heading paragraphs", () => {
    expect(
      extractTableTitleFromMarkdown(
        "Intro paragraph.\n\n## 2. Part B: MCP Gateway Comparison Matrix\n\n| A | B |\n| --- | --- |",
        "Intro paragraph.\n\n## 2. Part B: MCP Gateway Comparison Matrix\n\n".length,
      ),
    ).toBe("2. Part B: MCP Gateway Comparison Matrix");

    expect(
      extractTableTitleFromMarkdown(
        "> ## Quoted Gateway Matrix\n>\n> | A | B |\n> | --- | --- |",
        "> ## Quoted Gateway Matrix\n>\n> ".length,
      ),
    ).toBe("Quoted Gateway Matrix");

    expect(
      extractTableTitleFromMarkdown(
        "## Heading\n\nSome prose in between.\n\n| A | B |\n| --- | --- |",
        "## Heading\n\nSome prose in between.\n\n".length,
      ),
    ).toBeUndefined();
  });

  it("strips blockquote and list container prefixes from extracted table slices and falls back on invalid slices", () => {
    const cellWordArb = fc.constantFrom("Alpha", "Beta", "**Key**", "`code`", "123");
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }),
        fc.boolean(),
        fc.constantFrom("> ", ">", "> > ", "    "),
        fc.array(fc.tuple(cellWordArb, cellWordArb), { minLength: 1, maxLength: 5 }),
        (quoteDepth, stripFirstLinePrefix, basePrefix, rows) => {
          const prefix = basePrefix === "    "
            ? "    "
            : basePrefix.repeat(quoteDepth);
          const cleanLines = [
            "| Capability | Runtime |",
            "| --- | --- |",
            ...rows.map(([left, right]) => `| ${left} | ${right} |`),
          ];
          const rawLines = cleanLines.map((line, index) =>
            index === 0 && stripFirstLinePrefix ? line : `${prefix}${line}`,
          );
          const normalized = normalizeExtractedTableMarkdown(
            rawLines.join("\n"),
            "| Fallback | Value |\n| --- | --- |\n| X | Y |",
          );
          expect(normalized).toBe(cleanLines.join("\n"));
          for (const line of normalized.split("\n")) {
            expect(line.startsWith(">")).toBe(false);
          }
        },
      ),
    );

    const fallback = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    expect(
      normalizeExtractedTableMarkdown("not a table\njust prose", fallback),
    ).toBe(fallback);
  });
});
