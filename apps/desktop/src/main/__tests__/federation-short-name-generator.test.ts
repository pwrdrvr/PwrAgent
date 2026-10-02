import { describe, expect, it, vi } from "vitest";
import {
  buildFederationShortNamePrompt,
  FEDERATION_SHORT_NAME_TURN_TIMEOUT_MS,
  federationShortNamesNeedGeneration,
  generateFederationShortNames,
  planFederationShortNames,
  validateFederationShortNameAnswer,
  type FederationShortNameMachine,
  type FederationStructuredGenerator,
} from "../federation/federation-short-name-generator";

const studio: FederationShortNameMachine = {
  label: "Studio-MBP-M5-Max",
  profiles: ["default", "dev"],
  host: {
    platform: "darwin",
    osVersion: "25.6.0",
    arch: "arm64",
    cpuModel: "Apple M5 Max",
    cpuCount: 18,
    memoryBytes: 128 * 1024 ** 3,
    machineId: "mach_secret",
    hostname: "studio.local",
  },
};
const windows: FederationShortNameMachine = {
  label: "DESKTOP-17ISFOI",
  profiles: ["default"],
  host: { platform: "win32", arch: "x64", cpuCount: 4, memoryBytes: 8 * 1024 ** 3, virtualMachine: true },
};
const laptop: FederationShortNameMachine = { label: "MBP-M2-Max", profiles: ["default"] };

describe("planFederationShortNames", () => {
  it("sends long labels to the model and reserves short labels and overrides", () => {
    const plan = planFederationShortNames([
      studio,
      laptop,
      { ...windows, override: "Win VM" },
    ]);
    expect(plan.candidates.map((machine) => machine.label)).toEqual(["Studio-MBP-M5-Max"]);
    expect(plan.reserved).toEqual([
      { label: "MBP-M2-Max", name: "MBP-M2-Max", reason: "short" },
      { label: "DESKTOP-17ISFOI", name: "Win VM", reason: "override" },
    ]);
  });
});

describe("federationShortNamesNeedGeneration", () => {
  it("asks when a long label has no current name", () => {
    expect(federationShortNamesNeedGeneration([studio, laptop])).toBe(true);
  });

  it("does not ask when every long label is named and every name is distinct", () => {
    expect(federationShortNamesNeedGeneration([
      { ...studio, current: "M5 Max" },
      { ...windows, current: "Win PC" },
      laptop,
    ])).toBe(false);
  });

  it("asks when a kept label collides with a current name, ignoring case", () => {
    expect(federationShortNamesNeedGeneration([
      { ...studio, current: "M5 Max" },
      { label: "m5 max", profiles: [] },
    ])).toBe(true);
  });

  it("does not ask about a clash between reserved names, which no answer can fix", () => {
    expect(federationShortNamesNeedGeneration([
      { ...studio, current: "M5 Max" },
      { label: "Win-PC", profiles: [] },
      { label: "win-pc", profiles: [] },
    ])).toBe(false);
    expect(federationShortNamesNeedGeneration([
      { ...studio, current: "M5 Max" },
      { ...windows, override: "MBP-M2-Max" },
      laptop,
    ])).toBe(false);
  });

  it("never asks for a federation of short labels", () => {
    expect(federationShortNamesNeedGeneration([laptop, { label: "Linux VM", profiles: [] }])).toBe(false);
  });
});

describe("buildFederationShortNamePrompt", () => {
  it("gives the model the host facts, current names and reserved names, but not identity", () => {
    const prompt = buildFederationShortNamePrompt(planFederationShortNames([
      { ...studio, current: "M5 Max" },
      windows,
      laptop,
    ]));
    expect(prompt).toContain("label=Studio-MBP-M5-Max | current=M5 Max | profiles=default, dev");
    expect(prompt).toContain("cpu=Apple M5 Max");
    expect(prompt).toContain("memory=128 GB");
    expect(prompt).toContain("label=DESKTOP-17ISFOI | current=(none)");
    expect(prompt).toContain("os=Windows");
    expect(prompt).toContain("vm=yes");
    expect(prompt).toContain("\"MBP-M2-Max\": label already short");
    expect(prompt).not.toContain("mach_secret");
    expect(prompt).not.toContain("studio.local");
  });
});

describe("validateFederationShortNameAnswer", () => {
  const plan = planFederationShortNames([studio, windows, laptop]);
  const answer = (names: Array<{ label: string; shortName: string }>) => ({ names });

  it("accepts one valid name per candidate", () => {
    const result = validateFederationShortNameAnswer(answer([
      { label: "Studio-MBP-M5-Max", shortName: " M5  Max " },
      { label: "DESKTOP-17ISFOI", shortName: "Win VM" },
    ]), plan);
    expect(result).toEqual({
      ok: true,
      names: new Map([["Studio-MBP-M5-Max", "M5 Max"], ["DESKTOP-17ISFOI", "Win VM"]]),
    });
  });

  it.each([
    ["not a list", { names: "M5 Max" }, "answer_not_a_list"],
    ["an unknown label", answer([
      { label: "Studio-MBP-M5-Max", shortName: "M5 Max" },
      { label: "Some-Other-Box", shortName: "Other" },
    ]), "unknown_label"],
    ["a missing label", answer([{ label: "Studio-MBP-M5-Max", shortName: "M5 Max" }]), "missing_label"],
    ["a label twice", answer([
      { label: "Studio-MBP-M5-Max", shortName: "M5 Max" },
      { label: "Studio-MBP-M5-Max", shortName: "Studio" },
    ]), "duplicate_label"],
    ["a duplicate name, ignoring case", answer([
      { label: "Studio-MBP-M5-Max", shortName: "Box" },
      { label: "DESKTOP-17ISFOI", shortName: "box" },
    ]), "name_not_unique"],
    ["a reserved name", answer([
      { label: "Studio-MBP-M5-Max", shortName: "mbp-m2-max" },
      { label: "DESKTOP-17ISFOI", shortName: "Win PC" },
    ]), "name_not_unique"],
    ["a name over twelve characters", answer([
      { label: "Studio-MBP-M5-Max", shortName: "Studio M5 Max" },
      { label: "DESKTOP-17ISFOI", shortName: "Win PC" },
    ]), "invalid_name"],
    ["an empty name", answer([
      { label: "Studio-MBP-M5-Max", shortName: "  " },
      { label: "DESKTOP-17ISFOI", shortName: "Win PC" },
    ]), "invalid_name"],
  ])("rejects the whole answer for %s", (_case, value, reason) => {
    expect(validateFederationShortNameAnswer(value, plan)).toEqual({ ok: false, reason });
  });

  it("rejects another machine's full label, as an operator rename does", () => {
    // Overridden: the label is still how the operator knows the machine.
    expect(validateFederationShortNameAnswer(
      answer([{ label: "Studio-MBP-M5-Max", shortName: "win-desktop" }]),
      planFederationShortNames([studio, { label: "Win-Desktop", profiles: [], override: "Gamer" }]),
    )).toEqual({ ok: false, reason: "name_not_unique" });
    // Another candidate's label, even while that candidate is renamed.
    expect(validateFederationShortNameAnswer(
      answer([
        { label: "Studio-MBP-M5-Max", shortName: "Win-Desktop" },
        { label: "Win-Desktop", shortName: "Win PC" },
      ]),
      planFederationShortNames([studio, { label: "Win-Desktop", profiles: [] }]),
    )).toEqual({ ok: false, reason: "name_not_unique" });
    // A candidate may keep its own label when that is short enough.
    expect(validateFederationShortNameAnswer(
      answer([{ label: "Win-Desktop", shortName: "Win-Desktop" }]),
      planFederationShortNames([{ label: "Win-Desktop", profiles: [] }]),
    )).toMatchObject({ ok: true });
  });

  it("rejects a name longer than the label it shortens", () => {
    const shortPlan = planFederationShortNames([{ label: "Win-Desktop", profiles: [] }]);
    expect(validateFederationShortNameAnswer(
      answer([{ label: "Win-Desktop", shortName: "Windows Desk" }]),
      shortPlan,
    )).toEqual({ ok: false, reason: "name_longer_than_label" });
  });
});

describe("generateFederationShortNames", () => {
  const plan = planFederationShortNames([studio, laptop]);

  it("routes one structured turn through the instance names helper with a deliberate turn budget", async () => {
    const generate = vi.fn<FederationStructuredGenerator>(async () => ({
      status: "ok",
      object: { names: [{ label: "Studio-MBP-M5-Max", shortName: "M5 Max" }] },
      model: "gpt-6-luna",
    }));
    const result = await generateFederationShortNames({ plan, generate });
    expect(result).toEqual({ ok: true, names: new Map([["Studio-MBP-M5-Max", "M5 Max"]]), model: "gpt-6-luna" });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0]).toMatchObject({
      helper: "federation_instance_names",
      turnTimeoutMs: FEDERATION_SHORT_NAME_TURN_TIMEOUT_MS,
      schemaName: "federation_instance_short_names",
    });
    expect(generate.mock.calls[0][0]).not.toHaveProperty("model");
    expect(generate.mock.calls[0][0]).not.toHaveProperty("reasoningEffort");
  });

  it("marks an unavailable backend or a thrown call as unanswered", async () => {
    expect(await generateFederationShortNames({
      plan,
      generate: async () => ({ status: "unavailable", reason: "codex_structured_generation_unavailable" }),
    })).toEqual({ ok: false, reason: "codex_structured_generation_unavailable", answered: false });
    expect(await generateFederationShortNames({
      plan,
      generate: async () => { throw new Error("timed out"); },
    })).toEqual({ ok: false, reason: "timed out", answered: false });
  });

  it("marks an answer that fails validation as answered", async () => {
    expect(await generateFederationShortNames({
      plan,
      generate: async () => ({ status: "ok", object: { names: [] } }),
    })).toEqual({ ok: false, reason: "missing_label", answered: true });
  });
});
