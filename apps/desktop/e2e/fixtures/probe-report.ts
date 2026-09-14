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
