import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isValidProfileName,
  provisionPairedProfiles,
  type PairedProfileApi,
} from "../provisionPairedProfiles";

/**
 * Mock factory: a `PairedProfileApi` that records the order of IPC
 * calls so the test can assert the precise sequence per profile name.
 * Each handler returns a deterministic response shaped like the real
 * IPC; tests that want to simulate a failure replace the per-call mock
 * via `.mockRejectedValueOnce` after construction.
 */
function makeApi(): {
  api: PairedProfileApi;
  createPwrAgentProfile: ReturnType<typeof vi.fn>;
  createCodexAuthProfile: ReturnType<typeof vi.fn>;
  setPwrAgentProfileCodexProfile: ReturnType<typeof vi.fn>;
  callLog: string[];
} {
  const callLog: string[] = [];
  const createPwrAgentProfile = vi.fn(async (request: { profile: string }) => {
    callLog.push(`pwragent:${request.profile}`);
    return {
      profile: request.profile,
      profileDir: `/tmp/pwragent/profiles/${request.profile}`,
      created: true,
    };
  });
  const createCodexAuthProfile = vi.fn(async (request: { profile: string }) => {
    callLog.push(`codex:${request.profile}`);
    return {
      profile: request.profile,
      codexHome: `/tmp/codex/auth-profiles/${request.profile}`,
      created: true,
    };
  });
  const setPwrAgentProfileCodexProfile = vi.fn(
    async (request: { profile: string; codexProfile: string }) => {
      callLog.push(`pair:${request.profile}↔${request.codexProfile}`);
      return {
        profile: request.profile,
        codexProfile: request.codexProfile,
      };
    },
  );
  return {
    api: {
      createPwrAgentProfile,
      createCodexAuthProfile,
      setPwrAgentProfileCodexProfile,
    },
    createPwrAgentProfile,
    createCodexAuthProfile,
    setPwrAgentProfileCodexProfile,
    callLog,
  };
}

describe("isValidProfileName", () => {
  it.each([
    ["pwragent", true],
    ["work", true],
    ["a", true],
    ["0", true],
    ["personal-2024", true],
    ["my_profile", true],
    ["a".repeat(31), true],
    ["a".repeat(32), false],
    ["", false],
    ["-leading-hyphen", false],
    ["_leading-underscore", false],
    ["UPPERCASE", false],
    ["has space", false],
    ["has.dot", false],
  ])("%j -> %s", (name, expected) => {
    expect(isValidProfileName(name)).toBe(expected);
  });
});

describe("provisionPairedProfiles", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("isolated path: provisions one paired profile in exact IPC order", async () => {
    const mock = makeApi();
    const created = await provisionPairedProfiles(mock.api, ["pwragent"]);
    expect(created).toEqual(["pwragent"]);
    expect(mock.callLog).toEqual([
      "pwragent:pwragent",
      "codex:pwragent",
      "pair:pwragent↔pwragent",
    ]);
  });

  it("seeds onboarding.completed=true on the new PwrAgent profile", async () => {
    // The flag must be set so the wizard doesn't re-fire when the
    // operator auto-switches into the freshly-created profile.
    const mock = makeApi();
    await provisionPairedProfiles(mock.api, ["solo"]);
    expect(mock.createPwrAgentProfile).toHaveBeenCalledWith({
      profile: "solo",
      seedOnboardingCompleted: true,
    });
  });

  it("seeds onboarding on every name in a multiple-mode batch", async () => {
    const mock = makeApi();
    await provisionPairedProfiles(mock.api, ["a", "b", "c"]);
    expect(mock.createPwrAgentProfile.mock.calls.map(([req]) => req)).toEqual([
      { profile: "a", seedOnboardingCompleted: true },
      { profile: "b", seedOnboardingCompleted: true },
      { profile: "c", seedOnboardingCompleted: true },
    ]);
  });

  it("multiple path: provisions N paired profiles in sequence", async () => {
    const mock = makeApi();
    const created = await provisionPairedProfiles(mock.api, [
      "work",
      "personal",
      "projects",
    ]);
    expect(created).toEqual(["work", "personal", "projects"]);
    expect(mock.callLog).toEqual([
      "pwragent:work",
      "codex:work",
      "pair:work↔work",
      "pwragent:personal",
      "codex:personal",
      "pair:personal↔personal",
      "pwragent:projects",
      "codex:projects",
      "pair:projects↔projects",
    ]);
  });

  it("pairs the PwrAgent profile to a Codex profile of the same name", async () => {
    const mock = makeApi();
    await provisionPairedProfiles(mock.api, ["solo"]);
    expect(mock.setPwrAgentProfileCodexProfile).toHaveBeenCalledWith({
      profile: "solo",
      codexProfile: "solo",
    });
  });

  it("trims whitespace before validating + calling IPCs", async () => {
    const mock = makeApi();
    const created = await provisionPairedProfiles(mock.api, [
      "  work  ",
      "\tpersonal\n",
    ]);
    expect(created).toEqual(["work", "personal"]);
    expect(mock.callLog).toContain("pwragent:work");
    expect(mock.callLog).toContain("pwragent:personal");
    // No untrimmed leakage:
    expect(mock.callLog).not.toContain("pwragent:  work  ");
  });

  it("skips invalid names without breaking the batch", async () => {
    const mock = makeApi();
    const created = await provisionPairedProfiles(mock.api, [
      "",
      "valid",
      "UPPERCASE",
      "also-valid",
    ]);
    expect(created).toEqual(["valid", "also-valid"]);
    expect(mock.createPwrAgentProfile).toHaveBeenCalledTimes(2);
    expect(mock.createCodexAuthProfile).toHaveBeenCalledTimes(2);
    expect(mock.setPwrAgentProfileCodexProfile).toHaveBeenCalledTimes(2);
  });

  it("a single failed pair does not abort the rest of the batch", async () => {
    const mock = makeApi();
    // Fail the second name's createCodexAuthProfile call.
    mock.createCodexAuthProfile.mockImplementationOnce(async (req) => {
      mock.callLog.push(`pwragent:${req.profile}`);
      return {
        profile: req.profile,
        codexHome: `/tmp/codex/${req.profile}`,
        created: true,
      };
    });
    mock.createCodexAuthProfile.mockRejectedValueOnce(
      new Error("disk full simulating bad codex create"),
    );
    const created = await provisionPairedProfiles(mock.api, [
      "first",
      "second-fails",
      "third",
    ]);
    expect(created).toEqual(["first", "third"]);
    // The second profile's setPwrAgentProfileCodexProfile is NOT called
    // because createCodexAuthProfile threw — but the third profile's
    // full sequence still runs.
    expect(mock.setPwrAgentProfileCodexProfile).toHaveBeenCalledTimes(2);
    expect(mock.setPwrAgentProfileCodexProfile).toHaveBeenNthCalledWith(1, {
      profile: "first",
      codexProfile: "first",
    });
    expect(mock.setPwrAgentProfileCodexProfile).toHaveBeenNthCalledWith(2, {
      profile: "third",
      codexProfile: "third",
    });
    // The failure was logged, not thrown.
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it("returns [] when the api is missing required methods", async () => {
    const created = await provisionPairedProfiles(
      { createPwrAgentProfile: undefined },
      ["a", "b"],
    );
    expect(created).toEqual([]);
  });

  it("returns [] when api is undefined entirely (Skip path)", async () => {
    const created = await provisionPairedProfiles(undefined, ["a"]);
    expect(created).toEqual([]);
  });

  it("empty name list is a no-op (Shared path early-exit case)", async () => {
    const mock = makeApi();
    const created = await provisionPairedProfiles(mock.api, []);
    expect(created).toEqual([]);
    expect(mock.createPwrAgentProfile).not.toHaveBeenCalled();
    expect(mock.createCodexAuthProfile).not.toHaveBeenCalled();
    expect(mock.setPwrAgentProfileCodexProfile).not.toHaveBeenCalled();
  });
});
