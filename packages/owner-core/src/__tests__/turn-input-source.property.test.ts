import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerThreadMessageOrigin } from "@pwragent/shared/contracts/normalized-app-server";
import { combinedTurnInputSource, resolveTurnInputSource, type TurnInputSource } from "../turn-input-source";

describe("turn input source", () => {
  const deliveries = [
    [{ turnInputSource: "desktop" }, "desktop"],
    [{ turnInputSource: "federation" }, "federation"],
    [{ messageOrigin: { kind: "messaging" } }, "messaging"],
    [{ messageOrigin: { kind: "agent", operatorApproved: true } }, "agent"],
    [{ messageOrigin: { kind: "sub-agent" } }, "agent"],
    [{ messageOrigin: { kind: "pwragent" } }, "automation"],
    [{ origin: "scheduled", messageOrigin: { kind: "messaging" } }, "automation"],
    [{ origin: "manual" }, "unknown"],
  ] as const satisfies readonly (readonly [Parameters<typeof resolveTurnInputSource>[0], TurnInputSource])[];

  it("uses the original delivery class and requires complete evidence for any grouped source", () => {
    fc.assert(fc.property(fc.array(fc.constantFrom(...deliveries)), (inputs) => {
      for (const [delivery, expected] of inputs) expect(resolveTurnInputSource(delivery)).toBe(expected);
      const kinds = new Set(inputs.map(([, expected]) => expected));
      const expected = kinds.size === 0 || kinds.has("unknown") ? "unknown"
        : kinds.size === 1 ? inputs[0]![1] : "mixed";
      expect(combinedTurnInputSource(inputs.map(([delivery]) => delivery))).toBe(expected);
      expect(combinedTurnInputSource(inputs.toReversed().map(([delivery]) => delivery))).toBe(expected);
    }));
  });

  it("keeps a legacy batch with a missing member unknown, even if its display origin is known", () => {
    const agent = { kind: "agent", causalMessagingAmbiguous: true } satisfies AppServerThreadMessageOrigin;
    expect(resolveTurnInputSource({ messageOrigin: agent, agentMessages: [{ origin: agent }, {}] })).toBe("unknown");
    expect(resolveTurnInputSource({ messageOrigin: agent })).toBe("agent");
  });
});
