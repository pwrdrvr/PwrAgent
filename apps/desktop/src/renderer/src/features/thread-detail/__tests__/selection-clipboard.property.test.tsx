import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildSelectionClipboard } from "../selection-clipboard";

type Alignment = "" | "left" | "center" | "right";

const alignmentArb = fc.constantFrom<Alignment>("", "left", "center", "right");
const disallowedStyleArb = fc.constantFrom(
  "",
  "color: red",
  "font-weight: 700; background: yellow",
  "text-align: justify",
  "text-align: start",
);

function delimiterFor(align: Alignment): string {
  switch (align) {
    case "left":
      return ":---";
    case "center":
      return ":---:";
    case "right":
      return "---:";
    default:
      return "---";
  }
}

function buildTableFixture(
  alignments: readonly Alignment[],
  bodyRowCount: number,
  disallowedStyle: string,
): HTMLDivElement {
  const root = document.createElement("div");
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");

  alignments.forEach((align, col) => {
    const th = document.createElement("th");
    const styles = [
      align ? `text-align: ${align}` : "",
      disallowedStyle && !disallowedStyle.startsWith("text-align:") ? disallowedStyle : "",
      !align && disallowedStyle.startsWith("text-align:") ? disallowedStyle : "",
    ].filter(Boolean);
    if (styles.length > 0) {
      th.setAttribute("style", styles.join("; "));
    }
    th.textContent = `H${col}`;
    headRow.append(th);
  });
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (let r = 0; r < bodyRowCount; r += 1) {
    const tr = document.createElement("tr");
    alignments.forEach((align, col) => {
      const td = document.createElement("td");
      if (align) {
        td.style.textAlign = align;
      } else if (disallowedStyle) {
        td.setAttribute("style", disallowedStyle);
      }
      td.textContent = `R${r}C${col}`;
      tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(tbody);
  root.append(table);
  return root;
}

describe("buildSelectionClipboard table alignment properties", () => {
  it("preserves allowlisted column alignments in Markdown and HTML and strips disallowed styles", () => {
    fc.assert(
      fc.property(
        fc.array(alignmentArb, { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 1, max: 4 }),
        disallowedStyleArb,
        fc.boolean(),
        (alignments, bodyRows, disallowedStyle, startInBody) => {
          const root = buildTableFixture(alignments, bodyRows, disallowedStyle);
          document.body.append(root);
          try {
            const firstTarget = startInBody
              ? root.querySelector("tbody td")!.firstChild!
              : root.querySelector("thead th")!.firstChild!;
            const allBodyCells = root.querySelectorAll("tbody td");
            const lastTarget = allBodyCells[allBodyCells.length - 1]!.firstChild!;

            const range = document.createRange();
            range.setStart(firstTarget, 0);
            range.setEnd(lastTarget, (lastTarget.textContent ?? "").length);

            const clipboard = buildSelectionClipboard(range, root);
            if (alignments.length === 1 && bodyRows === 1 && startInBody) {
              // Selection is inside a single text node -> browser default.
              expect(clipboard).toBeUndefined();
              return;
            }

            expect(clipboard).toBeDefined();
            const lines = clipboard!.text.split("\n");
            expect(lines[1]).toBe(`| ${alignments.map(delimiterFor).join(" | ")} |`);

            const parsed = document.createElement("div");
            parsed.innerHTML = clipboard!.html;
            const headerStyles = Array.from(parsed.querySelectorAll("thead th")).map(
              (cell) => cell.getAttribute("style"),
            );
            const expectedStyles = alignments.map((align) =>
              align ? `text-align: ${align}` : null,
            );
            expect(headerStyles).toEqual(expectedStyles);
            for (const row of Array.from(parsed.querySelectorAll("tbody tr"))) {
              const cellStyles = Array.from(row.querySelectorAll("td")).map(
                (cell) => cell.getAttribute("style"),
              );
              expect(cellStyles).toEqual(expectedStyles);
            }
          } finally {
            root.remove();
          }
        },
      ),
    );
  });
});
