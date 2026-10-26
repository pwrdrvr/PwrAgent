import * as rtl from "@testing-library/react";
import { aroundEach } from "vitest";

// Opt in with PWRAGENT_TEST_PHASES=1. Elapsed waits include React work and
// polling; synchronous query/callback time is reported separately, not added.
const enabled = process.env.PWRAGENT_TEST_PHASES === "1";
const phases = new Map<string, { calls: number; ms: number }>();

export function probe<T>(phase: string, run: () => T): T {
  if (!enabled) return run();
  const start = performance.now();
  const finish = () => {
    const value = phases.get(phase) ?? { calls: 0, ms: 0 };
    value.calls += 1;
    value.ms += performance.now() - start;
    phases.set(phase, value);
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
    try {
      await runTest();
    } finally {
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
export const render: typeof rtl.render = (...args: Parameters<typeof rtl.render>) =>
  queries(probe("render", () => rtl.render(...args)));
export const waitFor: typeof rtl.waitFor = (callback, options) =>
  probe("wait", () => rtl.waitFor(() => probe("wait-callback", callback), options));
