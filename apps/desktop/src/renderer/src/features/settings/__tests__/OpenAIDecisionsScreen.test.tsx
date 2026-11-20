import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  DesktopOpenAIDecisionsSettings,
  DesktopSettingsSecretState,
  DesktopSettingsSnapshot,
} from "@pwragent/shared/contracts/settings";
import { OpenAIDecisionsScreen } from "../OpenAIDecisionsSettings";
import { modelServiceEntries } from "../provider-kinds";

const secret = (configured: boolean): DesktopSettingsSecretState =>
  ({ configured, source: configured ? "keychain" : "unset", writable: true });

// Only the fields these rows read.
function snapshot(openaiDecisions: DesktopOpenAIDecisionsSettings, decisionModels = {}): DesktopSettingsSnapshot {
  return {
    models: {
      decisionModels,
      decisionSecrets: { localApiKey: secret(false), jevApiKey: secret(true) },
      openaiDecisions: { ...openaiDecisions, apiKey: secret(true) },
    },
  } as unknown as DesktopSettingsSnapshot;
}

afterEach(cleanup);

it("switches OpenAI Decisions off and on without losing its project id", async () => {
  const onSave = vi.fn(async (_next: DesktopOpenAIDecisionsSettings) => undefined);
  const view = (settings: DesktopOpenAIDecisionsSettings) => (
    <OpenAIDecisionsScreen
      snapshot={snapshot(settings)}
      saving={false}
      onSave={onSave}
      onClearSecret={vi.fn(async () => true)}
      onReplaceSecret={vi.fn(async () => true)}
    />
  );
  const result = render(view({ projectId: "proj_test" }));
  await act(async () => { fireEvent.click(screen.getByRole("switch", { name: /Enabled.*OpenAI Decisions/ })); });
  expect(onSave).toHaveBeenLastCalledWith({ projectId: "proj_test", enabled: false });

  result.rerender(view({ enabled: false, projectId: "proj_test" }));
  expect(screen.getByText("Disabled")).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByRole("switch", { name: /Enabled.*OpenAI Decisions/ })); });
  expect(onSave).toHaveBeenLastCalledWith({ projectId: "proj_test" });
});

it("marks every decision provider that is off with the off chip in the nav, key or not", () => {
  const entries = modelServiceEntries(snapshot(
    { enabled: false },
    { local: { enabled: false }, jev: { enabled: false } },
  ));
  for (const name of ["Local decision model", "TypeSafe Jev", "OpenAI Decisions"]) {
    expect(entries.find((entry) => entry.name === name)?.nav, name).toEqual({ dot: "off", chip: "off" });
  }
  const on = modelServiceEntries(snapshot({}));
  expect(on.find((entry) => entry.name === "TypeSafe Jev")?.nav).toEqual({ dot: "ok" });
});
