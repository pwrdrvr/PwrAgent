import type { ThreadToolInvocationRecord } from "../contracts/normalized-app-server";
import { describe, expect, it } from "vitest";
import { isFlaggedToolInvocation } from "../contracts/tool-output-incidents";

describe("isFlaggedToolInvocation", () => {
  it("flags a large result even when nothing marked the row", () => {
    /* Threads whose turns predate the detectors carry `noisy = 0` on every
       row. Trusting the flag alone showed an empty explorer next to a fully
       populated turn strip — 575 oversized calls in one real thread, none of
       them listed. */
    expect(isFlaggedToolInvocation({ noisy: false, outputChars: 20_000 }))
      .toBe(true);
  });

  it("keeps trusting the stored flag for patterns a single row cannot show", () => {
    /* Polling is a pattern across invocations: a 200-char row is only a case
       because of the fifty rows around it, which the size test cannot see. */
    expect(isFlaggedToolInvocation({ noisy: true, outputChars: 200 }))
      .toBe(true);
  });

  it("leaves an ordinary small result alone", () => {
    expect(isFlaggedToolInvocation({ noisy: false, outputChars: 19_999 }))
      .toBe(false);
  });

  it("uses the operator's effective large-output threshold", () => {
    const invocation = { noisy: false, outputChars: 24_000 };

    expect(isFlaggedToolInvocation(invocation, 30_000)).toBe(false);
    expect(isFlaggedToolInvocation(invocation, 10_000)).toBe(true);
  });

  it("re-evaluates size-derived flags against the operator's current threshold", () => {
    /* This row was marked under the original 10%-of-cap default. Raising the
       setting to 50% must stop counting it as a case; otherwise the saved
       flag makes the threshold control ineffective for existing threads. */
    const invocation: Pick<
      ThreadToolInvocationRecord,
      "noisy" | "noisyReason" | "outputChars"
    > = {
      noisy: true,
      noisyReason: "large-output",
      outputChars: 8_000,
    };

    expect(isFlaggedToolInvocation(invocation, 20_000)).toBe(false);
  });

  it("preserves pattern-derived flags below the size threshold", () => {
    const invocation: Pick<
      ThreadToolInvocationRecord,
      "noisy" | "noisyReason" | "outputChars"
    > = {
      noisy: true,
      noisyReason: "repeat-polling-output",
      outputChars: 200,
    };

    expect(isFlaggedToolInvocation(invocation, 20_000)).toBe(true);
  });
});
