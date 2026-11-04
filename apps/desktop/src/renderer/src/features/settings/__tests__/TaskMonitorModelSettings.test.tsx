import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  BackendSummary,
  DesktopTaskMonitorModelChoice,
} from "@pwragent/shared";
import { chooseSelectOption, selectOptionLabels } from "../../../test/select";
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

const trigger = () => screen.getByRole("combobox", { name: "Task monitors" });

describe("TaskMonitorModelSettings", () => {
  it("names the lightweight model Automatic runs and the model the Helper model runs", () => {
    renderRow({});

    expect(trigger()).toHaveTextContent("Automatic (Haiku)");
    expect(selectOptionLabels(trigger())).toEqual([
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

    expect(trigger()).toHaveTextContent(/^Automatic$/);
  });

  it("saves the Helper model choice and keeps every other provider's", () => {
    const gemini: DesktopTaskMonitorModelChoice = {
      source: "provider",
      model: "gemini-3-flash",
    };
    const onSave = renderRow({ "acp:gemini": gemini });

    chooseSelectOption(trigger(), "Helper model (GPT-6-Luna)");
    expect(onSave).toHaveBeenLastCalledWith({
      "acp:gemini": gemini,
      claude: { source: "helper" },
    });
  });

  it("saves a provider model", () => {
    const onSave = renderRow({});

    chooseSelectOption(trigger(), "Sonnet");
    expect(onSave).toHaveBeenLastCalledWith({
      claude: { source: "provider", model: "sonnet" },
    });
  });

  it("drops a saved effort when the model changes", () => {
    const onSave = renderRow({
      claude: { source: "provider", model: "sonnet", reasoningEffort: "high" },
    });

    expect(trigger()).toHaveTextContent(/^Sonnet$/);
    chooseSelectOption(trigger(), "Opus");
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
    chooseSelectOption(trigger(), "Automatic (Haiku)");
    expect(onSave).toHaveBeenLastCalledWith({ "acp:gemini": gemini });
  });

  it("keeps a saved model the provider no longer offers", () => {
    renderRow({ claude: { source: "provider", model: "claude-3-haiku" } });

    expect(trigger()).toHaveTextContent("claude-3-haiku (not offered)");
  });
});
