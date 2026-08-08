// Failure text for the desktop E2E pre-flight canary, split out so the
// reporting is unit-testable without launching Electron.

export function describeCanaryFailure(params: {
  timeoutMs: number;
  runnerName?: string;
  detail: string;
}): string {
  return [
    `Desktop E2E pre-flight failed after ${params.timeoutMs}ms, before any test ran.`,
    "",
    "The canary launches one app through the SAME harness every spec uses, so",
    "if it cannot get a usable window here, no spec can. The suite is failing",
    "fast on purpose rather than spending the job's whole time budget timing",
    "out one test at a time — which reads like a regression in whichever spec",
    "happens to sort first (currently a11y.spec.ts, which is innocent).",
    "",
    "Known shape of this on CI (2026-08-07, traced): Electron LAUNCHES and is",
    "controllable — the trace records `Launch electron` completing — and then",
    "`Wait for event \"window\"` never returns. The process layer is healthy and",
    "the window layer is not. Every spec then dies on its own 30s timeout with",
    "no teardown line, because no app object is ever handed back.",
    "",
    "This is a property of the machine, not of the branch. The same commit has",
    "passed on a healthy runner and failed on an affected one within the same",
    "hour. Before treating it as a code regression, check whether other recent",
    "runs failed the same way on this same runner.",
    "",
    params.runnerName
      ? `  Runner: ${params.runnerName}`
      : "  Runner: (RUNNER_NAME unset — likely a local run)",
    "",
    "A persistent runner in this state does not recover on its own; it needs",
    "an operator to recycle the guest.",
    "",
    `Underlying error: ${params.detail}`,
  ].join("\n");
}
