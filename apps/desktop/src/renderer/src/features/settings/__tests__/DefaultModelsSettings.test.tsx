import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  BackendSummary,
  DesktopHelperModelSettings,
} from "@pwragent/shared";
import { chooseSelectOption, selectOptionLabels } from "../../../test/select";
import { DefaultModelsSettings } from "../DefaultModelsSettings";
import type { ProviderCatalogRefreshController } from "../ProviderCatalogRefresh";

const EFFORTS = ["low", "medium", "high"];

// Only the fields the page reads.
const codex = {
  kind: "codex",
  label: "Codex",
  available: true,
  launchpadOptions: {
    reasoningEfforts: EFFORTS,
    models: [
      { id: "gpt-6-luna", label: "GPT-6-Luna", reasoningEfforts: EFFORTS },
      { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", reasoningEfforts: EFFORTS },
      { id: "gpt-5.5", label: "GPT-5.5", reasoningEfforts: EFFORTS },
    ],
  },
} as unknown as BackendSummary;

const grok = {
  kind: "acp:grok",
  label: "Grok",
  available: true,
  launchpadOptions: { models: [{ id: "grok-fast", label: "Grok Fast" }] },
} as unknown as BackendSummary;

const catalogRefresh: ProviderCatalogRefreshController = {
  available: true,
  running: false,
  start: () => undefined,
  cancel: () => undefined,
};

function renderPage(
  settings: DesktopHelperModelSettings,
  backends: BackendSummary[] = [codex, grok],
) {
  const onSave = vi.fn(async (_next: DesktopHelperModelSettings) => undefined);
  render(
    <DefaultModelsSettings
      backends={backends}
      settings={settings}
      catalogRefresh={catalogRefresh}
      catalogReading={false}
      saving={false}
      onSave={onSave}
    />,
  );
  return onSave;
}

describe("DefaultModelsSettings", () => {
  it("lists every helper with the model it will run", () => {
    renderPage({ helpers: {} });

    expect(screen.getByRole("combobox", { name: "Helper default model" }))
      .toHaveTextContent("Automatic (GPT-6-Luna)");
    for (const name of [
      "Thread titles model",
      "Task monitors model",
      "Diff condensation model",
      "Instance names model",
    ]) {
      expect(screen.getByRole("combobox", { name })).toHaveTextContent(
        "Helper default (GPT-6-Luna)",
      );
    }
    expect(screen.getByText(/ACP threads use the thread’s own model/))
      .toBeInTheDocument();
  });

  it("keeps a saved model Codex does not offer and names what runs instead", () => {
    renderPage({
      helpers: { diff_condensation: { model: "gpt-5.6-luna-preview" } },
    });

    const picker = screen.getByRole("combobox", { name: "Diff condensation model" });
    expect(picker).toHaveTextContent("gpt-5.6-luna-preview (not offered)");
    expect(screen.getByText(/Codex does not offer this model/))
      .toHaveTextContent("Running GPT-6-Luna (automatic) until it does.");
  });

  it("saves a row's model and effort, and clears it back to Helper default", () => {
    const onSave = renderPage({
      defaultModel: "gpt-5.5",
      helpers: { thread_titles: { reasoningEffort: "high" } },
    });

    chooseSelectOption(
      screen.getByRole("combobox", { name: "Thread titles model" }),
      "GPT-5.6-Luna",
    );
    expect(onSave).toHaveBeenLastCalledWith({
      defaultModel: "gpt-5.5",
      helpers: { thread_titles: { model: "gpt-5.6-luna", reasoningEffort: "high" } },
    });

    chooseSelectOption(
      screen.getByRole("combobox", { name: "Thread titles reasoning" }),
      /^Default/,
    );
    expect(onSave).toHaveBeenLastCalledWith({ defaultModel: "gpt-5.5", helpers: {} });
  });

  it("names the backend in each option of a helper that runs on more than one", () => {
    const onSave = renderPage({ helpers: {} });
    const picker = screen.getByRole("combobox", { name: "Usage analysis model" });

    expect(selectOptionLabels(picker)).toEqual([
      "Helper default (GPT-6-Luna)",
      "Codex · GPT-6-Luna",
      "Codex · GPT-5.6-Luna",
      "Codex · GPT-5.5",
      "Grok · Grok Fast",
    ]);
    chooseSelectOption(picker, "Grok · Grok Fast");
    expect(onSave).toHaveBeenLastCalledWith({
      helpers: { usage_analysis: { backend: "acp:grok", model: "grok-fast" } },
    });
  });

  it("says helpers are skipped while Codex is not connected", () => {
    renderPage({ helpers: {} }, [{ ...codex, available: false, launchpadOptions: undefined }]);

    expect(
      screen.getAllByText("Codex is not connected. Helpers that run on Codex are skipped.")
        .length,
    ).toBeGreaterThan(1);
  });
});
