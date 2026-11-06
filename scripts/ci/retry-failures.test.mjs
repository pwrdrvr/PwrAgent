import { describe, expect, it } from "vitest";
import { canRetryAfterShutdown, groupUnitRetries, isUnitRunComplete, planE2eRetry, planUnitRetry, verifyE2eRetry, verifyInitialE2eRun, verifyInitialUnitRun, verifyUnitRetry } from "./retry-failures.mjs";

const test = (id, name, state = "failed") => ({ id, name, state });
const report = (tests, overrides = {}) => ({
  complete: true,
  unhandledErrors: 0,
  suites: [{ project: "desktop-main", file: "/repo/example.test.ts", errors: 0, tests }],
  ...overrides,
});

describe("unit retry selection", () => {
  it("requires every scheduled module and test to reach a result", () => {
    const module = { key: "project:file", tests: [{ id: "test", state: "passed", completed: true }] };
    const run = { reason: "failed", planned: [module.key], finished: [module.key], modules: [module], collected: [{ key: module.key, ids: ["test"] }] };
    expect(isUnitRunComplete(run)).toBe(true);
    expect(isUnitRunComplete({ ...run, planned: [module.key, "project:missing"] })).toBe(false);
    expect(isUnitRunComplete({ ...run, finished: [] })).toBe(false);
    expect(isUnitRunComplete({ ...run, reason: "interrupted" })).toBe(false);
    expect(isUnitRunComplete({ ...run, modules: [{ ...module, tests: [{ state: "pending", completed: false }] }] })).toBe(false);
    expect(isUnitRunComplete({ ...run, modules: [{ ...module, tests: [{ state: "skipped", mode: "run", started: false, completed: true }] }] })).toBe(false);
    expect(isUnitRunComplete({ ...run, modules: [{ ...module, tests: [{ id: "test", state: "skipped", mode: "skip", started: true, completed: true }] }] })).toBe(true);
  });

  it("rejects a successful-looking unit command when its report is incomplete", () => {
    const first = { ...report([test("a", "a", "passed")]), reason: "passed" };
    expect(verifyInitialUnitRun(first)).toBe(true);
    expect(verifyInitialUnitRun({ ...first, complete: false })).toBe(false);
    expect(verifyInitialUnitRun({ ...first, suites: [] })).toBe(false);
    expect(verifyInitialUnitRun({ ...first, unhandledErrors: 1 })).toBe(false);
    expect(verifyInitialUnitRun({ ...first, suites: [{ project: "p", file: "f", errors: 0, tests: [test("a", "a", "skipped")] }] })).toBe(false);
  });
  it("selects exactly the initially failed cases, regardless of order", () => {
    for (let count = 1; count <= 20; count++) {
      const cases = Array.from({ length: count }, (_, i) => test(`f${i}`, `case ${i}`));
      const initial = report([test("passed", "passing case", "passed"), ...cases]);
      const plan = planUnitRetry(initial, 20);
      expect(plan.tests.map((entry) => entry.id)).toEqual(cases.map((entry) => entry.id));
      expect(planUnitRetry(report([...initial.suites[0].tests].reverse()), 20).tests.map((entry) => entry.id).sort())
        .toEqual(cases.map((entry) => entry.id).sort());
    }
  });

  it("refuses excess, incomplete, unhandled, and suite-level failures", () => {
    expect(() => planUnitRetry(report(Array.from({ length: 21 }, (_, i) => test(`${i}`, `${i}`))), 20)).toThrow();
    expect(() => planUnitRetry(report([test("a", "a")], { complete: false }), 20)).toThrow();
    expect(() => planUnitRetry(report([test("a", "a")], { unhandledErrors: 1 }), 20)).toThrow();
    expect(() => planUnitRetry({ ...report([]), suites: [{ project: "p", file: "f", errors: 1, tests: [] }] }, 20)).toThrow();
    expect(() => planUnitRetry(report([test("a", "same"), test("b", "same", "passed")]), 20)).toThrow();
  });

  it("accepts a retry only when every selected case passes and no other case runs", () => {
    const plan = planUnitRetry(report([test("a", "a"), test("b", "b")]), 20);
    const pass = report([test("a", "a", "passed"), test("b", "b", "passed")]);
    expect(verifyUnitRetry(plan, pass)).toBe(true);
    expect(verifyUnitRetry(plan, report([test("a", "a", "passed")]))).toBe(false);
    expect(verifyUnitRetry(plan, report([test("a", "a", "passed"), test("b", "b", "skipped")]))).toBe(false);
    expect(verifyUnitRetry(plan, report([...pass.suites[0].tests, test("extra", "extra", "passed")]))).toBe(false);
    expect(verifyUnitRetry(plan, { ...pass, unhandledErrors: 1 })).toBe(false);
  });

  it("batches files only when their name filters cannot select a passing test", () => {
    const first = report([]);
    first.suites = [
      { project: "p", file: "/a", errors: 0, tests: [test("a", "one"), test("pass-a", "other", "passed")] },
      { project: "p", file: "/b", errors: 0, tests: [test("b", "two"), test("pass-b", "safe", "passed")] },
    ];
    const plan = planUnitRetry(first, 20);
    expect(groupUnitRetries(plan, first).map((group) => group.tests.length)).toEqual([2]);
    first.suites[1].tests[1].name = "one";
    expect(groupUnitRetries(plan, first).map((group) => group.tests.length)).toEqual([1, 1]);
  });
});

describe("E2E retry selection", () => {
  it("rejects a successful-looking E2E command when its report is incomplete", () => {
    const first = { status: "passed", complete: true, errors: 0, tests: [{ id: "a", outcome: "expected" }] };
    expect(verifyInitialE2eRun(first)).toBe(true);
    expect(verifyInitialE2eRun({ ...first, complete: false })).toBe(false);
    expect(verifyInitialE2eRun({ ...first, tests: [] })).toBe(false);
    expect(verifyInitialE2eRun({ ...first, tests: [{ id: "a", outcome: "skipped" }] })).toBe(false);
  });
  it("does not reset a shutdown circuit after an abnormal close", () => {
    expect(canRetryAfterShutdown({ schemaVersion: 1, consecutiveAbnormalCloses: 0, open: false })).toBe(true);
    expect(canRetryAfterShutdown({ schemaVersion: 1, consecutiveAbnormalCloses: 1, open: false })).toBe(false);
    expect(canRetryAfterShutdown({ schemaVersion: 1, consecutiveAbnormalCloses: 2, open: true })).toBe(false);
    expect(canRetryAfterShutdown({})).toBe(false);
  });
  it("selects exactly the failed IDs, up to the slice budget", () => {
    for (let count = 1; count <= 20; count++) {
      const tests = Array.from({ length: count }, (_, i) => ({ id: `id${i}`, outcome: "unexpected" }));
      const first = { status: "failed", complete: true, errors: 0, tests: [...tests, { id: "ok", outcome: "expected" }] };
      const plan = planE2eRetry(first, { status: "failed", failedTests: tests.map((item) => item.id) }, 20);
      expect(plan.tests).toEqual(tests);
      expect(verifyE2eRetry(plan, { status: "passed", complete: true, errors: 0, tests: tests.map((item) => ({ ...item, outcome: "expected" })) })).toBe(true);
      expect(verifyE2eRetry(plan, { status: "passed", complete: true, errors: 0, tests: [] })).toBe(false);
    }
  });

  it("rejects unrun tests, run errors, and excess failures", () => {
    const first = { status: "failed", complete: true, errors: 0, tests: [{ id: "a", outcome: "unexpected" }] };
    expect(() => planE2eRetry(first, { status: "failed", failedTests: ["a", "unrun"] }, 20)).toThrow();
    expect(() => planE2eRetry({ ...first, errors: 1 }, { status: "failed", failedTests: ["a"] }, 20)).toThrow();
    expect(() => planE2eRetry({ ...first, complete: false }, { status: "failed", failedTests: ["a"] }, 20)).toThrow();
    const tests = Array.from({ length: 21 }, (_, i) => ({ id: `${i}`, outcome: "unexpected" }));
    expect(() => planE2eRetry({ ...first, tests }, { status: "failed", failedTests: tests.map((item) => item.id) }, 20)).toThrow();
  });
});
