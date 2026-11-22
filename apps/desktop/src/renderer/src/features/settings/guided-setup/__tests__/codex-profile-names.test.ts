import { describe, expect, it, vi } from "vitest";
import {
  describeProfileNameProblem,
  newProfileNamesToCreate,
} from "../codex-profile-names";
import { provisionPairedProfiles } from "../provisionPairedProfiles";

describe("new Codex profile names", () => {
  it("creates 1 to 5 unique, valid names that don't exist yet", () => {
    expect(newProfileNamesToCreate(["work"], ["default"])).toEqual(["work"]);
    expect(newProfileNamesToCreate(["work", "", "personal"], [])).toEqual([
      "work",
      "personal",
    ]);
    expect(newProfileNamesToCreate([""], [])).toBeUndefined();
    expect(newProfileNamesToCreate(["a", "b", "c", "d", "e", "f"], [])).toBeUndefined();
    expect(newProfileNamesToCreate(["work", "work"], [])).toBeUndefined();
    expect(newProfileNamesToCreate(["default"], ["default"])).toBeUndefined();
  });

  it("says why a row can't be created", () => {
    expect(describeProfileNameProblem("default", ["default"], ["default"]))
      .toBe("A profile named default already exists.");
    expect(describeProfileNameProblem("work", ["work", "work"], []))
      .toBe("Two rows are both named work.");
    expect(describeProfileNameProblem("", [""], [])).toBeUndefined();
  });
});

describe("provisionPairedProfiles", () => {
  it("pairs each PwrAgent profile with the Codex profile of the same name and keeps going past a failure", async () => {
    const calls: string[] = [];
    const api = {
      createPwrAgentProfile: vi.fn(async ({ profile }: { profile: string }) => {
        calls.push(`pwragent:${profile}`);
        if (profile === "broken") throw new Error("exists");
        return undefined as never;
      }),
      createCodexAuthProfile: vi.fn(async ({ profile }: { profile: string }) => {
        calls.push(`codex:${profile}`);
        return undefined as never;
      }),
      setPwrAgentProfileCodexProfile: vi.fn(
        async ({ profile, codexProfile }: { profile: string; codexProfile: string }) => {
          calls.push(`pair:${profile}=${codexProfile}`);
          return undefined as never;
        },
      ),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const created = await provisionPairedProfiles(api, ["work", "broken", "home"]);
    warn.mockRestore();
    expect(created).toEqual(["work", "home"]);
    expect(api.createPwrAgentProfile).toHaveBeenCalledWith({
      profile: "work",
      seedOnboardingCompleted: true,
    });
    expect(calls).toEqual([
      "pwragent:work",
      "codex:work",
      "pair:work=work",
      "pwragent:broken",
      "pwragent:home",
      "codex:home",
      "pair:home=home",
    ]);
  });
});
