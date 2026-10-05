import { describe, expect, it } from "vitest";
import {
  decisionCameraCueAvailability,
  decisionLocalEndpointProblem,
  normalizeDecisionLocalEndpoint,
  resolveDecisionModelSettings,
} from "../decision-models";

describe("decision models", () => {
  it("defaults to no decision model, with the local one ready at PwrSuiteLab's Clef address", () => {
    expect(resolveDecisionModelSettings(undefined)).toEqual({
      model: "off", localEndpoint: "http://127.0.0.1:8787", localModel: "clef-flash", jevModel: "jev-latest", cameraCues: true,
    });
  });

  it("accepts only a bare server address on this Mac as the local endpoint", () => {
    for (const ok of ["http://127.0.0.1:8787", "http://localhost:9911/", "https://[::1]:8443", "http://clef.localhost"]) {
      expect(decisionLocalEndpointProblem(ok), ok).toBeUndefined();
    }
    expect(decisionLocalEndpointProblem("http://192.168.1.20:8787")).toContain("on this Mac");
    expect(decisionLocalEndpointProblem("https://api.typesafe.ai")).toContain("on this Mac");
    // A lookalike that only starts with a loopback label still resolves elsewhere.
    expect(decisionLocalEndpointProblem("http://127.0.0.1.example.com")).toContain("on this Mac");
    expect(decisionLocalEndpointProblem("http://127.0.0.1:8787/decide")).toContain("without a path");
    expect(decisionLocalEndpointProblem("http://user:pass@127.0.0.1:8787")).toContain("user name");
    expect(decisionLocalEndpointProblem("ftp://127.0.0.1")).toContain("http");
    expect(decisionLocalEndpointProblem("127.0.0.1:8787")).toBeDefined();
    expect(normalizeDecisionLocalEndpoint(" http://LOCALHOST:9911/ ")).toBe("http://localhost:9911");
    expect(normalizeDecisionLocalEndpoint("http://10.0.0.2:8787")).toBeUndefined();
  });

  it("offers camera cues only through the local model", () => {
    // Nothing set up offers no camera.
    expect(decisionCameraCueAvailability({})).toMatchObject({ available: false, reason: expect.stringContaining("Choose a decision model") });
    expect(decisionCameraCueAvailability({ model: "local" })).toEqual({ available: true, endpoint: "http://127.0.0.1:8787", model: "clef-flash" });
    expect(decisionCameraCueAvailability({ model: "local", local: { endpoint: "http://localhost:9911", model: "clef-pro" } }))
      .toEqual({ available: true, endpoint: "http://localhost:9911", model: "clef-pro" });
    expect(decisionCameraCueAvailability({ model: "jev" })).toMatchObject({ available: false, reason: expect.stringContaining("stay on this Mac") });
    expect(decisionCameraCueAvailability({ model: "off" })).toMatchObject({ available: false });
    expect(decisionCameraCueAvailability({ model: "local", cameraCues: false })).toMatchObject({ available: false, reason: expect.stringContaining("off") });
  });
});
