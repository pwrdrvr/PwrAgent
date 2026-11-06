import type { TestInfo } from "@playwright/test";

export function installShutdownDiagnostics(options: {
  outputDir: string;
  currentTest: () => TestInfo | undefined;
  captureAfterMs?: number;
  scope?: "worker" | "global-setup";
}): void;
