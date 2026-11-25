import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { DesktopHelperModelSettings } from "@pwragent/shared/helper-models";
import {
  codexCatalogModels,
  expectModelSettingsToList,
  expectedModelDropdown,
} from "../../../test/model-catalog";
import {
  chooseEffort,
  chooseModelSettingsOption,
  effortStops,
  modelSettingsPill,
  openModelSettings,
} from "../../../test/model-settings";
import { HelperModelSettings } from "../HelperModelSettings";

const EFFORTS = ["low", "medium", "high"];

// Only the fields the row reads.
const codex = {
  kind: "codex",
  label: "Codex",
  available: true,
  launchpadOptions: {
    reasoningEfforts: EFFORTS,
    models: [
      { id: "gpt-6-luna", label: "GPT-6-Luna", reasoningEfforts: EFFORTS },
      { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", reasoningEfforts: ["low", "medium"] },
      { id: "gpt-5.5", label: "GPT-5.5", reasoningEfforts: EFFORTS },
    ],
  },
} as unknown as BackendSummary;

const LABEL = "Helper model";

const grok = {
  kind: "acp:grok",
  label: "Grok",
  available: true,
  launchpadOptions: { models: [{ id: "grok-fast", label: "Grok Fast" }] },
} as unknown as BackendSummary;

function renderRow(
  settings: DesktopHelperModelSettings,
  backends: BackendSummary[] = [codex, grok],
) {
  const onSave = vi.fn(async (_next: DesktopHelperModelSettings) => undefined);
  render(
    <HelperModelSettings
      backends={backends}
      settings={settings}
      catalogReading={false}
      saving={false}
      onSave={onSave}
    />,
  );
  return onSave;
}

describe("HelperModelSettings", () => {
  it("lists models the way the composer does: current first, superseded under Other", () => {
    const models = codexCatalogModels();
    renderRow({ helpers: {} }, [{
      ...codex,
      launchpadOptions: { reasoningEfforts: EFFORTS, models },
    } as BackendSummary]);
    expectModelSettingsToList(openModelSettings(LABEL), expectedModelDropdown({
      kind: "codex",
      models,
      leading: ["Automatic"],
      otherInline: true,
    }));
  });

  it("is one model pill, with no row per helper", () => {
    renderRow({ helpers: {} });

    expect(screen.getAllByRole("button", { name: /^Helper model/ })).toHaveLength(1);
    expect(modelSettingsPill(LABEL)).toHaveAccessibleName(
      "Helper model: Automatic (GPT-6-Luna), per helper effort",
    );
    expect(screen.getByText(/^Runs \./)).toHaveTextContent(
      "Runs GPT-6-Luna. Automatic prefers GPT-6-Luna, then GPT-5.6-Luna.",
    );
    expect(screen.queryByText(/Diff condensation/)).not.toBeInTheDocument();
  });

  it("saves the model and the effort, and keeps the effort when the new model offers it", () => {
    const onSave = renderRow({ defaultReasoningEffort: "medium", helpers: {} });

    chooseModelSettingsOption("Model", "GPT-5.5", LABEL);
    expect(onSave).toHaveBeenLastCalledWith({
      defaultModel: "gpt-5.5",
      defaultReasoningEffort: "medium",
      helpers: {},
    });

    chooseEffort("high", LABEL);
    expect(onSave).toHaveBeenLastCalledWith({
      defaultReasoningEffort: "high",
      helpers: {},
    });

    chooseEffort("Per helper", LABEL);
    expect(onSave).toHaveBeenLastCalledWith({ helpers: {} });
  });

  it("drops an effort the newly chosen model does not offer", () => {
    const onSave = renderRow({ defaultReasoningEffort: "high", helpers: {} });

    chooseModelSettingsOption("Model", "GPT-5.6-Luna", LABEL);
    expect(onSave).toHaveBeenLastCalledWith({ defaultModel: "gpt-5.6-luna", helpers: {} });
  });

  it("lists the efforts of the model that runs", () => {
    renderRow({ defaultModel: "gpt-5.6-luna", helpers: {} });

    expect(effortStops(LABEL)).toEqual(["low", "medium"]);
    expect(within(openModelSettings(LABEL)).getByRole("button", { name: "Per helper" })).toBeInTheDocument();
  });

  it("does not call a saved effort unavailable when the model lists no efforts", () => {
    renderRow(
      { defaultReasoningEffort: "high", helpers: {} },
      [{
        ...codex,
        launchpadOptions: {
          models: [{ id: "gpt-6-luna", label: "GPT-6-Luna", supportsReasoning: true }],
        },
      } as unknown as BackendSummary],
    );

    expect(modelSettingsPill(LABEL)).toHaveAttribute("data-effort", "high");
    expect(modelSettingsPill(LABEL)).toHaveAccessibleName(/, high effort$/);
    expect(screen.queryByText(/not offer/)).not.toBeInTheDocument();
    expect(screen.getByText(/^Runs ,/)).toHaveTextContent("Runs GPT-6-Luna, high.");
  });

  it("keeps a saved model Codex does not offer and names what runs instead", () => {
    renderRow({ defaultModel: "gpt-6.1-luna", helpers: {} });

    expect(modelSettingsPill(LABEL)).toHaveAccessibleName(/^Helper model: gpt-6\.1-luna/);
    const saved = within(openModelSettings(LABEL)).getByRole("option", { name: /^gpt-6\.1-luna/ });
    expect(saved).toHaveAttribute("aria-selected", "true");
    expect(saved).toHaveAccessibleDescription("Not offered by Codex.");
    expect(screen.getByText(/Codex does not offer this model/))
      .toHaveTextContent("Running GPT-6-Luna (automatic) until it does.");
  });

  it("lists per-helper overrides from config.toml and clears them", () => {
    const onSave = renderRow({
      defaultModel: "gpt-5.5",
      helpers: {
        usage_analysis: { backend: "acp:grok", model: "grok-fast" },
        thread_titles: { model: "gpt-5.6-luna", reasoningEffort: "medium" },
      },
    });

    expect(screen.getByText("2 helpers set their own model in config.toml:"))
      .toBeInTheDocument();
    expect(screen.getByText("Thread titles").parentElement)
      .toHaveTextContent("Thread titles · GPT-5.6-Luna, medium");
    expect(screen.getByText("Usage analysis").parentElement)
      .toHaveTextContent("Usage analysis · Grok Fast");

    fireEvent.click(screen.getByRole("button", { name: "Clear overrides" }));
    expect(onSave).toHaveBeenLastCalledWith({ defaultModel: "gpt-5.5", helpers: {} });
  });

  it("does not call a saved model unavailable before the catalog is read", () => {
    renderRow(
      { defaultModel: "gpt-5.5", defaultReasoningEffort: "high", helpers: {} },
      [{ ...codex, available: false, discoveryPending: true, launchpadOptions: undefined }],
    );

    expect(modelSettingsPill(LABEL)).toHaveAccessibleName("Helper model: gpt-5.5, high effort");
    expect(screen.queryByText(/not offered/)).not.toBeInTheDocument();
    expect(screen.getByText("Checking Codex models…")).toBeInTheDocument();
  });

  it("says helpers are skipped while Codex is not connected", () => {
    renderRow({ helpers: {} }, [{ ...codex, available: false, launchpadOptions: undefined }]);

    expect(
      screen.getByText("Codex is not connected. Helpers that run on Codex are skipped."),
    ).toBeInTheDocument();
  });
});
