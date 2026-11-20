import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import fc from "fast-check";
import { build } from "vite";
import { expect, it } from "vitest";
import { bytecodeBudget, compileBytecode, wrapVitestModule } from "./bytecode-compiler.mjs";
import { annotateBytecode } from "./bytecode-attribution.mjs";
import { discoverMainBytecodeSources, sourceFiles } from "./main-bytecode-scope.mjs";

it("keeps extracted modules in scope for arbitrary cyclic relative/reexport/lazy import graphs", () => {
  const root = mkdtempSync(join(tmpdir(), "main-bytecode-graph-"));
  try {
    fc.assert(fc.property(fc.integer({ min: 2, max: 20 }), (count) => {
      for (let i = 0; i < count; i++) {
        const next = (i + 1) % count;
        const code = i % 3 === 0 ? `export * from "./helper-${next}";`
          : i % 3 === 1 ? `import "./helper-${next}";`
            : `export const load = () => import("./helper-${next}");`;
        writeFileSync(join(root, `helper-${i}.ts`), code);
      }
      expect(discoverMainBytecodeSources(root, [join(root, "helper-0.ts")]).sources)
        .toEqual(Array.from({ length: count }, (_, i) => `helper-${i}.ts`).sort());
    }));
    mkdirSync(join(root, "node_modules", "@pwragent", "fixture", "src"), { recursive: true });
    writeFileSync(join(root, "node_modules/@pwragent/fixture/package.json"), JSON.stringify({ exports: { ".": "./src/index.ts" } }));
    // External dependencies are distinguished by physical ownership, never a
    // function-name prefix. Real workspace symlinks resolve inside the repo.
    writeFileSync(join(root, "node_modules/@pwragent/fixture/src/index.ts"), "export function external() {}");
    writeFileSync(join(root, "entry.ts"), 'import "@pwragent/fixture";');
    expect(discoverMainBytecodeSources(root, [join(root, "entry.ts")]).sources).toEqual(["entry.ts"]);
    const workspace = join(root, "packages/linked");
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "package.json"), JSON.stringify({ exports: { ".": "./src/index.ts" } }));
    writeFileSync(join(workspace, "src/index.ts"), 'export { nested } from "./extracted";');
    writeFileSync(join(workspace, "src/extracted.ts"), "export const nested = () => 1;");
    symlinkSync(workspace, join(root, "node_modules/@pwragent/linked"), "junction");
    writeFileSync(join(root, "entry.ts"), 'import "@pwragent/linked";');
    expect(discoverMainBytecodeSources(root, [join(root, "entry.ts")]).sources)
      .toEqual(["entry.ts", "packages/linked/src/extracted.ts", "packages/linked/src/index.ts"]);
    writeFileSync(join(root, "entry.ts"), 'const require = (value) => value; require(someId);');
    expect(discoverMainBytecodeSources(root, [join(root, "entry.ts")]).dynamic).toEqual([]);
    writeFileSync(join(root, "entry.ts"), 'export const load = (name) => import(name);');
    expect(discoverMainBytecodeSources(root, [join(root, "entry.ts")]).dynamic).toHaveLength(1);
    writeFileSync(join(root, "entry.ts"), 'import "@unregistered/helper";');
    expect(() => discoverMainBytecodeSources(root, [join(root, "entry.ts")])).toThrow("Cannot resolve module import");
    mkdirSync(join(root, "fixtures"), { recursive: true });
    writeFileSync(join(root, "fixtures/extracted.test.mjs"), "export function shipped() {}");
    expect(sourceFiles(root, { excludeTests: false })).toContain(join(root, "fixtures/extracted.test.mjs"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("compiles nested/anonymous/object/class functions eagerly without running effects", async () => {
  const code = `globalThis.__bytecodeFixtureMustNotRun();
    function outer() { return function (x) { return x+1; }; }
    const object = { method(x) { return () => x+2; } };
    class Owner { field = () => 3; method() { return 4; } }
    globalThis.fixture = { outer, object, Owner };
  `;
  const result = await compileBytecode([
    { file: "test", variant: "Vitest", code: wrapVitestModule(code) },
    { file: "production", variant: "production", code, esm: true },
  ]);
  for (const variant of ["Vitest", "production"]) {
    const records = result.records.filter((record) => record.variant === variant);
    expect(records.some((record) => record.name === "outer")).toBe(true);
    const compiled = variant === "Vitest" ? wrapVitestModule(code) : code;
    const attributed = annotateBytecode(process.cwd(), { file: "fixture.js", source: "fixture.js", variant: variant === "Vitest" ? variant : "oracle-ESM", code: compiled }, records);
    for (const functionText of ["function (x)", "() => x+2", "() => 3"]) {
      expect(attributed.some((record) => record.generatedStart === compiled.indexOf(functionText) && record.classification === "first-party")).toBe(true);
    }
    expect(records.filter((record) => record.name === "method")).toHaveLength(2);
    expect(records.every((record) => Number.isInteger(record.bytes) && record.bytes >= 0)).toBe(true);
  }
});

it("uses V8 as the oracle when a nested anonymous helper crosses the operational bound", async () => {
  expect(bytecodeBudget).toBe(25_600);
  const statements = Array.from({ length: 4000 }, (_, i) => `value.x += ${i};`).join("\n");
  for (const body of ["value.x++;", statements]) {
    const code = `export function owner() { return function (value) { ${body} return value; }; }`;
    const results = await compileBytecode([
      { file: "extracted", variant: "production", code, esm: true },
      { file: "extracted", variant: "Vitest", code: wrapVitestModule(code.replace("export ", "") + "; globalThis.owner = owner;") },
    ]);
    for (const variant of ["Vitest", "production"]) {
      const maximum = Math.max(...results.records.filter((record) => record.variant === variant).map((record) => record.bytes));
      expect(maximum > bytecodeBudget).toBe(body === statements);
    }
  }
});

it("returns one process's records in the caller's module order however the modules are split and the listing is read", async () => {
  // The sizes differ, so the split by source size reorders the modules.
  const modules = Array.from({ length: 7 }, (_, index) => {
    const code = `export function f${index}(value) { ${"value.x++; ".repeat((index * 5) % 7 + 1)}return () => value; }`;
    return index % 2
      ? { file: `module-${index}.js`, variant: "production", code, esm: true }
      : { file: `module-${index}.js`, variant: "Vitest", code: wrapVitestModule(code.replace("export ", "")) };
  });
  const oracle = await compileBytecode(modules, { processes: 1, listing: "pipe" });
  expect([...new Set(oracle.records.map(({ file }) => file))]).toEqual(modules.map(({ file }) => file));
  for (const options of [{ processes: 3, listing: "pipe" }, { processes: 1, listing: "file" }, { processes: 7, listing: "file" }, { processes: 20 }]) {
    const { runtime, records } = await compileBytecode(modules, options);
    expect(runtime, JSON.stringify(options)).toEqual(oracle.runtime);
    expect(records, JSON.stringify(options)).toEqual(oracle.records);
  }
}, 60_000);

// Compiler integrations launch isolated Vite/Node/Electron processes. Their
// harness timeout allows compilation work; no assertion measures elapsed time.
it("rejects an extracted anonymous helper in real SSR and Oxc output, then accepts separated frames", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  mkdirSync(join(root, ".local"), { recursive: true });
  const directory = mkdtempSync(join(root, ".local/main-bytecode-oracle-"));
  try {
    const entry = join(directory, "entry.ts");
    const helper = join(directory, "extracted.ts");
    writeFileSync(entry, 'export { owner } from "./extracted";');
    const scope = join(directory, "scope.json");
    const report = join(directory, "report.json");
    const compile = async (body) => {
      writeFileSync(helper, body);
      await build({
        configFile: false, root: directory, logLevel: "silent",
        build: { minify: "oxc", sourcemap: "hidden", outDir: join(directory, "dist"),
          lib: { entry, formats: ["es"], fileName: () => "fixture.mjs" } },
      });
      writeFileSync(scope, JSON.stringify({ roots: [relative(root, entry)], productionFiles: [relative(root, join(directory, "dist/fixture.mjs"))] }));
      const result = spawnSync(process.execPath, [join(root, "scripts/check-main-bytecode.mjs"), "--scope", scope, "--report", report], {
        cwd: root, encoding: "utf8", maxBuffer: 128 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect(existsSync(report), result.stdout + result.stderr).toBe(true);
      return { result, report: JSON.parse(readFileSync(report, "utf8")) };
    };
    const statements = Array.from({ length: 4000 }, (_, i) => `value.x += ${i};`);
    const failing = await compile(`export function owner() { return function (value) { ${statements.join("\n")} return value; }; }`);
    expect(failing.result.status, failing.result.stdout + failing.result.stderr).toBe(1);
    for (const [runtime, variant] of [["Node", "Vitest"], ["Node", "production"], ["Electron", "production"]]) {
      expect(failing.report.records.some((record) => record.runtime === runtime && record.variant === variant && record.classification === "first-party" && record.source?.endsWith("extracted.ts") && record.bytes > bytecodeBudget)).toBe(true);
    }
    // The same observable operations stay in order. Named frames prevent the
    // shipped compressor from rebuilding one over-budget callback.
    const phases = Array.from({ length: 4 }, (_, i) => `function phase${i}(value) { ${statements.slice(i * 1000, (i + 1) * 1000).join("\n")} }`).join("\n");
    const passing = await compile(`${phases} export function owner() { return function (value) { phase0(value); phase1(value); phase2(value); phase3(value); return value; }; }`);
    expect(passing.result.status, passing.result.stdout + passing.result.stderr).toBe(0);
    for (const variant of ["Vitest", "production"]) {
      expect(passing.report.records.filter((record) => record.variant === variant && record.classification === "first-party").every((record) => record.bytes <= bytecodeBudget)).toBe(true);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30_000);

it("keeps an oversized function budgeted when its source map has no original locations", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  mkdirSync(join(root, ".local"), { recursive: true });
  const directory = mkdtempSync(join(root, ".local/main-bytecode-unmapped-"));
  try {
    const entry = join(directory, "entry.ts");
    const output = join(directory, "output.mjs");
    const scope = join(directory, "scope.json");
    const report = join(directory, "report.json");
    writeFileSync(entry, "export function owner() { return 1; }");
    const body = Array.from({ length: 4000 }, (_, i) => `value.x += ${i};`).join("\n");
    writeFileSync(output, `export function unmapped(value) { ${body} return value; }`);
    writeFileSync(output + ".map", JSON.stringify({ version: 3, sources: [], names: [], mappings: "" }));
    writeFileSync(scope, JSON.stringify({ roots: [relative(root, entry)], productionFiles: [relative(root, output)] }));
    const result = spawnSync(process.execPath, [join(root, "scripts/check-main-bytecode.mjs"), "--scope", scope, "--report", report], { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("budget 25600");
    const records = JSON.parse(readFileSync(report, "utf8")).records;
    for (const runtime of ["Node", "Electron"]) {
      expect(records.some((record) => record.runtime === runtime && record.classification === "unmapped" && record.name === "unmapped" && record.bytes > bytecodeBudget)).toBe(true);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30_000);

it("never lets a bundler wrapper or mixed dependency provenance hide a first-party frame", async () => {
  const body = Array.from({ length: 4000 }, (_, i) => `value.x += ${i};`).join("\n");
  const code = `import { t as commonJS } from "./chunks/rolldown-runtime-test.js";
    export const load = commonJS((exports, module) => {
      module.exports = function (value) { ${body} return value; };
    });`;
  const result = await compileBytecode([{ file: "bundle.js", variant: "production", code, esm: true }]);
  const map = { version: 3, sources: ["apps/desktop/src/main/helper.ts"], names: [], mappings: code.split("\n").map(() => [[0, 0, 0, 0]]) };
  const records = annotateBytecode(process.cwd(), { file: "bundle.js", variant: "production", code, map, runtimeFiles: ["chunks/rolldown-runtime-test.js"] }, result.records);
  expect(records.some((record) => record.classification === "synthetic-bundler-wrapper")).toBe(true);
  expect(records.some((record) => record.classification === "first-party" && record.bytes > bytecodeBudget)).toBe(true);

  const mixed = "export function mixed(value) { value.x += 1; value.x += 2; return value; }";
  const compiled = await compileBytecode([{ file: "mixed.js", variant: "production", code: mixed, esm: true }]);
  const mixedMap = { version: 3, sources: ["node_modules/vendor.js", "apps/desktop/src/main/helper.ts"], names: [], mappings: [[[0, 0, 0, 0], [mixed.indexOf("value.x += 2"), 1, 0, 0]]] };
  const annotated = annotateBytecode(process.cwd(), { file: "mixed.js", variant: "production", code: mixed, map: mixedMap }, compiled.records);
  expect(annotated.find((record) => record.name === "mixed")?.classification).toBe("first-party");
  const similarName = annotateBytecode(process.cwd(), { file: "chunks/rolldown-runtime-helper.js", variant: "production", code: mixed, map: mixedMap }, compiled.records);
  expect(similarName.find((record) => record.name === "mixed")?.classification).toBe("first-party");
}, 30_000);
