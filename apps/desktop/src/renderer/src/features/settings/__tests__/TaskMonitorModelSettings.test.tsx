import "@testing-library/jest-dom/vitest";
import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { DesktopTaskMonitorModelChoice } from "@pwragent/shared/helper-models";
import {
  chooseModelSettingsOption,
  modelSettingsOptionNames,
  modelSettingsPill,
  openModelSettings,
} from "../../../test/model-settings";
import { TaskMonitorModelSettings } from "../TaskMonitorModelSettings";

// Only the fields the row reads.
const codex = {
  kind: "codex",
  label: "Codex",
  available: true,
  launchpadOptions: {
    models: [{ id: "gpt-6-luna", label: "GPT-6-Luna" }],
  },
} as unknown as BackendSummary;

const claude = {
  kind: "claude",
  label: "Claude",
  available: true,
  launchpadOptions: {
    models: [
      { id: "opus", label: "Opus" },
      { id: "sonnet", label: "Sonnet" },
      { id: "haiku", label: "Haiku" },
    ],
  },
} as unknown as BackendSummary;

type Choices = Record<string, DesktopTaskMonitorModelChoice>;

function renderRow(choices: Choices, backends: BackendSummary[] = [codex, claude]) {
  const onSave = vi.fn(async (_next: Choices) => undefined);
  render(
    <TaskMonitorModelSettings
      backendId="claude"
      providerLabel="Claude"
      backends={backends}
      helperModels={{ helpers: {} }}
      choices={choices}
      catalogReading={false}
      saving={false}
      onSave={onSave}
    />,
  );
  return onSave;
}

const LABEL = "Task monitors";
const trigger = () => modelSettingsPill(LABEL);
const choose = (name: string) => chooseModelSettingsOption("Model", name, LABEL);

describe("TaskMonitorModelSettings", () => {
  it("puts the catalog's older models under Other models, as the composer does", () => {
    renderRow({}, [codex, {
      ...claude,
      launchpadOptions: {
        models: [
          { id: "opus", label: "Opus" },
          { id: "opus-4-1", label: "Opus 4.1", other: true },
          { id: "sonnet", label: "Sonnet" },
          { id: "haiku", label: "Haiku" },
        ],
      },
    } as BackendSummary]);

    expect(modelSettingsOptionNames("Model", LABEL)).toEqual([
      "Automatic (Haiku)",
      "Helper model (GPT-6-Luna)",
      "Opus",
      "Sonnet",
      "Haiku",
    ]);
    const panel = openModelSettings(LABEL);
    fireEvent.click(within(panel).getByRole("button", { name: "Other Models" }));
    const other = within(panel).getByRole("listbox", { name: "Model: Other Models" });
    expect(within(other).getAllByRole("option").map((option) => option.textContent))
      .toEqual(["Opus 4.1"]);
  });

  it("names the lightweight model Automatic runs and the model the Helper model runs", () => {
    renderRow({});

    expect(trigger()).toHaveTextContent("Automatic (Haiku)");
    expect(modelSettingsOptionNames("Model", LABEL)).toEqual([
      "Automatic (Haiku)",
      "Helper model (GPT-6-Luna)",
      "Opus",
      "Sonnet",
      "Haiku",
    ]);
  });

  it("is plain Automatic when the provider offers no lightweight model", () => {
    renderRow({}, [codex, {
      ...claude,
      launchpadOptions: { models: [{ id: "opus", label: "Opus" }] },
    } as unknown as BackendSummary]);

    expect(trigger().querySelector(".model-settings__pill-model")).toHaveTextContent(/^Automatic$/);
  });

  it("saves the Helper model choice and keeps every other provider's", () => {
    const gemini: DesktopTaskMonitorModelChoice = {
      source: "provider",
      model: "gemini-3-flash",
    };
    const onSave = renderRow({ "acp:gemini": gemini });

    choose("Helper model (GPT-6-Luna)");
    expect(onSave).toHaveBeenLastCalledWith({
      "acp:gemini": gemini,
      claude: { source: "helper" },
    });
  });

  it("saves a provider model", () => {
    const onSave = renderRow({});

    choose("Sonnet");
    expect(onSave).toHaveBeenLastCalledWith({
      claude: { source: "provider", model: "sonnet" },
    });
  });

  it("drops a saved effort when the model changes", () => {
    const onSave = renderRow({
      claude: { source: "provider", model: "sonnet", reasoningEffort: "high" },
    });

    expect(trigger().querySelector(".model-settings__pill-model")).toHaveTextContent(/^Sonnet$/);
    choose("Opus");
    expect(onSave).toHaveBeenLastCalledWith({
      claude: { source: "provider", model: "opus" },
    });
  });

  it("removes this provider's key for Automatic and keeps the others", () => {
    const gemini: DesktopTaskMonitorModelChoice = { source: "helper" };
    const onSave = renderRow({
      "acp:gemini": gemini,
      claude: { source: "helper" },
    });

    expect(trigger()).toHaveTextContent("Helper model (GPT-6-Luna)");
    choose("Automatic (Haiku)");
    expect(onSave).toHaveBeenLastCalledWith({ "acp:gemini": gemini });
  });

  it("keeps a saved model the provider no longer offers", () => {
    renderRow({ claude: { source: "provider", model: "claude-3-haiku" } });

    expect(trigger()).toHaveTextContent("claude-3-haiku (not offered)");
  });
});
