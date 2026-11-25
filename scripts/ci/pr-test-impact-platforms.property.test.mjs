import { readFileSync } from "node:fs";
import fc from "fast-check";
import { expect, it } from "vitest";
import { annotateE2ePlatforms, e2eFilesForPlatform, planE2eLanes, specRunsOnPlatform } from "./pr-test-impact.mjs";

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
