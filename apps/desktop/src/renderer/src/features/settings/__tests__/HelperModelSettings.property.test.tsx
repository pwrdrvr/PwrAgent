import { cleanup, render } from "@testing-library/react";
import fc from "fast-check";
import { describe, it, vi } from "vitest";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import {
  codexCatalogArbitrary,
  expectModelSettingsToList,
  expectedModelDropdown,
} from "../../../test/model-catalog";
import { openModelSettings } from "../../../test/model-settings";
import { HelperModelSettings } from "../HelperModelSettings";

/**
 * The rule the Helper model list broke: a Settings model list shows a
 * catalog the way the composer does (`buildModelMenu`), with superseded
 * models under Other.
 */
describe("HelperModelSettings properties", () => {
  it("lists any Codex catalog by the shared model menu rule", () => {
    fc.assert(fc.property(codexCatalogArbitrary, (models) => {
      const codex = {
        kind: "codex",
        label: "Codex",
        available: true,
        launchpadOptions: { reasoningEfforts: ["low", "medium", "high"], models },
      } as unknown as BackendSummary;
      try {
        render(
          <HelperModelSettings backends={[codex]} settings={{ helpers: {} }} catalogReading={false}
            saving={false} onSave={vi.fn(async () => undefined)} />,
        );
        // The Automatic row leads; which model it resolves to is another rule.
        expectModelSettingsToList(openModelSettings("Helper model"), expectedModelDropdown({
          kind: "codex",
          models,
          leading: ["Automatic"],
          otherInline: true,
        }));
      } finally {
        cleanup();
      }
    }), { numRuns: 50 });
  });
});
