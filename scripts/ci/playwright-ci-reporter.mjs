import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export default class CiRetryReporter {
  errors = 0;

  onBegin(_config, suite) {
    this.suite = suite;
  }

  onError() {
    this.errors++;
  }

  onEnd(result) {
    const destination = process.env.PWRAGENT_CI_TEST_REPORT;
    if (!destination) throw new Error("PWRAGENT_CI_TEST_REPORT is required");
    mkdirSync(path.dirname(destination), { recursive: true });
    const tests = this.suite?.allTests().map((test) => ({
      id: test.id,
      name: test.titlePath().filter(Boolean).join(" > "),
      outcome: test.outcome(),
      completed: test.results.length > 0
        && test.results.every((attempt) => attempt.status !== "interrupted")
        && (test.outcome() !== "skipped" || test.expectedStatus === "skipped"),
    })) ?? [];
    writeFileSync(destination, JSON.stringify({
      status: result.status,
      complete: result.status !== "interrupted" && tests.length > 0 && tests.every((test) => test.completed),
      errors: this.errors,
      tests,
    }));
  }
}
