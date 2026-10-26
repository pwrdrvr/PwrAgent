import * as rtl from "@testing-library/react";
import { createElement, Profiler } from "react";
import { aroundEach } from "vitest";

// Opt in with PWRAGENT_TEST_PHASES=1. Elapsed waits include React work and
// polling; synchronous query/callback time is reported separately, not added.
const enabled = process.env.PWRAGENT_TEST_PHASES === "1";
const phases = new Map<string, { calls: number; ms: number }>();
function record(phase: string, ms: number) {
  const value = phases.get(phase) ?? { calls: 0, ms: 0 };
  value.calls += 1;
  value.ms += ms;
  phases.set(phase, value);
}

export function probe<T>(phase: string, run: () => T): T {
  if (!enabled) return run();
  const start = performance.now();
  const finish = () => {
    record(phase, performance.now() - start);
  };
  try {
    const result = run();
    if (result instanceof Promise) return result.finally(finish) as T;
    finish();
    return result;
  } catch (error) {
    finish();
    throw error;
  }
}

if (enabled) {
  aroundEach(async (runTest, { task }) => {
    phases.clear();
    const start = performance.now();
    const getComputedStyle = window.getComputedStyle;
    window.getComputedStyle = (...args) => probe("computed-style", () => getComputedStyle(...args));
    try {
      await runTest();
    } finally {
      window.getComputedStyle = getComputedStyle;
      console.log("TEST_PHASES", JSON.stringify({ test: task.name,
        total: Math.round(performance.now() - start),
        phases: Object.fromEntries([...phases].map(([key, value]) => [key,
          { calls: value.calls, ms: Math.round(value.ms) }])),
      }));
    }
  });
}

function queries<T extends object>(value: T): T {
  if (!enabled) return value;
  return new Proxy(value, {
    get(target, key, receiver) {
      const method = Reflect.get(target, key, receiver);
      if (typeof method !== "function" || typeof key !== "string" || !/^(get|query|find).*By/.test(key)) return method;
      return (...args: unknown[]) => probe(key.startsWith("find") ? "find" : "query", () => Reflect.apply(method, target, args));
    },
  });
}

export * from "@testing-library/react";
export const screen = queries(rtl.screen);
export const within: typeof rtl.within = (...args) => queries(rtl.within(...args));
export const render = new Proxy(rtl.render, {
  apply(target, receiver, args) {
    const [ui, options] = args;
    return queries(probe("render", () => Reflect.apply(target, receiver, [enabled
      ? createElement(Profiler, { id: "test", onRender: (_id, _phase, duration) => record("react", duration) }, ui)
      : ui, options])));
  },
});
export const renderHook = new Proxy(rtl.renderHook, {
  apply: (target, receiver, args) => probe("render-hook", () => Reflect.apply(target, receiver, args)),
});
export const waitFor: typeof rtl.waitFor = (callback, options) =>
  probe("wait", () => rtl.waitFor(() => probe("wait-callback", callback), options));
