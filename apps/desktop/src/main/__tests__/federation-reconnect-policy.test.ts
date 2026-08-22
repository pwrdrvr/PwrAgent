import { describe, expect, it } from "vitest";
import { federationReconnectDelayMs } from "../federation/federation-reconnect-policy";

describe("federation reconnect policy", () => {
  it("backs off from one second and caps every later attempt at thirty seconds", () => {
    expect(
      Array.from({ length: 8 }, (_, attempt) =>
        federationReconnectDelayMs(attempt)
      ),
    ).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      30_000,
      30_000,
      30_000,
    ]);
  });
});
