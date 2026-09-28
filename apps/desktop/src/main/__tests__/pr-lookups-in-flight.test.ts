import { describe, expect, it } from "vitest";
import { PrLookupsInFlight } from "../pr-status/pr-lookups-in-flight";

describe("PR lookups in flight", () => {
  it("holds a PR until every overlapping lookup releases it", () => {
    const inFlight = new PrLookupsInFlight();
    const first = inFlight.begin(["github.com/acme/widgets#1", "github.com/acme/widgets#2"], 1_000);
    const second = inFlight.begin(["github.com/acme/widgets#1"], 2_000);
    expect(inFlight.startedAt("github.com/acme/widgets#1")).toBe(2_000);
    expect(inFlight.startedAt("github.com/acme/widgets#2")).toBe(1_000);

    second();
    expect(inFlight.startedAt("github.com/acme/widgets#1")).toBe(2_000);
    first();
    expect(inFlight.startedAt("github.com/acme/widgets#1")).toBeUndefined();
    expect(inFlight.startedAt("github.com/acme/widgets#2")).toBeUndefined();
  });

  it("ignores a second release and a PR listed twice", () => {
    const inFlight = new PrLookupsInFlight();
    const held = inFlight.begin(["github.com/acme/widgets#1"], 1_000);
    const release = inFlight.begin(["github.com/acme/widgets#1", "github.com/acme/widgets#1"], 1_500);
    release();
    release();
    expect(inFlight.startedAt("github.com/acme/widgets#1")).toBe(1_500);
    held();
    expect(inFlight.startedAt("github.com/acme/widgets#1")).toBeUndefined();
  });
});
