import fc from "fast-check";
import { expect, it } from "vitest";
import { aggregateSlices, expectedSlices } from "./flake-report.mjs";
import { a11ySpec, playwrightListPath, scheduleImpact } from "./pr-test-impact.mjs";

const full = { mode: "full", reason: "fixture" };
const unit = (main, renderer) => ({
  mode: "selected",
  selected: [
    ...Array.from({ length: main }, () => ({ project: "desktop-main" })),
    ...Array.from({ length: renderer }, () => ({ project: "desktop-renderer" })),
  ],
});
const e2e = (count, audit) => ({
  mode: "selected",
  selected: [
    ...Array.from({ length: count }, (_, index) => ({ file: `apps/desktop/e2e/spec-${index}.spec.ts` })),
    ...(audit ? [{ file: a11ySpec }] : []),
  ],
});

it("schedules exactly the work the suites and platform policy require", () => {
  fc.assert(fc.property(fc.record({
    allPlatforms: fc.boolean(),
    windowsFull: fc.boolean(),
    auditRequested: fc.boolean(),
    audit: fc.boolean(),
    fullUnit: fc.boolean(),
    fullE2e: fc.boolean(),
    mainFiles: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 660 })),
    rendererFiles: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 660 })),
    specs: fc.nat(7),
    diagnostics: fc.boolean(),
    e2eOnly: fc.boolean(),
  }), (state) => {
    const { allPlatforms, windowsFull, auditRequested, fullUnit, fullE2e, mainFiles, rendererFiles, specs, audit, diagnostics, e2eOnly } = state;
    const plan = {
      unit: fullUnit ? full : unit(mainFiles, rendererFiles),
      e2e: fullE2e ? full : e2e(specs, audit),
    };
    const samples = diagnostics ? 3 : 1;
    const schedule = scheduleImpact(plan, { allPlatforms, windowsFull: windowsFull || diagnostics, auditRequested, e2eOnly });
    const nativeCount = specs + Number(allPlatforms && audit);
    const counts = {
      "unit-linux": mainFiles + rendererFiles,
      "unit-windows-main": mainFiles,
      "unit-windows-renderer": rendererFiles,
      ...(allPlatforms ? { "unit-macos": mainFiles + rendererFiles } : {}),
    };
    const expected = expectedSlices(samples).filter(({ kind, platform, lane }) => {
      if (kind === "unit") return Object.hasOwn(counts, `unit-${platform}`)
        && (fullUnit || (lane - 1) * 150 < counts[`unit-${platform}`]);
      if (platform === "linux-a11y") return auditRequested || (fullE2e ? allPlatforms : audit);
      if (platform === "windows") return windowsFull || diagnostics || ((allPlatforms || e2eOnly) && fullE2e)
        || (!fullE2e && nativeCount > 0 && lane === 1);
      if (platform === "macos") return allPlatforms && (fullE2e || (nativeCount > 0 && lane === 1));
      return fullE2e || (specs > 0 && lane === 1);
    });
    const report = aggregateSlices({ slices: [], samples, lanes: schedule.lanes });
    expect(report.missingSlices).toEqual(expected);
    if (!fullE2e) {
      expect(schedule.e2e.selected).toEqual(e2e(specs, false).selected);
      expect(schedule.nativeE2e.selected).toEqual(e2e(specs, allPlatforms && audit).selected);
    }
  }));
});

it("collects affected specs on Windows even when their runtime controls whether they skip", () => {
  const plan = { unit: unit(0, 0), e2e: e2e(1, false) };
  const policy = { allPlatforms: false, windowsFull: false, auditRequested: false };
  const scheduled = scheduleImpact(plan, policy);
  expect(scheduled.lanes["unit-linux"]).toEqual([]);
  expect(scheduled.lanes["e2e-windows"]).toEqual([1]);
  expect(scheduled.nativeE2e).toEqual(plan.e2e);
  expect(scheduled.windowsMode).toBe("selected");
  expect(scheduleImpact(plan, { ...policy, windowsFull: true }).windowsMode).toBe("full");
});

it("does not silently reinterpret filename syntax as a Playwright test title or location", () => {
  expect(playwrightListPath("apps/desktop/e2e/sub/a+b.spec.ts")).toBe("sub/a+b.spec.ts");
  for (const name of ["a\nb.spec.ts", "a>b.spec.ts", "#note.spec.ts", "[project].spec.ts", "a:b.spec.ts"]) {
    expect(playwrightListPath(`apps/desktop/e2e/${name}`)).toBeUndefined();
  }
});
