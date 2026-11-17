import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { expect, it } from "vitest";
import {
  discoverRendererBytecodeSources,
  rendererBytecodeBudget,
  rendererBytecodeRoots,
} from "../../../../../scripts/renderer-bytecode-scope.mjs";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const rendererRoot = path.join(repoRoot, "apps/desktop/src/renderer/src");
const checker = path.join(repoRoot, "scripts/check-renderer-bytecode.mjs");

it("includes Composer and all three extracted hooks in the shared operational budget", () => {
  const boundaries = JSON.parse(readFileSync(path.join(repoRoot, "scripts/renderer-bytecode-boundaries.json"), "utf8"));
  const sources = discoverRendererBytecodeSources(rendererRoot, rendererBytecodeRoots.map(([, file]) => file), boundaries);
  expect(rendererBytecodeBudget).toBe(25_600);
  expect(sources).toEqual(expect.arrayContaining([
    "App.tsx",
    "features/navigation/Sidebar.tsx",
    "features/thread-detail/ThreadView.tsx",
    "features/automations/AutomationEditor.tsx",
    "features/composer/Composer.tsx",
    "features/composer/useComposerScheduleMenu.ts",
    "features/composer/useComposerSendPreparation.ts",
    "features/composer/useComposerWorkspaceHandoffState.ts",
  ]));
});

it("follows newly extracted helpers, reexports, cycles, aliases and lazy imports", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "renderer-bytecode-graph-"));
  try {
    fc.assert(fc.property(fc.integer({ min: 2, max: 12 }), (count) => {
      for (let index = 0; index < count; index++) {
        const next = (index + 1) % count;
        const importKind = index % 3;
        const code = importKind === 0
          ? `export * from "./helper-${next}";`
          : importKind === 1
            ? `import "@renderer/helper-${next}";`
            : `export const load = () => import("./helper-${next}");`;
        writeFileSync(path.join(directory, `helper-${index}.ts`), code);
      }
      const sources = discoverRendererBytecodeSources(directory, ["helper-0.ts"], []);
      expect(sources).toEqual(Array.from({ length: count }, (_, index) => `helper-${index}.ts`).sort());
    }));
    expect(() => discoverRendererBytecodeSources(directory, ["helper-0.ts"], ["helper-0.ts"]))
      .toThrow("A bytecode root cannot be a boundary");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("rejects an oversized anonymous function extracted into a new module", () => {
  // Exercise the same SSR transform, Oxc compressor, discovery and V8 oracle
  // as CI. Neither fixture has a Composer-prefixed function name.
  mkdirSync(path.join(repoRoot, ".local"), { recursive: true });
  const directory = mkdtempSync(path.join(repoRoot, ".local/renderer-bytecode-oracle-"));
  const relative = (file: string) => path.relative(rendererRoot, path.join(directory, file)).replaceAll("\\", "/");
  const scopePath = path.join(directory, "scope.json");
  try {
    writeFileSync(path.join(directory, "entry.ts"), 'export { nested } from "./extracted"; export function Fixture() { return 1; }');
    writeFileSync(path.join(directory, "extracted.ts"), "export function nested() { return function (value) { return value; }; }");
    writeFileSync(scopePath, JSON.stringify({ roots: [["Fixture", relative("entry.ts")]], boundaries: [] }));
    const check = () => spawnSync(process.execPath, [checker, "--scope", scopePath], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 128 * 1024,
    });
    const passing = check();
    expect(passing.error).toBeUndefined();
    expect(passing.status, passing.stdout + passing.stderr).toBe(0);
    // Property: the budget applies to every function regardless of its name,
    // nesting or which imported module contains it. Mutation crosses the bound.
    const statements = Array.from({ length: 4000 }, (_, index) => `value.x += ${index};`).join("\n");
    writeFileSync(path.join(directory, "extracted.ts"), `export function nested() { return function (value) { ${statements} return value; }; }`);
    const failing = check();
    expect(failing.error).toBeUndefined();
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain("extracted.ts: (anonymous)");
    expect(failing.stderr).toContain("budget 25600");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
