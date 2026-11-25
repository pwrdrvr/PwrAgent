import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, within } from "../../../test/phase-probes";
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { UsageOverviewBand } from "../UsageOverviewBand";
import {
  cycleTriStateFilter,
  removeTriStateFilterKey,
  type FilterMode,
  type TriStateFilter,
} from "../usage-activity-overview";
import { summarizeUsageActivity, type UsageGroup } from "../usage-activity-summary";
import { usageFixture } from "../usage-activity-fixture";

const HOUR = 3_600_000;
const TO = Date.UTC(2026, 10, 24, 15, 0, 0);
const FROM = TO - 7 * 24 * HOUR;

const TURNS = [
  { provider: "openai", providerLabel: "OpenAI", backend: "codex", model: "gpt-5.4", modelLabel: "GPT-5.4" },
  { provider: "anthropic", providerLabel: "Anthropic", backend: "claude", model: "claude-opus-4-6", modelLabel: "Claude Opus 4.6" },
  { provider: "xai", providerLabel: "xAI", backend: "acp:grok", model: "grok-4", modelLabel: "Grok 4" },
] as const;

const GROUPS: readonly UsageGroup[] = summarizeUsageActivity(TURNS.map((turn, index) => usageFixture({
  createdAt: TO - (index + 2) * HOUR, startedAt: TO - (index + 2) * HOUR, completedAt: TO - (index + 1) * HOUR,
  usageLineId: `${turn.provider}-line`, threadId: `${turn.provider}-thread`, turnId: `${turn.provider}-turn`,
  backend: turn.backend, provider: turn.provider, model: turn.model, modelLabel: turn.modelLabel,
})), FROM, TO).groups;

/** Same wiring as UsageActivity: each row cycles its own key through the shared reducer. */
function FilteredBand() {
  const [providerFilters, setProviderFilters] = useState<TriStateFilter>({});
  const [modelFilters, setModelFilters] = useState<TriStateFilter>({});
  return <UsageOverviewBand groups={GROUPS} from={FROM} to={TO}
    providerFilters={providerFilters}
    onToggleProvider={(key) => setProviderFilters((current) => cycleTriStateFilter(current, key))}
    onRemoveProviderFilter={(key) => setProviderFilters((current) => removeTriStateFilterKey(current, key))}
    modelFilters={modelFilters}
    onToggleModel={(key) => setModelFilters((current) => cycleTriStateFilter(current, key))}
    onRemoveModelFilter={(key) => setModelFilters((current) => removeTriStateFilterKey(current, key))}
    onClearModelFilters={() => setModelFilters({})}
    onClearFilters={() => {
      setProviderFilters({});
      setModelFilters({});
    }} />;
}

type Command =
  | { kind: "provider" | "model"; index: number }
  | { kind: "clear" };

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  fc.record({ kind: fc.constant("provider" as const), index: fc.integer({ min: 0, max: TURNS.length - 1 }) }),
  fc.record({ kind: fc.constant("model" as const), index: fc.integer({ min: 0, max: TURNS.length - 1 }) }),
  fc.constant({ kind: "clear" as const }),
);

/** Model: every row cycles unfiltered → include → exclude → unfiltered on its own click. */
function nextMode(mode: FilterMode | undefined): FilterMode | undefined {
  return mode === undefined ? "include" : mode === "include" ? "exclude" : undefined;
}

afterEach(cleanup);

describe("Usage Overview filter row names", () => {
  it("reports include through aria-pressed and exclusion through the accessible name, never as mixed", () => {
    fc.assert(fc.property(fc.array(commandArb, { minLength: 1, maxLength: 14 }), (commands) => {
      const { container, unmount } = render(<FilteredBand />);
      const band = within(container);
      const providerRow = (label: string) => within(band.getByRole("group", { name: "Usage by provider" }))
        .queryAllByRole("button")
        .find((button) => button.querySelector(".usage-overview__provider-name")?.textContent === label);
      const modelRow = (label: string) => [...container.querySelectorAll<HTMLButtonElement>(".usage-overview__table-body button")]
        .find((button) => button.querySelector(".usage-overview__entity-line strong")?.textContent === label);
      const providers = new Map<string, FilterMode | undefined>();
      const models = new Map<string, FilterMode | undefined>();

      const check = (step: string) => {
        for (const [labels, find, modes] of [
          [TURNS.map((turn) => turn.providerLabel), providerRow, providers],
          [TURNS.map((turn) => turn.modelLabel), modelRow, models],
        ] as const) {
          for (const label of labels) {
            const row = find(label);
            if (!row) continue;
            const mode = modes.get(label);
            const where = `${label} after ${step}`;
            expect(row.getAttribute("aria-pressed"), where).toBe(mode === "include" ? "true" : "false");
            if (mode === "exclude") expect(row, where).toHaveAccessibleName(/, excluded$/);
            else expect(row, where).not.toHaveAccessibleName(/excluded/);
          }
        }
      };

      try {
        check("render");
        commands.forEach((command, index) => {
          const step = `step ${index + 1} (${JSON.stringify(command)})`;
          if (command.kind === "clear") {
            const clear = band.queryAllByRole("button", { name: "Clear filters" })[0];
            if (!clear) return;
            fireEvent.click(clear);
            providers.clear();
            models.clear();
          } else {
            const turn = TURNS[command.index];
            const label = command.kind === "provider" ? turn.providerLabel : turn.modelLabel;
            const row = command.kind === "provider" ? providerRow(label) : modelRow(label);
            // A row the current filters hide cannot be clicked.
            if (!row) return;
            fireEvent.click(row);
            const modes = command.kind === "provider" ? providers : models;
            modes.set(label, nextMode(modes.get(label)));
          }
          check(step);
        });
      } finally {
        unmount();
      }
    }), { numRuns: 40 });
  });
});
