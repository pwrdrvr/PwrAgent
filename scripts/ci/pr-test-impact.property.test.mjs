import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { a11ySpec, getPrDiff, getPushDiff, harnessReferences, listE2eFiles, planImpact, separateA11y, unitGroupFiles, unitGroups, unitLaneCount } from "./pr-test-impact.mjs";
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
    const moved = getPrDiff(root, { base: fork, head, changedFiles: 1 }, api);
    expect(moved.fallback).toBeUndefined();
    expect(moved.mergeFiles).toEqual(diverged.mergeFiles);
    const merge = git("rev-parse", "HEAD");
    expect(getPushDiff(root, { before: base, after: merge, forced: false }).mergeFiles).toEqual(diverged.mergeFiles);
    expect(getPushDiff(root, { before: base, after: merge, forced: true }).fallback).toMatch(/fast-forward/);
    expect(getPushDiff(root, { before: merge, after: base, forced: false }).fallback).toMatch(/fast-forward/);
    write(renamed, "changed by the merge");
    git("add", "-A");
    git("commit", "--amend", "--no-edit");
    expect(getPrDiff(root, { base: fork, head, changedFiles: 1 }, api).fallback).toBe("advanced base changed the tested PR patch");
    git("reset", "--hard", merge);
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
    { file: "vitest.workspace.mts", status: "M" },
    { file: "apps/desktop/playwright.config.ts", status: "M" },
    { file: "apps/desktop/electron.vite.config.ts", status: "M" },
    { file: ".pnpmfile.cjs", status: "M" },
    { file: ".nvmrc", status: "M" },
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
  // Nothing says which specs load a harness file that no file names.
  expect((await planImpact(changes(helper), { unit, e2e: { ...e2e, affected: () => [] } })).e2e)
    .toEqual({ mode: "full", reason: "Playwright harness file has no spec owner", file: helper });
  // One lane runs a narrowed plan, so it holds at most a quarter of the specs.
  const specs = Array.from({ length: 8 }, (_, index) => `apps/desktop/e2e/spec-${index}.spec.ts`);
  const wide = async (count) => (await planImpact(changes(helper), {
    unit, e2e: { ...e2e, inventory: () => specs, affected: () => specs.slice(0, count), harness: () => ({ specs: [specs[0]], suite: false }) },
  })).e2e;
  expect((await wide(2)).selected).toHaveLength(2);
  expect(await wide(3)).toMatchObject({ mode: "full", reason: "selection is wider than one Playwright lane" });

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

it("keeps tests that list files or run source outside the graph, and ignores type-only modules", async () => {
  await temporaryTree(async (root, write) => {
    const file = (name) => `${source}${name}`;
    write("fixture.config.mjs", 'export default { test: { include: ["**/*.test.mjs"] } };');
    write(file("a.mjs"), "export const a = 1;");
    write(file("b.mjs"), "export const b = 2;");
    write(file("types.ts"), "export interface Value { a: number }");
    write(file("kept.cjs"), "module.exports = 1;");
    write(file("uses-a.test.mjs"), 'import { a } from "./a.mjs"; export default a;');
    write(file("uses-b.test.mjs"), 'import { b } from "./b.mjs"; export default b;');
    write(file("scan.test.mjs"), 'import { readdirSync } from "node:fs"; export default readdirSync(".");');
    // Neither test imports `a.mjs`. One bundles source through a helper and
    // the other starts a worker, so both can run it.
    write("node_modules/esbuild/package.json", '{ "name": "esbuild", "main": "index.js" }');
    write("node_modules/esbuild/index.js", "exports.build = () => {};");
    write(file("bundle.mjs"), 'import { build } from "esbuild"; export default build;');
    write(file("bundled.test.mjs"), 'import bundle from "./bundle.mjs"; export default bundle;');
    write(file("worker.test.mjs"), 'import { Worker } from "node:worker_threads"; export default () => new Worker("./b.mjs");');
    write(file("lazy-bundle.test.mjs"), 'export default () => import("esbuild");');
    // No module imports the script or the data file. A test names each by
    // its basename alone.
    write(file("driver.mjs"), "export default 1;");
    write(file("data.json"), "{}");
    write(file("spawns.test.mjs"), 'export default ["driver.mjs", "data.json"].map((name) => new URL(name, import.meta.url));');
    await withVitestImpact(root, async (unit) => {
      const plan = async (...entries) => (await planImpact(entries, { unit })).unit;
      const names = (result) => result.selected?.map(({ file: selected }) => path.posix.basename(selected));
      const modified = (name) => ({ status: "M", file: file(name) });
      const reasons = (result, name) => result.selected.find(({ file: selected }) => selected === file(name)).reasons;
      const outside = "runs on product changes: executes source outside the Vitest graph";

      const narrowed = await plan(modified("a.mjs"));
      expect(names(narrowed)).toEqual(["bundled.test.mjs", "lazy-bundle.test.mjs", "scan.test.mjs", "uses-a.test.mjs", "worker.test.mjs"]);
      expect(reasons(narrowed, "scan.test.mjs")).toEqual([{ file: file("scan.test.mjs"), reason: "always run: enumerates files" }]);
      expect(reasons(narrowed, "bundled.test.mjs")).toEqual([{ file: file("bundle.mjs"), reason: outside }]);
      expect(reasons(narrowed, "worker.test.mjs")).toEqual([{ file: file("worker.test.mjs"), reason: outside }]);
      // A change to tests alone gives a bundle nothing new to run.
      expect(names(await plan(modified("uses-a.test.mjs")))).toEqual(["scan.test.mjs", "uses-a.test.mjs"]);
      // A script or a data file is product input too.
      for (const name of ["driver.mjs", "data.json"]) {
        const named = await plan(modified(name));
        expect(names(named), name)
          .toEqual(["bundled.test.mjs", "lazy-bundle.test.mjs", "scan.test.mjs", "spawns.test.mjs", "worker.test.mjs"]);
        expect(reasons(named, "spawns.test.mjs"), name)
          .toEqual([{ file: file(name), reason: `named in ${file("spawns.test.mjs")}` }]);
      }

      const types = await plan(modified("types.ts"));
      expect(names(types)).toEqual(["scan.test.mjs"]);
      expect(types.ignored).toEqual([{ file: file("types.ts"), reason: "type-only module" }]);

      expect(names(await plan({ status: "D", file: file("removed.mjs") })))
        .toEqual(["bundled.test.mjs", "lazy-bundle.test.mjs", "scan.test.mjs", "worker.test.mjs"]);
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

it("follows a Playwright harness file that is named without a path to the specs that reach it", async () => {
  await temporaryTree((root, write) => {
    const e2e = (name) => `apps/desktop/e2e/${name}`;
    write("apps/desktop/playwright.config.ts", "export default {};");
    write(e2e("fixtures/bootstrap.mjs"), "");
    write(e2e("fixtures/app.ts"), 'export const entry = path.join(fixtureDir, "bootstrap.mjs");');
    write(e2e("launches.spec.ts"), 'import { entry } from "./fixtures/app";');
    // Another file's name ends the same way and is not this file.
    write(e2e("other.spec.ts"), 'const entry = "web-bootstrap.mjs";');
    const harness = harnessReferences(root);
    expect(harness(e2e("fixtures/bootstrap.mjs"))).toEqual({ specs: [e2e("launches.spec.ts")], suite: false });
    expect(harness(e2e("fixtures/unnamed.ts"))).toEqual({ specs: [], suite: false });
  });
});

it("splits a narrowed unit plan into lanes that cover every selected file once", () => {
  const projects = ["desktop-main", "desktop-renderer", "desktop-renderer-node", "messaging", "owner-core", "shared"];
  const selected = Array.from({ length: 700 }, (_, index) => ({ project: projects[index % projects.length], file: `${index}.test.ts` }));
  // Linux runs everything. The two Windows jobs split it without overlap.
  expect(unitGroupFiles(selected, "linux")).toEqual(selected);
  const windows = [...unitGroupFiles(selected, "windows-main"), ...unitGroupFiles(selected, "windows-renderer")];
  expect(windows).toHaveLength(selected.length);
  expect(new Set(windows).size).toBe(selected.length);
  for (const [group, { lanes }] of Object.entries(unitGroups)) {
    expect(unitLaneCount(0, group)).toBe(0);
    expect(unitLaneCount(1, group)).toBe(1);
    expect(unitLaneCount(150, group)).toBe(1);
    expect(unitLaneCount(151, group)).toBe(2);
    // A selection of any size uses no more lanes than the full suite.
    expect(unitLaneCount(100_000, group)).toBe(lanes);
  }
});

it("moves a selected accessibility audit out of the narrowed lane into its own job, keeping every other spec", () => {
  const others = ["apps/desktop/e2e/a11y-helpers.spec.ts", "apps/desktop/e2e/thread-view.spec.ts", "apps/desktop/e2e/zz.spec.ts"];
  // Every subset of the other specs, with and without the audit, in every position.
  for (let mask = 0; mask < 1 << others.length; mask++) {
    const chosen = others.filter((_, index) => mask & (1 << index));
    for (let position = 0; position <= chosen.length + 1; position++) {
      const files = position > chosen.length ? chosen : [...chosen.slice(0, position), a11ySpec, ...chosen.slice(position)];
      const plan = { mode: "selected", total: 10, selected: files.map((file) => ({ file, reasons: ["edited spec"] })) };
      const { e2e, a11y } = separateA11y(plan);
      expect(a11y, files.join(",")).toBe(files.includes(a11ySpec));
      expect(e2e.selected.map(({ file }) => file), files.join(",")).toEqual(chosen);
      expect(e2e.total).toBe(10);
      expect(plan.selected.map(({ file }) => file)).toEqual(files);
    }
  }
  const full = { mode: "full", reason: "fixture" };
  expect(separateA11y(full)).toEqual({ e2e: full, a11y: false });
});

it("treats linked Vite/Oxc virtual helpers from `using` declarations as resolved while still widening on real missing imports", async () => {
  await temporaryTree(async (root, write) => {
    const resource = `${source}resource.ts`;
    const resourceTest = `${source}resource.test.ts`;
    const unrelatedTest = `${source}unrelated.test.ts`;
    write("fixture.config.mjs", 'export default { test: { include: ["**/*.test.ts"] } };');
    write(resource, [
      "export function withResource() {",
      "  using _disposable = { [Symbol.dispose]() {} };",
      "  return 1;",
      "}",
    ].join("\n"));
    write(resourceTest, 'import { withResource } from "./resource"; export default withResource();');
    write(unrelatedTest, "export default 1;");
    write(spec, "export const spec = 1;");
    await withVitestImpact(root, async (unit) => {
      const resourcePlan = await planImpact(changes(resource), { unit });
      expect(resourcePlan.unit.mode).toBe("selected");
      expect(resourcePlan.unit.selected?.map(({ file }) => file)).toEqual([resourceTest]);
      const specOnly = await planImpact(changes(spec), { unit });
      expect(specOnly.unit.mode).toBe("selected");
      expect(specOnly.unit.selected).toEqual([]);
    }, "fixture.config.mjs");

    // Control: a real unresolved static import beside `using` still widens.
    write(resource, [
      'import "./missing";',
      "export function withResource() {",
      "  using _disposable = { [Symbol.dispose]() {} };",
      "  return 1;",
      "}",
    ].join("\n"));
    await withVitestImpact(root, async (unit) => {
      const brokenPlan = await planImpact(changes(resource), { unit });
      expect(brokenPlan.unit).toMatchObject({
        mode: "full",
        reason: "unresolved static import in Vitest graph",
        specifier: "./missing",
      });
    }, "fixture.config.mjs");
  });
}, 30_000);

it("keeps recursive directory readers and preserves literal, fixture and product owners", async () => {
  await temporaryTree(async (root, write) => {
    const e2eGuard = "apps/desktop/src/main/__tests__/e2e-guardrail.test.mjs";
    const repositoryScan = "recursive-scan.test.mjs";
    const unrelatedRendererScan = "apps/desktop/src/renderer/src/__tests__/renderer-scan.test.mjs";
    const fixtureOwner = "apps/desktop/src/main/__tests__/fixture-owner.test.mjs";
    const literalOwner = "apps/desktop/src/main/__tests__/literal-owner.test.mjs";
    const sharedFixture = "apps/desktop/e2e/fixtures/shared-helper.mjs";
    const specA = "apps/desktop/e2e/todo-dispatch-model.spec.ts";
    const specB = "apps/desktop/e2e/targeted.spec.ts";
    const product = `${source}product.mjs`;
    const productOwner = `${source}product.test.mjs`;

    write("fixture.config.mjs", 'export default { test: { include: ["**/*.test.mjs"] } };');
    write(sharedFixture, "export const helper = () => 1;");
    write(specA, "export const specA = 1;");
    write(specB, "export const specB = 1;");
    write(product, "export const value = 1;");
    write(e2eGuard, 'import { readdirSync } from "node:fs"; import path from "node:path"; export default readdirSync(path.resolve(import.meta.dirname, "../../../e2e"));');
    write(repositoryScan, 'import { readdirSync } from "node:fs"; export default readdirSync(new URL("./", import.meta.url), { recursive: true }).filter((file) => file.endsWith(".spec.ts"));');
    write(unrelatedRendererScan, 'import { readdirSync } from "node:fs"; import path from "node:path"; export default readdirSync(path.resolve(import.meta.dirname, ".."));');
    write(fixtureOwner, 'import { helper } from "../../../e2e/fixtures/shared-helper.mjs"; export default helper();');
    write(literalOwner, 'export const named = "targeted.spec.ts";');
    write(productOwner, 'import { value } from "./product.mjs"; export default value;');

    await withVitestImpact(root, async (unit) => {
      const selectedFor = async (entries) => (await planImpact(entries, { unit })).unit.selected?.map(({ file }) => file);
      // Exhaustively test every non-empty combination of spec, shared fixture,
      // and product edits (2^4 - 1 = 15 states).
      for (let mask = 1; mask < 16; mask++) {
        const editSpecA = Boolean(mask & 1);
        const editSpecB = Boolean(mask & 2);
        const editFixture = Boolean(mask & 4);
        const editProduct = Boolean(mask & 8);
        const entries = [
          ...(editSpecA ? [{ status: "M", file: specA }] : []),
          ...(editSpecB ? [{ status: "M", file: specB }] : []),
          ...(editFixture ? [{ status: "M", file: sharedFixture }] : []),
          ...(editProduct ? [{ status: "M", file: product }] : []),
        ];
        const selected = await selectedFor(entries);
        const label = `mask=${mask}`;
        expect(selected, label).toContain(e2eGuard);
        expect(selected.includes(literalOwner), label).toBe(editSpecB);
        expect(selected.includes(fixtureOwner), label).toBe(editFixture);
        expect(selected.includes(productOwner), label).toBe(editProduct);
        expect(selected, label).toContain(repositoryScan);
        expect(selected, label).toContain(unrelatedRendererScan);
      }
    }, "fixture.config.mjs");
  });
}, 30_000);
