import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defaultModelOption } from "@pwragent/shared/model-defaults";
import { buildLaunchpadOptions } from "../app-server/thread-model-options";

describe("new-thread model defaults", () => {
  it("chooses an available 6.1 coding model regardless of catalog order or legacy default flags", () => {
    fc.assert(fc.property(
      fc.subarray(["gpt-6.1-terra", "gpt-6.1-sol"], { minLength: 1 }),
      fc.shuffledSubarray(["gpt-5.5", "gpt-5.6-terra", "gpt-6-sol", "gpt-6-astra"]),
      fc.boolean(),
      (modern, legacy, reverse) => {
        const ids = [...legacy, ...modern];
        if (reverse) ids.reverse();
        const options = buildLaunchpadOptions("codex", [
          ...ids.map((id) => ({ id, current: id === "gpt-5.6-terra", supportsReasoning: true })),
          { id: "@bonsai/local-model", providerId: "bonsai", current: true },
        ]);
        const selected = options?.models?.filter((model) => model.current) ?? [];
        expect(selected).toHaveLength(1);
        expect(modern).toContain(selected[0]!.id);
        expect(defaultModelOption("codex", options)?.id).toBe(selected[0]!.id);
      },
    ));
  });

  it("uses a 6.1 coding model before discovery on a fresh install", () => {
    const options = buildLaunchpadOptions("codex", []);
    expect(["gpt-6.1-terra", "gpt-6.1-sol"])
      .toContain(defaultModelOption("codex", options)?.id);
  });

  it("honors the advertised default when no preferred coding model is available", () => {
    fc.assert(fc.property(fc.constantFrom("codex", "claude"), fc.integer({ min: 0, max: 3 }), (backend, current) => {
      const models = Array.from({ length: 4 }, (_, index) => ({ id: `model-${index}`, current: index === current }));
      const options = buildLaunchpadOptions(backend, models);
      expect(defaultModelOption(backend, options)?.id).toBe(models[current]!.id);
    }));
  });
});
