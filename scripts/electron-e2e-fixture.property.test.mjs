import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import { oxlintBin, repositoryRoot } from "./oxlint.mjs";

it("rejects every base Playwright test import in Electron specs before launch", () => {
  // Batch generated variants into one native lint invocation.
  fc.assert(fc.property(fc.array(fc.record({
    alias: fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/).map((suffix) => `test_${suffix}`),
    quote: fc.constantFrom("\"", "'"),
    separator: fc.constantFrom(" ", "\n  ", " /* fixture */ "),
  }), { minLength: 20, maxLength: 20 }), assertFixtureImports), { numRuns: 1 });
});

function assertFixtureImports(programs) {
  const root = mkdtempSync(join(tmpdir(), "pwragent-e2e-fixture-lint-"));
  const rejected = [];
  const write = (filename, source) => {
    const target = join(root, filename);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  };
  try {
    write(".oxlintrc.json", readFileSync(join(repositoryRoot, ".oxlintrc.json"), "utf8"));
    for (const [index, { alias, quote, separator }] of programs.entries()) {
      for (const kind of ["named", "aliased", "namespace"]) {
        const binding = kind === "named" ? "test" : alias;
        const clause = kind === "namespace"
          ? `* as ${binding}`
          : `{${separator}test${kind === "aliased" ? ` as ${binding}` : ""}${separator}}`;
        const call = kind === "namespace" ? `${binding}.test` : binding;
        const body = `\nimport { launchElectronApp } from "./fixtures/electron-app";
${call}("launch", async () => { await launchElectronApp(); });`;
        const filename = `apps/desktop/e2e/nested/${kind}-${index}.inspect.spec.ts`;
        write(filename, `import ${clause} from ${quote}@playwright/test${quote};${body}`);
        rejected.push(filename);
        write(`apps/desktop/e2e/${kind}-${index}.spec.ts`,
          `import ${clause} from ${quote}./fixtures/electron-test${quote};${body}`);
      }
    }
    // The original lane-3 failure, with the same combined import as #3164.
    const regression = "apps/desktop/e2e/mcp-ipc-settings.spec.ts";
    write(regression, `import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
test("MCP server URL", async () => { expect(await launchElectronApp()).toBeDefined(); });`);
    rejected.push(regression);
    write("apps/desktop/e2e/types.spec.ts", `import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
export const check = (page: Page) => expect(page).toBeDefined();`);
    write("apps/desktop/e2e/fixtures/electron-test.ts",
      "export { test } from \"@playwright/test\";");

    const result = spawnSync(process.execPath, [oxlintBin(), "--format", "json", "apps"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    const { diagnostics } = JSON.parse(result.stdout);
    expect(diagnostics.map(({ filename }) => filename.replaceAll("\\", "/")).sort())
      .toEqual(rejected.sort());
    for (const diagnostic of diagnostics) {
      expect(diagnostic.code).toBe("eslint(no-restricted-imports)");
      expect(diagnostic.help).toContain("fixtures/electron-test");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
