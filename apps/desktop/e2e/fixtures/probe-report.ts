/**
 * Run a failure-time diagnostic without letting it replace the failure.
 *
 * Every spec-level probe here reads the live page, and it runs precisely
 * when something has already gone wrong — including the cases where the
 * page is closing or the renderer is wedged. A probe that rejects inside a
 * `.catch()` handler destroys the assertion error that handler was written
 * to explain: the `new Error(..., { cause })` never gets constructed, and
 * CI reports "Target page, context or browser has been closed" in place of
 * the actual expectation that failed.
 *
 * So a probe's own failure is reported as text, in the slot its output
 * would have occupied. `dom-trajectory.ts` already guards its `read()` this
 * way; this is the same rule for the probes that live in the specs.
 */
export async function probeReport(
  describe: () => Promise<string>,
): Promise<string> {
  try {
    return await describe();
  } catch (error) {
    return `  <diagnostic unavailable: ${
      error instanceof Error ? error.message : String(error)
    }>`;
  }
}

/**
 * Cap on one diagnostic probe.
 *
 * Neither `page.evaluate` nor `electronApp.evaluate` takes a timeout, so each
 * is bounded only by Playwright's 30s test timeout — and these run precisely
 * when something has already gone wrong, including the case where the process
 * being probed is the wedged one. Uncapped, a hung probe swallows the report
 * it was meant to produce and the run fails with a bare "Test timeout of
 * 30000ms exceeded", which says strictly less than the message it replaced.
 *
 * Lives here rather than beside one caller: `probeReport` is already the
 * shared answer to "a diagnostic must not replace the failure", and a
 * time-boxed probe is the same rule for the case where the probe never
 * answers at all.
 */
export const PROBE_TIMEOUT_MS = 2_000;

/**
 * Both probes answer with a string and never reject, so a probe that loses
 * this race simply stays unsettled — there is no rejection left to go
 * unhandled.
 */
export async function withProbeTimeout(
  describe: () => Promise<string>,
  label: string,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      describe(),
      new Promise<string>((resolve) => {
        timer = setTimeout(
          () => resolve(`${label} did not answer within ${PROBE_TIMEOUT_MS}ms`),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
