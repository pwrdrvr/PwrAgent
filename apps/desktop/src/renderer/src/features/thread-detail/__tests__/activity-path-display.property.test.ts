import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerThreadActivityEntry } from "@pwragent/shared/contracts/normalized-app-server";
import { formatActivityText } from "../activity-path-display";

const segment = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,12}$/u);

function detailFor(path: string, label = `File ${path}`): AppServerThreadActivityEntry["details"] {
  return [{ id: "detail-1", kind: "read", label, path }];
}

describe("formatActivityText", () => {
  it("relativizes a POSIX path whose leading slash was stripped in the label", () => {
    const root = "/Users/dev/.pwragent/worktrees/ab12/PwrAgnt";
    const fullPath = `${root}/docs/local-cpu-checkout.md`;
    const slashless = fullPath.slice(1);

    expect(
      formatActivityText(`File ${slashless}`, detailFor(fullPath, `File ${slashless}`), [root]),
    ).toBe("File docs/local-cpu-checkout.md");
  });

  it("relativizes a Windows path when the label mixes separators", () => {
    const root = "C:\\work\\repo";
    const fullPath = `${root}\\src\\main.ts`;

    expect(
      formatActivityText("File C:/work/repo\\src/main.ts", detailFor(fullPath), [root]),
    ).toBe("File src\\main.ts");
  });

  it("preserves a literal search query that matches the slashless location", () => {
    const label = 'Searched "repo/src/main.ts"';
    expect(formatActivityText(label, detailFor("/repo/src/main.ts", label), ["/repo"]))
      .toBe(label);
  });

  it("does not rewrite a single-segment root name inside ordinary prose", () => {
    expect(
      formatActivityText("Searched repo for pattern", detailFor("/repo"), ["/repo"]),
    ).toBe("Searched repo for pattern");
  });

  it("property: any POSIX path inside a linked directory relativizes with or without its leading slash", () => {
    const scenario = fc.record({
      workspace: fc.array(segment, { minLength: 1, maxLength: 5 }),
      relative: fc.array(segment, { minLength: 1, maxLength: 4 }),
      stripLeadingSlash: fc.boolean(),
      prefix: fc.constantFrom("File ", "Dir "),
    });

    fc.assert(
      fc.property(scenario, ({ workspace, relative, stripLeadingSlash, prefix }) => {
        const root = `/${workspace.join("/")}`;
        const rel = relative.join("/");
        const fullPath = `${root}/${rel}`;
        const labelPath = stripLeadingSlash ? fullPath.slice(1) : fullPath;
        const label = `${prefix}${labelPath}`;

        expect(formatActivityText(label, detailFor(fullPath, label), [root]))
          .toBe(`${prefix}${rel}`);
      }),
      { numRuns: 300 },
    );
  });

  it("property: a search query preserves slashless text regardless of its location", () => {
    fc.assert(fc.property(
      fc.array(segment, { minLength: 1, maxLength: 4 }),
      fc.array(segment, { minLength: 1, maxLength: 4 }),
      fc.constantFrom("", "File ", "Read ", "Dir "),
      (workspace, relative, queryPrefix) => {
        const root = `/${workspace.join("/")}`;
        const path = `${root}/${relative.join("/")}`;
        const label = `Searched "${queryPrefix}${path.slice(1)}"`;
        expect(formatActivityText(label, detailFor(path, label), [root])).toBe(label);
      },
    ));
  });

  it("property: paths outside linked directories or with no linked directories are not rewritten", () => {
    const scenario = fc.record({
      workspace: fc.array(segment, { minLength: 2, maxLength: 4 }),
      relative: fc.array(segment, { minLength: 1, maxLength: 3 }),
      place: fc.constantFrom("sibling", "parent", "unlinked"),
      stripLeadingSlash: fc.boolean(),
    });

    fc.assert(
      fc.property(scenario, ({ workspace, relative, place, stripLeadingSlash }) => {
        const root = `/${workspace.join("/")}`;
        const parent = `/${workspace.slice(0, -1).join("/")}`;
        const fullPath =
          place === "sibling"
            ? `${parent}/${workspace.at(-1)}-other/${relative.join("/")}`
            : place === "parent"
              ? `${parent}/${relative.join("/")}`
              : `${root}/${relative.join("/")}`;
        // Exclude the rare case where parent + relative happens to equal root or land inside root.
        fc.pre(place === "unlinked" || (fullPath !== root && !fullPath.startsWith(`${root}/`)));
        const labelPath = stripLeadingSlash ? fullPath.slice(1) : fullPath;
        const label = `File ${labelPath}`;
        const roots = place === "unlinked" ? [] : [root];

        expect(formatActivityText(label, detailFor(fullPath, label), roots)).toBe(label);
      }),
      { numRuns: 300 },
    );
  });

  it("property: Windows paths inside a linked Windows directory relativize regardless of label separators", () => {
    const scenario = fc.record({
      drive: fc.constantFrom("C", "D"),
      workspace: fc.array(segment, { minLength: 1, maxLength: 4 }),
      relative: fc.array(segment, { minLength: 1, maxLength: 3 }),
      detailSeparators: fc.array(fc.constantFrom("/", "\\"), { minLength: 7, maxLength: 7 }),
      labelSeparators: fc.array(fc.constantFrom("/", "\\"), { minLength: 7, maxLength: 7 }),
    });

    fc.assert(
      fc.property(
        scenario,
        ({ drive, workspace, relative, detailSeparators, labelSeparators }) => {
          const root = `${drive}:\\${workspace.join("\\")}`;
          const rel = relative.join("\\");
          const spellPath = (separators: string[]) => `${drive}:${[...workspace, ...relative]
            .map((part, index) => `${separators[index]}${part}`).join("")}`;
          const detailPath = spellPath(detailSeparators);
          const labelPath = spellPath(labelSeparators);

          expect(formatActivityText(`File ${labelPath}`, detailFor(detailPath), [root]))
            .toBe(`File ${rel}`);
        },
      ),
      { numRuns: 300 },
    );
  });
});
