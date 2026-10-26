import { performance } from "node:perf_hooks";
import { aroundEach } from "vitest";

// Opt in with PWRAGENT_TEST_PHASES=1. Elapsed waits include React work and
// polling; synchronous query/callback time is reported separately, not added.
const enabled = process.env.PWRAGENT_TEST_PHASES === "1";
const phases = new Map<string, { calls: number; ms: number }>();
export function record(phase: string, ms: number) {
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

