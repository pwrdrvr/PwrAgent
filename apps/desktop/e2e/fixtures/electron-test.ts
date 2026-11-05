import { test as base, type TestInfo } from "@playwright/test";
import { ElectronFailureDiagnostics } from "./electron-failure-diagnostics";

export * from "@playwright/test";

const attempts = new WeakMap<TestInfo, ElectronFailureDiagnostics>();

export const test = base.extend<{ mainProcessTiming: void }>({
  mainProcessTiming: [async ({ playwright: _playwright }, use, testInfo) => {
    const diagnostics = new ElectronFailureDiagnostics();
    attempts.set(testInfo, diagnostics);
    try {
      await use();
    } finally {
      try {
        await diagnostics.attach(testInfo);
      } finally {
        attempts.delete(testInfo);
      }
    }
  }, { auto: true }],
});

/** Global setup and unit callers do not have a Playwright attempt. */
export function registerMainProcessTiming(read: () => Promise<unknown>): () => Promise<unknown> {
  let testInfo: TestInfo;
  try {
    testInfo = base.info();
  } catch {
    return async () => undefined;
  }
  const diagnostics = attempts.get(testInfo);
  if (!diagnostics) throw new Error("Electron E2E specs must import test from fixtures/electron-test");
  return diagnostics.register(read);
}
