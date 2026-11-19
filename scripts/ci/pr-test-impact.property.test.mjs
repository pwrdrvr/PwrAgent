import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { compareFailures, getPrDiff, planImpact } from "./pr-test-impact.mjs";
import { withVitestImpact } from "./pr-test-impact-vitest.mjs";

const source = "packages/shared/src/";
const spec = "apps/desktop/e2e/example.spec.ts";
const changes = (...files) => files.map((file) => ({ status: "M", file }));

function temporaryTree(callback) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pr-test-impact-"));
  const write = (file, content) => {
    const absolute = path.join(root, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  };
  return Promise.resolve().then(() => callback(root, write))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

it("retains status and path identity from Git and falls back when main advances beyond the PR fork", async () => {
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
    expect(git("show", "HEAD:base-only")).toBe("broke on main");
    expect(diverged.branchFiles.some(({ file }) => file === "base-only")).toBe(false);
    expect(diverged.fallback).toMatch(/base advanced/);
  });
});

it("treats unsupported changes as full suite even alongside a recognizable changed test", async () => {
  const inputs = [
    { file: "pnpm-lock.yaml", status: "M" },
    { file: "patches/some-package.patch", status: "A" },
    { file: "packages/shared/package.json", status: "M" },
    { file: "vitest.workspace.ts", status: "M" },
    { file: "apps/desktop/playwright.config.ts", status: "M" },
    { file: "apps/desktop/src/test-setup/state-db-template.ts", status: "M" },
    { file: "apps/desktop/src/main/__tests__/fixtures/script.mjs", status: "M" },
    { file: "apps/desktop/e2e/example.spec.ts-snapshots/example.webp", status: "M" },
    { file: "apps/desktop/native/osx/example.swift", status: "M" },
    { file: "apps/desktop/e2e/windows-example.spec.ts", status: "M" },
    { file: ".github/workflows/ci.yml", status: "M" },
    { file: "scripts/ci/runner.mjs", status: "M" },
    { file: `${source}dependency.mjs`, status: "D" },
    { file: `${source}dependency.mjs`, status: "T" },
  ];
  for (const change of inputs) {
    const result = await planImpact([...changes(spec), change], { e2eFiles: [spec] });
    expect([result.unit.mode, result.e2e.mode], JSON.stringify(change)).toEqual(["full", "full"]);
  }
  const edited = await planImpact(changes(spec), { e2eFiles: [spec, "apps/desktop/e2e/unrelated.spec.ts"] });
  expect(edited.e2e.selected.map(({ file }) => file)).toEqual([spec]);
  const application = await planImpact(changes(`${source}dependency.mjs`), { e2eFiles: [spec], unit: () => { throw new Error("broken"); } });
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
      unrelated: `${source}unrelated.test.mjs`,
    };
    write("fixture.config.mjs", 'export default { test: { include: ["**/*.test.mjs"] } };');
    write(files.changed, "export default 1;");
    write(files.barrel, 'export { default } from "./dependency.mjs";');
    write(files.disk, "1");
    write(files.dynamic, "export default 1;");
    const assertion = 'import assert from "node:assert/strict";';
    write(files.owner, `${assertion} const value = (await import("./barrel.mjs")).default; assert.equal(value, 1);`);
    write(files.diskOwner, `${assertion} import { readFileSync } from "node:fs"; assert.equal(readFileSync(new URL("./fixtures/value.txt", import.meta.url), "utf8"), "1");`);
    write(files.computedOwner, `${assertion} const modulePath = "./computed.mjs"; const {default: value} = await import(modulePath); assert.equal(value, 1);`);
    write(files.unrelated, `${assertion} assert.equal(1, 1);`);

    const specs = [files.owner, files.diskOwner, files.computedOwner, files.unrelated];
    const failures = () => specs.filter((file) => {
      const result = spawnSync(process.execPath, [file], { cwd: root, encoding: "utf8" });
      if (result.status !== 0) expect(result.stderr).toContain("AssertionError");
      return result.status !== 0;
    });
    expect(failures()).toEqual([]);
    write(files.changed, "export default 2;");
    expect(failures()).toEqual([files.owner]);

    await withVitestImpact(root, async (unit) => {
      const options = { unit, e2eFiles: [spec] };
      const staticPlan = await planImpact(changes(files.changed), options);
      expect(staticPlan.unit.selected?.map(({ file }) => file)).toEqual(failures());
      expect(staticPlan.unit.total).toBe(4);
      expect(staticPlan.e2e.mode).toBe("full");

      write(files.disk, "2");
      write(files.dynamic, "export default 2;");
      expect(failures()).toEqual([files.owner, files.diskOwner, files.computedOwner]);
      expect((await planImpact(changes(files.disk), options)).unit.mode).toBe("full");
      expect((await planImpact(changes(files.dynamic, files.changed), options)).unit.reason).toBe("no Vitest graph owner for changed source");
      expect((await planImpact(changes(files.computedOwner), options)).unit.reason).toBe("computed import in changed source");
    }, "fixture.config.mjs");
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
});
