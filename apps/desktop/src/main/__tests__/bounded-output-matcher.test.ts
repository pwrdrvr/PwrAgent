import { describe, expect, it } from "vitest";
import {
  createBoundedOutputMatcher,
} from "../../../e2e/fixtures/bounded-output-matcher";

describe("bounded process output matcher", () => {
  const marker = "quit requested while confirmation is open";

  it("recognizes markers before trimming oversized chunks", () => {
    const matcher = createBoundedOutputMatcher(marker);

    matcher.inspect(`prefix ${marker}${" later output".repeat(100)}`);

    expect(matcher.matched()).toBe(true);
  });

  it("recognizes markers split across chunks", () => {
    const matcher = createBoundedOutputMatcher(marker);

    matcher.inspect("prefix quit requested while conf");
    matcher.inspect(`irmation is open${" later output".repeat(100)}`);

    expect(matcher.matched()).toBe(true);
  });
});
