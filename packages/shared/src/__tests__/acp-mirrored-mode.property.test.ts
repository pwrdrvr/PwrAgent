import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  acpRuntimeModeSelector,
  findAcpMirroredModeConfigOption,
} from "../acp-permission-mode";
import type {
  BackendAcpRuntimeCapabilities,
  BackendAcpRuntimeConfigOption,
} from "../contracts/backend";

const optionArb: fc.Arbitrary<BackendAcpRuntimeConfigOption> = fc.record({
  id: fc.constantFrom("mode", "permission_mode", "approval", "model"),
  label: fc.constant("Option"),
  type: fc.constant("select" as const),
  category: fc.constantFrom("mode", "model", "thought_level"),
  values: fc.uniqueArray(fc.constantFrom("default", "auto", "plan", "yolo"), { maxLength: 3 })
    .map((ids) => ids.map((value) => ({ value, label: value }))),
});

const runtimeArb: fc.Arbitrary<BackendAcpRuntimeCapabilities> = fc.record({
  schemaVersion: fc.constant(1 as const),
  status: fc.constant("discovered" as const),
  configOptions: fc.uniqueArray(optionArb, { selector: (option) => option.id, maxLength: 4 }),
}) as fc.Arbitrary<BackendAcpRuntimeCapabilities>;

describe("findAcpMirroredModeConfigOption", () => {
  it("is the mode list the selector reads whenever the agent lists no permission_mode", () => {
    fc.assert(fc.property(runtimeArb, (runtime) => {
      const mirrored = findAcpMirroredModeConfigOption(runtime);
      // The oracle: the first mode-category option that lists values and is
      // not Grok's independent permission_mode.
      const expected = runtime.configOptions?.find(
        (option) => option.category === "mode" && option.id !== "permission_mode" && option.values.length > 0,
      );
      expect(mirrored).toBe(expected);
      const selector = acpRuntimeModeSelector(runtime);
      const hasPermission = runtime.configOptions?.some((option) => option.id === "permission_mode");
      if (!hasPermission && mirrored) {
        expect(selector).toMatchObject({ source: "configOption", optionId: mirrored.id });
      }
    }), { numRuns: 500 });
  });
});
