import type { TestInfo } from "@playwright/test";

export function installShutdownDiagnostics(options: {
  outputDir: string;
  currentTest: () => TestInfo;
  captureAfterMs?: number;
}): void;
