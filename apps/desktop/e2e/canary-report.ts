// Failure text for the desktop E2E pre-flight canary, split out so the
// reporting is unit-testable without launching Electron.

export function describeCanaryFailure(params: {
  timeoutMs: number;
  runnerName?: string;
  detail: string;
  /**
   * Whether the canary gave up waiting, as opposed to the harness
   * rejecting with a diagnosis of its own.
   *
   * The distinction decides which story gets told, and telling the wrong
   * one is expensive. A hang means a sick guest, and the right response
   * is to recycle it. A rejection means the harness already knows what
   * is wrong — a missing onboarding seed, say — and recycling the guest
   * would be a wasted trip that fixes nothing. Defaults to `true` to
   * preserve the original behavior for callers that don't distinguish.
   */
  timedOut?: boolean;
}): string {
  const timedOut = params.timedOut ?? true;
  const preamble = timedOut
    ? [
      `Desktop E2E pre-flight timed out after ${params.timeoutMs}ms, before any test ran.`,
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
    ]
    : [
      "Desktop E2E pre-flight failed before any test ran.",
      "",
      "The canary launches one app through the SAME harness every spec uses, so",
      "this would have failed every spec in turn. The harness rejected with a",
      "specific diagnosis rather than hanging, so read the error below — it is",
      "the actual problem, and it is NOT the guest needing to be recycled.",
      "",
      params.runnerName
        ? `  Runner: ${params.runnerName}`
        : "  Runner: (RUNNER_NAME unset — likely a local run)",
    ];

  return [...preamble, "", `Underlying error: ${params.detail}`].join("\n");
}
