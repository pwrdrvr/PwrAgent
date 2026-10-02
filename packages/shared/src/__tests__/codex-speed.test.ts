import { describe, expect, it } from "vitest";
import { codexSpeedOptions, codexSpeedSettings, nextCodexSpeed, selectedCodexSpeed } from "../codex-speed";

describe("Codex speed settings", () => {
  it("offers Ultrafast only from the selected model's catalog and allowed policy", () => {
    const model = { id: "gpt-6-astra", supportsFast: true, serviceTiers: ["priority", "ultrafast"] };
    expect(codexSpeedOptions(model)).toEqual(["standard", "fast", "ultrafast"]);
    expect(codexSpeedOptions(model, false)).toEqual(["standard"]);
    expect(codexSpeedOptions({ ...model, serviceTiers: [] })).toEqual(["standard", "fast"]);
    expect(codexSpeedOptions({ id: model.id })).toEqual(["standard"]);
    expect(codexSpeedOptions({ id: model.id }, true, true)).toEqual(["standard", "fast"]);
  });

  it("cycles independent speed intent without confusing reasoning or the legacy Fast flag", () => {
    const options = codexSpeedOptions({ id: "fixture", supportsFast: true, serviceTiers: ["ultrafast"] });
    expect(nextCodexSpeed(options, {})).toBe("fast");
    expect(nextCodexSpeed(options, { fastMode: true })).toBe("ultrafast");
    expect(nextCodexSpeed(options, { serviceTier: "ultrafast", fastMode: true })).toBe("standard");
    expect(selectedCodexSpeed({ serviceTier: "ultrafast", fastMode: true })).toBe("ultrafast");
    expect(selectedCodexSpeed({ serviceTier: "priority", fastMode: false })).toBe("standard");
    expect(codexSpeedSettings("ultrafast")).toEqual({ serviceTier: "ultrafast", fastMode: false });
    expect(codexSpeedSettings("standard")).toEqual({ serviceTier: undefined, fastMode: false });
  });
});
