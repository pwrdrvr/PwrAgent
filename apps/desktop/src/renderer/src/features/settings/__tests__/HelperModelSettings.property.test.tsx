import { cleanup, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { BackendSummary } from "@pwragent/shared";
import {
  codexCatalogArbitrary,
  expectedModelSelectSections,
  selectSections,
} from "../../../test/model-catalog";
import { HelperModelSettings } from "../HelperModelSettings";

/**
 * The rule the Helper model list broke: a Settings model list shows a
 * catalog the way the composer does (`buildModelMenu`), with superseded
 * models under an Other models heading.
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
        const sections = selectSections(screen.getByRole("combobox", { name: "Helper model" }));
        // The Automatic row leads; which model it resolves to is another rule.
        const automatic = sections[0]?.labels[0] ?? "";
        expect(automatic).toMatch(/^Automatic/);
        expect(sections).toEqual(expectedModelSelectSections({ kind: "codex", models, leading: [automatic] }));
      } finally {
        cleanup();
      }
    }), { numRuns: 50 });
  });
});
