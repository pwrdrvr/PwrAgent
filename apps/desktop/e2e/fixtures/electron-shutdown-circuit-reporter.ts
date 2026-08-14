import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import {
  ELECTRON_SHUTDOWN_CIRCUIT_ERROR_NAME,
} from "./electron-shutdown-policy";

type ReporterOptions = {
  stopRun?: () => void;
};

/** Stop Playwright gracefully so reporters finish and mark the shard failed. */
function interruptPlaywrightRun(): void {
  process.kill(process.pid, "SIGINT");
}

export default class ElectronShutdownCircuitReporter implements Reporter {
  private readonly stopRun: () => void;
  private circuitTripped = false;

  constructor(options: ReporterOptions = {}) {
    this.stopRun = options.stopRun ?? interruptPlaywrightRun;
  }

  onTestEnd(_test: TestCase, result: TestResult): void {
    if (
      this.circuitTripped
      || !result.errors.some((error) =>
        [error.message, error.stack, error.value].some((detail) =>
          detail?.includes(ELECTRON_SHUTDOWN_CIRCUIT_ERROR_NAME),
        ),
      )
    ) {
      return;
    }
    this.circuitTripped = true;
    this.stopRun();
  }

  async onEnd(
    _result: FullResult,
  ): Promise<{ status: "failed" } | undefined> {
    return this.circuitTripped ? { status: "failed" } : undefined;
  }
}
