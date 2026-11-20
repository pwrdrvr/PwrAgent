import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { compareFailures, describeLinuxEvidence, getPrDiff, listE2eFiles, planImpact } from "./pr-test-impact.mjs";
import { withVitestImpact } from "./pr-test-impact-vitest.mjs";

const source = "packages/shared/src/";
const spec = "apps/desktop/e2e/example.spec.ts";
const changes = (...files) => files.map((file) => ({ status: "M", file }));

function temporaryTree(callback) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pr-test-impact-")));
  const write = (file, content) => {
    const absolute = path.join(root, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  };
  return Promise.resolve().then(() => callback(root, write))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

it("retains status and path identity from Git and plans from the tested merge when main advances beyond the PR fork", async () => {
  await temporaryTree(async (root, write) => {
    const git = (...args) => execFileSync("git", [
      "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args,
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const commit = (name) => {
      git("add", "-A");
      git("commit", "-m", name);
      return git("rev-parse", "HEAD");
    };
    git("init", "-b", "main");
    write("old file", "rename target");
    write("base-only", "good");
    const fork = commit("fork");
    git("checkout", "-b", "feature");
    const renamed = process.platform === "win32" ? "new file" : "new\nfile";
    git("mv", "old file", renamed);
    const head = commit("rename");
    git("checkout", "main");
    git("merge", "--no-ff", "feature");
    const api = [{ filename: renamed, previous_filename: "old file", status: "renamed" }];
    const exact = getPrDiff(root, { base: fork, head, changedFiles: 1 }, api);
    expect(exact.fallback).toBeUndefined();
    expect(exact.branchFiles).toEqual(expect.arrayContaining([{ status: "A", file: renamed }, { status: "D", file: "old file" }]));
    expect((await planImpact(exact.branchFiles, {})).unit.mode).toBe("full");
    expect(getPrDiff(root, { base: fork, head, changedFiles: 2 }, api).fallback).toMatch(/incomplete/);
    expect(getPrDiff(root, { base: fork, head, changedFiles: 1 }, [{ ...api[0], previous_filename: "wrong" }]).fallback).toMatch(/disagree/);

    git("branch", "advanced", fork);
    git("checkout", "advanced");
    write("base-only", "broke on main");
    const base = commit("advance base");
    git("merge", "--no-ff", "feature");
    const diverged = getPrDiff(root, { base, head, changedFiles: 1 }, api);
    // The edit on main is in the tested merge and is not this PR's change.
    expect(git("show", "HEAD:base-only")).toBe("broke on main");
    expect(diverged.fallback).toBeUndefined();
    expect(diverged.behindBase).toBe(true);
    expect(diverged.mergeFiles).toEqual(expect.arrayContaining([{ status: "A", file: renamed }, { status: "D", file: "old file" }]));
    expect(diverged.mergeFiles.some(({ file }) => file === "base-only")).toBe(false);
    git("commit", "--allow-empty", "-m", "not a merge");
    expect(getPrDiff(root, { base, head, changedFiles: 1 }, api).fallback).toMatch(/not the merge/);
    git("reset", "--hard", "HEAD~1");

    // GitHub can merge the declared parent into trunk before testing the
    // child. Only the incremental child patch should feed its selection.
    git("checkout", "-b", "stack-parent", fork);
    write("parent-only", "stack parent");
    const stackBase = commit("stack parent");
    git("checkout", "-b", "stack-child");
    write("child-only", "stack child");
    const stackHead = commit("stack child");
    git("checkout", "-b", "tested-stack", base);
    git("merge", "--no-ff", "stack-parent");
    const testedBase = git("rev-parse", "HEAD");
    git("merge", "--no-ff", "stack-child");
    const stackApi = [{ filename: "child-only", status: "added" }];
    const event = { base: stackBase, head: stackHead, changedFiles: 1 };
    expect(getPrDiff(root, event, stackApi)).toMatchObject({
      stacked: true, testedBase, mergeFiles: [{ status: "A", file: "child-only" }],
    });
    expect(getPrDiff(root, event, stackApi).fallback).toBeUndefined();
    write("child-only", "different contents");
    git("add", "child-only");
    git("commit", "--amend", "--no-edit");
    expect(getPrDiff(root, event, stackApi).fallback).toBe("tested stack merge changed the child patch");
  });
});

it("keeps the full suite for configuration, dependency and platform inputs, and narrows E2E only without product input", async () => {
  const unit = async () => ({ mode: "selected", selected: [], total: 1 });
  const e2e = { inventory: () => [spec], affected: () => [spec], testOnly: () => true };
  const modes = async (files, options = { unit, e2e }) => {
    const result = await planImpact(files, options);
    return [result.unit.mode, result.e2e.mode];
  };
  const everything = [
    { file: "pnpm-lock.yaml", status: "M" },
    { file: "patches/some-package.patch", status: "A" },
    { file: "packages/shared/package.json", status: "M" },
    { file: "vitest.workspace.ts", status: "M" },
    { file: "apps/desktop/playwright.config.ts", status: "M" },
    { file: "apps/desktop/native/osx/example.swift", status: "M" },
    { file: "apps/desktop/e2e/windows-example.spec.ts", status: "M" },
    { file: ".github/workflows/ci.yml", status: "M" },
    { file: "scripts/ci/runner.mjs", status: "M" },
    { file: `${source}dependency.mjs`, status: "T" },
  ];
  for (const change of everything) {
    expect(await modes([...changes(spec), change]), JSON.stringify(change)).toEqual(["full", "full"]);
  }
  // No recorded map says which specs execute a product module, and
  // Playwright cannot name the readers of a deleted or non-module input.
  const playwrightOnly = [
    { file: `${source}dependency.mjs`, status: "M" },
    { file: `${source}dependency.mjs`, status: "D" },
    { file: "apps/desktop/e2e/example.spec.ts-snapshots/example.webp", status: "M" },
    { file: "apps/desktop/e2e/fixtures/helper.ts", status: "D" },
    { file: "apps/desktop/e2e/global-setup.ts", status: "M" },
  ];
  for (const change of playwrightOnly) {
    expect(await modes([...changes(spec), change]), JSON.stringify(change)).toEqual(["selected", "full"]);
  }
  const helper = "apps/desktop/e2e/fixtures/driver.ts";
  const referenced = (suite) => ({ unit, e2e: { ...e2e, affected: () => [], harness: () => ({ specs: [spec], suite }) } });
  expect(await modes(changes(helper), referenced(true))).toEqual(["selected", "full"]);
  // A spec can bundle or spawn a helper that it never imports.
  expect((await planImpact(changes(helper), referenced(false))).e2e.selected)
    .toEqual([{ file: spec, reasons: ["names a changed file"] }]);

  const edited = await planImpact(changes(spec, "docs/notes.md"), {
    unit, e2e: { ...e2e, inventory: () => [spec, "apps/desktop/e2e/unrelated.spec.ts"] },
  });
  expect(edited.e2e).toMatchObject({ mode: "selected", total: 2, selected: [{ file: spec, reasons: ["edited spec"] }] });

  // A unit-test input reaches a spec only through the harness's imports.
  const unitTest = `${source}__tests__/value.test.ts`;
  expect((await planImpact(changes(unitTest), { unit, e2e: { ...e2e, affected: () => [] } })).e2e)
    .toEqual({ mode: "selected", total: 1, selected: [] });
  expect((await planImpact(changes(unitTest), { unit, e2e })).e2e.selected)
    .toEqual([{ file: spec, reasons: ["imports a changed file"] }]);
  expect(await modes(changes(unitTest), { unit, e2e: { ...e2e, testOnly: () => false } })).toEqual(["selected", "full"]);

  const application = await planImpact(changes(`${source}dependency.mjs`), { unit: () => { throw new Error("broken"); }, e2e });
  expect(application.e2e.mode).toBe("full");
  expect(application.unit.reason).toBe("Vitest planner error");
});

it("checks native Node failures against the Vitest graph and widens for disk-only and computed dependencies", async () => {
  await temporaryTree(async (root, write) => {
    const files = {
      changed: `${source}dependency.mjs`,
      barrel: `${source}barrel.mjs`,
      disk: `${source}fixtures/value.txt`,
      dynamic: `${source}computed.mjs`,
      owner: `${source}related.test.mjs`,
      diskOwner: `${source}disk.test.mjs`,
      computedOwner: `${source}computed.test.mjs`,
      mixedOwner: `${source}mixed.test.mjs`,
      unrelated: `${source}unrelated.test.mjs`,
    };
    write("fixture.config.mjs", 'export default { test: { include: ["**/*.test.mjs"] } };');
    write(files.changed, "export default 1;");
    write(files.barrel, 'export { default } from "./dependency.mjs";');
    write(files.disk, "1");
    write(files.dynamic, "export default 1;");
    const assertion = 'import assert from "node:assert/strict";';
    write(files.owner, `// @vitest-environment jsdom
${assertion} import { AsyncLocalStorage } from "node:async_hooks";
const value = (await import("./barrel.mjs")).default; assert.equal(new AsyncLocalStorage().run(1, () => value), 1);`);
    write(files.diskOwner, `${assertion} import { readFileSync } from "node:fs"; assert.equal(readFileSync(new URL("./fixtures/value.txt", import.meta.url), "utf8"), "1");`);
    write(files.computedOwner, `${assertion} const modulePath = "./computed.mjs"; const {default: value} = await import(modulePath); assert.equal(value, 1);`);
    write(files.mixedOwner, `${assertion} const modulePath = "./dependency.mjs"; const {default: value} = await import(modulePath); assert.equal(value, 1);`);
    write(files.unrelated, `${assertion} assert.equal(1, 1);`);

    const specs = [files.owner, files.diskOwner, files.computedOwner, files.mixedOwner, files.unrelated];
    const failures = () => specs.filter((file) => {
      const result = spawnSync(process.execPath, [file], { cwd: root, encoding: "utf8" });
      if (result.status !== 0) expect(result.stderr).toContain("AssertionError");
      return result.status !== 0;
    });
    expect(failures()).toEqual([]);
    write(files.changed, "export default 2;");
    const observed = failures();
    expect(observed).toEqual([files.owner, files.mixedOwner]);

    await withVitestImpact(root, async (unit) => {
      const options = { unit };
      const selection = async (...changed) => (await planImpact(changes(...changed), options)).unit.selected?.map(({ file }) => file);
      const staticPlan = await planImpact(changes(files.changed), options);
      // A static owner must not mask a computed loader that names the file.
      expect(staticPlan.unit.selected?.map(({ file }) => file)).toEqual([files.mixedOwner, files.owner]);
      expect(staticPlan.unit.total).toBe(5);
      expect(staticPlan.e2e.mode).toBe("full");
      const scored = compareFailures(staticPlan, { missingSlices: [], slices: [{
        kind: "unit", platform: "linux", key: "unit-fixture", first: { complete: true, errors: 0 },
        failures: observed.map((file) => ({ project: staticPlan.unit.selected[0].project, file })),
      }] });
      expect(scored.cases.map(({ file, outcome }) => [file, outcome]))
        .toEqual([[files.owner, "covered"], [files.mixedOwner, "covered"]]);

      // Neither file has an import edge. Each reader names it in a string.
      write(files.disk, "2");
      write(files.dynamic, "export default 2;");
      expect(failures()).toEqual([files.owner, files.diskOwner, files.computedOwner, files.mixedOwner]);
      expect(await selection(files.disk)).toEqual([files.diskOwner]);
      expect(await selection(files.dynamic)).toEqual([files.computedOwner]);
      write(`${source}unnamed.bin`, "1");
      expect((await planImpact(changes(`${source}unnamed.bin`), options)).unit).toMatchObject({
        mode: "full", reason: "no unit owner for changed input",
      });
      expect((await planImpact(changes(files.computedOwner), options)).unit.reason).toBe("computed import in changed source");
    }, "fixture.config.mjs");
  });
}, 30_000);

it("widens when native execution fails to resolve a static import despite another test owning the changed file", async () => {
  await temporaryTree(async (root, write) => {
    const changed = `${source}dependency.mjs`;
    const broken = `${source}broken.test.mjs`;
    write("fixture.config.mjs", 'export default { test: { include: ["**/*.test.mjs"] } };');
    write(changed, "export default 1;");
    write(`${source}owner.test.mjs`, 'import "./dependency.mjs";');
    write(broken, 'import "./missing.mjs";');
    const actual = spawnSync(process.execPath, [broken], { cwd: root, encoding: "utf8" });
    expect(actual.status).not.toBe(0);
    expect(actual.stderr).toContain("ERR_MODULE_NOT_FOUND");
    await withVitestImpact(root, async (unit) => {
      const plan = await planImpact(changes(changed), { unit });
      expect(plan.unit).toMatchObject({
        mode: "full", reason: "unresolved static import in Vitest graph", specifier: "./missing.mjs",
      });
    }, "fixture.config.mjs");
  });
}, 30_000);

it("widens for an aliased createRequire loader with a computed specifier", async () => {
  await temporaryTree(async (root, write) => {
    const changed = `${source}loader.mjs`;
    write("fixture.config.mjs", 'export default { test: { include: ["**/*.test.mjs"] } };');
    write(`${source}value.cjs`, "module.exports = 1;");
    write(changed, 'import { createRequire as makeLoader } from "node:module"; const load = makeLoader(import.meta.url); export const value = (name) => load(name);');
    const owner = `${source}owner.test.mjs`;
    write(owner, 'import assert from "node:assert/strict"; import { value } from "./loader.mjs"; assert.equal(value("./value.cjs"), 1);');
    expect(spawnSync(process.execPath, [owner], { cwd: root }).status).toBe(0);
    await withVitestImpact(root, async (unit) => {
      expect((await planImpact(changes(changed), { unit })).unit).toMatchObject({
        mode: "full", reason: "computed import in changed source", file: changed,
      });
    }, "fixture.config.mjs");
  });
}, 30_000);

it("narrows through a side-effect-free barrel by imported name, and always runs tests that list files", async () => {
  await temporaryTree(async (root, write) => {
    const file = (name) => `${source}${name}`;
    write("fixture.config.mjs", 'export default { test: { include: ["**/*.test.mjs"] } };');
    write("packages/shared/package.json", '{ "sideEffects": false }');
    write(file("index.mjs"), 'export * from "./a.mjs";\nexport * from "./b.mjs";\n');
    write(file("a.mjs"), "export const a = 1;");
    write(file("b.mjs"), "export const b = 2;");
    write(file("types.ts"), "export interface Value { a: number }");
    write(file("kept.cjs"), "module.exports = 1;");
    write(file("uses-a.test.mjs"), 'import { a } from "./index.mjs"; export default a;');
    write(file("uses-b.test.mjs"), 'import { b } from "./index.mjs"; export default b;');
    write(file("whole.test.mjs"), 'import * as all from "./index.mjs"; export default all;');
    write(file("scan.test.mjs"), 'import { readdirSync } from "node:fs"; export default readdirSync(".");');
    await withVitestImpact(root, async (unit) => {
      const plan = async (...entries) => (await planImpact(entries, { unit })).unit;
      const names = (result) => result.selected?.map(({ file: selected }) => path.posix.basename(selected));
      const modified = (name) => ({ status: "M", file: file(name) });

      const narrowed = await plan(modified("a.mjs"));
      expect(names(narrowed)).toEqual(["scan.test.mjs", "uses-a.test.mjs", "whole.test.mjs"]);
      expect(narrowed.barrels).toEqual([file("index.mjs")]);
      expect(narrowed.selected[0].reasons).toEqual([{ file: file("scan.test.mjs"), reason: "always run: enumerates files" }]);
      // An edited barrel can rebind any name, so every importer runs.
      expect(names(await plan(modified("index.mjs"))))
        .toEqual(["scan.test.mjs", "uses-a.test.mjs", "uses-b.test.mjs", "whole.test.mjs"]);

      const types = await plan(modified("types.ts"));
      expect(names(types)).toEqual(["scan.test.mjs"]);
      expect(types.ignored).toEqual([{ file: file("types.ts"), reason: "type-only module" }]);

      expect(names(await plan({ status: "D", file: file("removed.mjs") }))).toEqual(["scan.test.mjs"]);
      // `kept.cjs` now answers an unchanged import of `./kept`.
      expect(await plan({ status: "D", file: file("kept.mjs") })).toMatchObject({
        mode: "full", reason: "deleted file can change module resolution",
      });
    }, "fixture.config.mjs");
  });
}, 30_000);

it("uses Playwright's collected specs and widens when registration is absent or collection fails", async () => {
  await temporaryTree(async (root, write) => {
    const config = "apps/desktop/playwright.config.cjs";
    const playwright = createRequire(path.resolve("apps/desktop/package.json")).resolve("@playwright/test");
    const other = "apps/desktop/e2e/other.spec.ts";
    const register = `const { test } = require(${JSON.stringify(playwright)}); test("collected", () => {});`;
    write(config, 'module.exports = { testDir: "./e2e" };');
    write(spec, register);
    write(other, register);
    const options = {
      unit: async () => ({ mode: "full", reason: "not under test" }),
      e2e: { inventory: () => listE2eFiles(root, config), affected: () => [spec] },
    };
    expect((await planImpact(changes(spec), options)).e2e).toMatchObject({ mode: "selected", total: 2, selected: [{ file: spec }] });
    write(spec, "export {};");
    expect((await planImpact(changes(spec), options)).e2e).toMatchObject({ mode: "full", reason: "edited spec is absent from Playwright collection" });
    write(spec, 'throw new Error("failed while collecting");');
    expect((await planImpact(changes(spec), options)).e2e).toMatchObject({ mode: "full", reason: "Playwright collection failed" });
  });
}, 30_000);

it("counts omitted failures by exact project/file and leaves missing evidence visible", () => {
  const result = compareFailures({
    unit: { mode: "selected", selected: [{ project: "shared", file: "a.test.ts" }] },
    e2e: { mode: "selected", selected: [{ file: spec }] },
  }, {
    missingSlices: [{ platform: "linux" }],
    slices: [
      { kind: "unit", platform: "linux", key: "unit-linux-1", first: { complete: true, errors: 0 }, failures: [
        { project: "shared", file: "a.test.ts" }, { project: "desktop-main", file: "a.test.ts" },
      ] },
      { kind: "e2e", platform: "linux", key: "e2e-linux-1", first: { complete: false, errors: 1 }, failures: [
        { file: spec }, { file: "apps/desktop/e2e/other.spec.ts" }, {},
      ] },
    ],
  });
  expect(result).toMatchObject({ covered: 2, missed: 2, unknown: 1, missingLinuxSlices: 1,
    incompleteLinuxSlices: ["e2e-linux-1"], linuxSlicesWithErrors: ["e2e-linux-1"] });
  expect(describeLinuxEvidence({ ...result, covered: 0, missed: 0, unknown: 0 }))
    .toBe("0/0/0 (partial evidence: 1 missing, 1 incomplete, 1 with errors)");
  expect(describeLinuxEvidence({
    ...result, covered: 0, missed: 0, unknown: 0, missingLinuxSlices: 0,
    incompleteLinuxSlices: [], linuxSlicesWithErrors: [],
  })).toBe("0/0/0");
});
