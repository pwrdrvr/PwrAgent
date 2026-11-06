import { cleanup, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { BackendModelOption, BackendSummary } from "@pwragent/shared";
import {
  claudeCatalogArbitrary,
  codexCatalogArbitrary,
  expectedModelSelectSections,
  selectSections,
} from "../../../test/model-catalog";
import { TaskMonitorModelSettings } from "../TaskMonitorModelSettings";

function sectionsFor(backendId: "codex" | "claude", models: BackendModelOption[]) {
  const backends = (["codex", "claude"] as const).map((kind) => ({
    kind,
    label: kind,
    available: true,
    launchpadOptions: {
      models: kind === backendId ? models : [{ id: "gpt-6-luna", label: "GPT-6-Luna" }],
    },
  })) as unknown as BackendSummary[];
  render(
    <TaskMonitorModelSettings backendId={backendId} providerLabel={backendId} backends={backends}
      helperModels={{ helpers: {} }} choices={{}} catalogReading={false} saving={false}
      onSave={vi.fn(async () => undefined)} />,
  );
  return selectSections(screen.getByRole("combobox", { name: "Task monitors" }));
}

/**
 * The rule the Task monitors list broke: it shows its provider's catalog the
 * way the composer does (`buildModelMenu`), after its Automatic and Helper
 * model rows.
 */
describe("TaskMonitorModelSettings properties", () => {
  it.each([
    ["codex", codexCatalogArbitrary],
    ["claude", claudeCatalogArbitrary],
  ] as const)("lists any %s catalog by the shared model menu rule", (backendId, catalog) => {
    fc.assert(fc.property(catalog, (models) => {
      try {
        const sections = sectionsFor(backendId, models);
        const [automatic = "", helper = ""] = sections[0]?.labels ?? [];
        expect(automatic).toMatch(/^Automatic/);
        expect(helper).toMatch(/^Helper model/);
        expect(sections).toEqual(expectedModelSelectSections({
          kind: backendId,
          models,
          leading: [automatic, helper],
        }));
      } finally {
        cleanup();
      }
    }), { numRuns: 50 });
  });
});
