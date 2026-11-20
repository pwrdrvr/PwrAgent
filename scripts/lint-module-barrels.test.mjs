import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import { checkImportBoundaries, importBoundaryViolations } from "./lint-module-barrels.mjs";

const file = "packages/example/src/index.ts";

it("rejects pure re-exports only when they fan out to more than ten modules", () => {
  fc.assert(fc.property(
    fc.uniqueArray(fc.nat(), { minLength: 1, maxLength: 18, size: "max" }),
    fc.constantFrom("star", "named", "type", "alias"),
    (modules, kind) => {
      const reExports = modules.map((id) => {
        if (kind === "star") return `export * from "./module-${id}";`;
        if (kind === "named") return `export { value as value${id} } from "./module-${id}";`;
        if (kind === "type") return `export type { Value as Value${id} } from "./module-${id}";`;
        return `import { value as value${id} } from "./module-${id}"; export { value${id} };`;
      }).join("\n");
      expect(importBoundaryViolations(file, reExports)).toHaveLength(Number(modules.length > 10));
      const withDefaultImport = `${reExports}\nimport forwarded from "./forwarded";`;
      expect(importBoundaryViolations(file, `${withDefaultImport}\nexport default forwarded;`))
        .toHaveLength(Number(modules.length + 1 > 10));
      expect(importBoundaryViolations(file, `${withDefaultImport}\nexport default forwarded();`)).toEqual([]);
      expect(importBoundaryViolations(file, `${reExports}\nexport const local = 1;`)).toEqual([]);
    },
  ));
});

it.each([
  'import type { Value } from "@pwragent/shared";',
  'export { value } from "@pwragent/shared";',
  'type Value = import("@pwragent/shared").Value;',
  'type Value = typeof import("@pwragent/shared");',
  'const mod = await import(`@pwragent/shared`);',
  'const mod = require("@pwragent/shared");',
  'vi.mock("@pwragent/shared");',
  'import value from "@pwragent/shared/index";',
  'export * from "../../shared/src/index.js";',
])("rejects the removed entry point in %s", (source) => {
  expect(importBoundaryViolations(file, source)).toHaveLength(1);
});

it("allows subpaths, package-name strings in config, and the renderer icon catalog", () => {
  expect(importBoundaryViolations(file, [
    'import { value } from "@pwragent/shared/a";',
    'const bundle = { exclude: ["@pwragent/shared"] };',
  ].join("\n"))).toEqual([]);
  expect(importBoundaryViolations(
    "apps/desktop/src/renderer/src/icons/index.ts",
    Array.from({ length: 11 }, (_, index) => `export * from "./icon-${index}";`).join("\n"),
  )).toEqual([]);
});

it("checks source files while skipping both generated desktop release stages", () => {
  const root = mkdtempSync(join(tmpdir(), "pwragent-barrel-lint-"));
  try {
    const paths = [
      "apps/desktop/src/generated-probe.ts",
      "apps/desktop/release-stage/src/generated-probe.ts",
      "apps/desktop/release-stage-arm64/src/generated-probe.ts",
    ];
    for (const file of paths) {
      const absolute = join(root, file);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, 'export * from "@pwragent/shared";');
    }
    const violations = checkImportBoundaries(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(paths[0]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
