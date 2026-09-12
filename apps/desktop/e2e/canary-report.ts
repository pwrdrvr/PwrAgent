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
   * is to recycle it. A rejection means the launch failed with something
   * to read instead of stalling — either a harness diagnosis (a missing
   * onboarding seed, say) or a failed Playwright/Electron round trip.
   * Recycling the guest fixes neither, which is all this flag claims:
   * the two rejection kinds still want different responses from each
   * other, and the message says so. Defaults to `true` to preserve the
   * original behavior for callers that don't distinguish.
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
      "this would have failed every spec in turn. The harness rejected rather",
      "than hanging, so start from the error below — whatever it says, it is",
      "NOT the guest needing to be recycled.",
      "",
      "Two unlike things reject here, and they want opposite responses:",
      "",
      "  - A harness DIAGNOSIS is deterministic: a missing onboarding seed, the",
      "    first-run wizard holding the window. It names what to fix and will",
      "    fail the same way on every lane and every runner.",
      "  - A failed Playwright <-> Electron ROUND TRIP is not deterministic and",
      "    diagnoses nothing. \"Resulting promise was garbage collected\" and",
      "    \"Target closed\" describe the RPC, not the app. Observed here on",
      "    2026-09-11: one lane died in pre-flight while the other three passed",
      "    the same commit — one of them on the same runner, seconds later —",
      "    and the failed lane passed on retry.",
      "",
      "So before reading this as a branch defect, check whether the suite's",
      "other lanes passed on this commit. If they did, retry this one.",
      "",
      params.runnerName
        ? `  Runner: ${params.runnerName}`
        : "  Runner: (RUNNER_NAME unset — likely a local run)",
    ];

  return [...preamble, "", `Underlying error: ${params.detail}`].join("\n");
}
