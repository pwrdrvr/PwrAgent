import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatInvocationIdentity } from "../tool-output-incident-insights";
import {
  displayText,
  expectClusterPrefix,
  expectMiddleCut,
} from "../../../../../../../../packages/shared/src/__tests__/display-text-arbitraries";

/**
 * `formatInvocationIdentity`'s comment: invocations share long prefixes, so
 * the case-row label keeps a short lead and elides the middle of the rest,
 * keeping the part that differs near the end. Both parts come from the
 * command flattened to one line, and every cut lands between characters.
 */
describe("formatInvocationIdentity properties", () => {
  it("keeps a lead prefix and a middle-elided detail on whole characters", () => {
    fc.assert(fc.property(displayText(80), fc.integer({ min: 12, max: 60 }), (command, budget) => {
      const flattened = command.replace(/\s+/g, " ").trim();
      const { detail, lead } = formatInvocationIdentity(command, budget);
      expectClusterPrefix(lead, flattened);
      const rest = flattened.slice(lead.length).trim();
      expectMiddleCut(rest, detail, { ellipsis: "…", maxLength: Math.max(12, budget - lead.length) });
    }));
  });

  it("keeps a ZWJ emoji whole at the head cut", () => {
    const { detail } = formatInvocationIdentity(`${"x".repeat(14)}👩\u200d💻${"y".repeat(40)}`, 38);
    expect(detail).toBe(`${"x".repeat(14)}…${"y".repeat(22)}`);
  });
});
