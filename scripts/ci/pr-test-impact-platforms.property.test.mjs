import { readFileSync } from "node:fs";
import fc from "fast-check";
import { expect, it } from "vitest";
import { annotateE2ePlatforms, e2eFilesForPlatform, formatWindowsE2eSummary, planE2eLanes, specRunsOnPlatform } from "./pr-test-impact.mjs";

it("targets narrowed Linux and Windows E2E lanes by spec platform eligibility and leaves full plans off Windows by default", () => {
  const skipKinds = [
    { name: "all", line: "", linux: true, win32: true },
    { name: "skip-win32", line: 'test.skip(process.platform === "win32", "non-win32");', linux: true, win32: false },
    { name: "only-win32", line: 'test.skip(process.platform !== "win32", "win32 only");', linux: false, win32: true },
    { name: "only-darwin", line: 'test.skip(process.platform !== "darwin", "darwin only");', linux: false, win32: false },
    { name: "darwin-arm64", line: 'test.skip(process.platform !== "darwin" || process.arch !== "arm64", "darwin arm64");', linux: false, win32: false },
    { name: "skip-darwin", line: 'test.skip(process.platform === "darwin", "non-darwin");', linux: true, win32: true },
  ];
  fc.assert(fc.property(
    fc.array(fc.constantFrom(...skipKinds), { minLength: 1, maxLength: 6 }),
    fc.boolean(),
    (cases, dynamicLoop) => {
      const blocks = cases.map((item, index) => `test("case ${index}", async () => {\n  ${item.line}\n});`);
      if (dynamicLoop) blocks.push('for (const x of [1]) { test(`dyn ${x}`, async () => { test.skip(process.platform === "win32", "win"); }); }');
      const code = blocks.join("\n");
      const expectedLinux = dynamicLoop || cases.some((item) => item.linux);
      const expectedWin32 = dynamicLoop || cases.some((item) => item.win32);
      expect(specRunsOnPlatform(code, "linux")).toBe(expectedLinux);
      expect(specRunsOnPlatform(code, "win32")).toBe(expectedWin32);
    },
  ), { numRuns: 100 });

  // Real repository specs match their actual platform skip guards.
  const repoSpecs = [
    ["apps/desktop/e2e/todo-dispatch-model.spec.ts", true, true],
    ["apps/desktop/e2e/outpost-owner-data.spec.ts", true, false],
    ["apps/desktop/e2e/electron-launcher-ownership.spec.ts", false, true],
    ["apps/desktop/e2e/electron-native-session-shutdown.spec.ts", true, true],
    ["apps/desktop/e2e/a11y.spec.ts", true, true],
    ["apps/desktop/e2e/macos-window-activation.spec.ts", false, false],
    ["apps/desktop/e2e/windows-titlebar-hover.spec.ts", false, true],
  ];
  for (const [file, linux, win32] of repoSpecs) {
    const text = readFileSync(file, "utf8");
    expect(specRunsOnPlatform(text, "linux"), `${file} on linux`).toBe(linux);
    expect(specRunsOnPlatform(text, "win32"), `${file} on win32`).toBe(win32);
  }

  const annotated = (files) => annotateE2ePlatforms({
    mode: "selected", total: 147, selected: files.map((file) => ({ file, reasons: ["edited spec"] })),
  });
  const todoPlan = annotated(["apps/desktop/e2e/todo-dispatch-model.spec.ts"]);
  expect(planE2eLanes(todoPlan)).toEqual({ linux: [1], windows: [1] });
  expect(e2eFilesForPlatform(todoPlan, "win32").map(({ file }) => file))
    .toEqual(["apps/desktop/e2e/todo-dispatch-model.spec.ts"]);

  const outpostPlan = annotated(["apps/desktop/e2e/outpost-owner-data.spec.ts"]);
  expect(planE2eLanes(outpostPlan)).toEqual({ linux: [1], windows: [] });

  const launcherPlan = annotated(["apps/desktop/e2e/electron-launcher-ownership.spec.ts"]);
  expect(planE2eLanes(launcherPlan)).toEqual({ linux: [], windows: [1] });

  expect(planE2eLanes(annotated([]))).toEqual({ linux: [], windows: [] });
  expect(planE2eLanes({ mode: "full", reason: "application impact has no recorded Playwright spec owner" }))
    .toEqual({ linux: [1, 2, 3, 4], windows: [] });
});

it("treats top-level test.fail as runnable and does not count modifier-form test.fixme as a skipped test declaration", () => {
  // A spec with a skipped test and a runnable test.fail executes on the skipped platform.
  const mixedWithFail = [
    'test("win only", async () => { test.skip(process.platform !== "win32", "win"); });',
    'test.fail("expected failure on all platforms", async () => { expect(1).toBe(2); });',
  ].join("\n");
  expect(specRunsOnPlatform(mixedWithFail, "linux")).toBe(true);
  expect(specRunsOnPlatform(mixedWithFail, "win32")).toBe(true);

  // A helper containing test.fail still triggers the dynamic fail-safe.
  const helperWithFail = [
    'function register() { test.fail("expected", async () => {}); }',
    'test("win only", async () => { test.skip(process.platform !== "win32", "win"); });',
    "register();",
  ].join("\n");
  expect(specRunsOnPlatform(helperWithFail, "linux")).toBe(true);

  // Modifier-form test.fixme without literal test(...) declarations preserves the testCount === 0 fail-safe.
  const modifierFixmeOnly = [
    'test.fixme(process.platform === "win32", "tracked bug");',
    "registerDynamicTests();",
  ].join("\n");
  expect(specRunsOnPlatform(modifierFixmeOnly, "win32")).toBe(true);
  expect(specRunsOnPlatform(modifierFixmeOnly, "linux")).toBe(true);

  // Declaration-form test.fixme("title", fn) still counts as a skipped test declaration.
  const declaredFixmeOnly = 'test.fixme("broken", async () => {});';
  expect(specRunsOnPlatform(declaredFixmeOnly, "win32")).toBe(false);
  expect(specRunsOnPlatform(declaredFixmeOnly, "linux")).toBe(false);
});

it("reports full Windows E2E in the test plan summary whenever ci:windows-e2e or shutdown diagnostics overrides narrowing", () => {
  const fullPlan = { mode: "full", reason: "application impact has no recorded Playwright spec owner" };
  const narrowedSelected = {
    mode: "selected", total: 147,
    selected: [{ file: "apps/desktop/e2e/todo-dispatch-model.spec.ts", platforms: { linux: true, win32: true } }],
  };
  const narrowedNone = {
    mode: "selected", total: 147,
    selected: [{ file: "apps/desktop/e2e/outpost-owner-data.spec.ts", platforms: { linux: true, win32: false } }],
  };
  for (const plan of [fullPlan, narrowedSelected, narrowedNone]) {
    expect(formatWindowsE2eSummary(plan, { windowsDiagnostics: true, windowsE2eRequested: false }))
      .toContain("ci:windows-shutdown-diagnostics");
    expect(formatWindowsE2eSummary(plan, { windowsDiagnostics: true, windowsE2eRequested: true }))
      .toContain("ci:windows-shutdown-diagnostics");
    expect(formatWindowsE2eSummary(plan, { windowsDiagnostics: false, windowsE2eRequested: true }))
      .toContain("all four lanes (`ci:windows-e2e` label)");
  }
  expect(formatWindowsE2eSummary(narrowedSelected)).toBe("1 of 147 files");
  expect(formatWindowsE2eSummary(narrowedNone)).toBe("not selected (no affected Windows spec)");
  expect(formatWindowsE2eSummary(fullPlan)).toContain("skipped on PR for full plan");
});
