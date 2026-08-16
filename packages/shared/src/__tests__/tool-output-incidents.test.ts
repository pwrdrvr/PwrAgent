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
});
