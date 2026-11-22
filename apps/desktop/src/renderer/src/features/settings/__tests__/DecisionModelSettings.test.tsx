import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionModelListing, DesktopDecisionModelSettings } from "@pwragent/shared/decision-models";
import type {
  DesktopSettingsSecretState,
  DesktopSettingsSnapshot,
} from "@pwragent/shared/contracts/settings";
import type { DesktopApi } from "../../../lib/desktop-api";
import { chooseSelectOption, selectOptionLabels } from "../../../test/select";
import { DecisionModelDefaults, DecisionProviderScreen } from "../DecisionModelSettings";

const secret = (configured: boolean): DesktopSettingsSecretState =>
  ({ configured, source: configured ? "keychain" : "unset", writable: true });

// Only the fields these rows read.
function snapshot(decisionModels: DesktopDecisionModelSettings, jevKey = false): DesktopSettingsSnapshot {
  return {
    models: { decisionModels, decisionSecrets: { localApiKey: secret(false), jevApiKey: secret(jevKey) } },
  } as unknown as DesktopSettingsSnapshot;
}

afterEach(cleanup);

describe("Defaults → Decisions", () => {
  it("picks the decision model and saves the whole section", async () => {
    const onSave = vi.fn(async (_next: DesktopDecisionModelSettings) => undefined);
    render(<DecisionModelDefaults snapshot={snapshot({ model: "local", cameraCues: true })} saving={false} onSave={onSave} />);
    const picker = screen.getByRole("combobox", { name: "Decision model" });
    expect(selectOptionLabels(picker)).toEqual(["Local decision model", "TypeSafe Jev", "Off"]);
    expect(screen.getByText(/Runs clef-flash at http:\/\/127\.0\.0\.1:8787/)).toBeInTheDocument();
    await chooseSelectOption(picker, "TypeSafe Jev");
    expect(onSave).toHaveBeenCalledWith({ cameraCues: true, model: "jev" });
  });

  it("starts with nothing set up, so live voice offers no camera", () => {
    render(<DecisionModelDefaults snapshot={snapshot({})} saving={false} onSave={vi.fn(async () => undefined)} />);
    expect(screen.getByRole("combobox", { name: "Decision model" })).toHaveTextContent("Off");
    expect(screen.getByText(/Not set up/)).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: "Camera cues in live voice" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Choose the local decision model to use camera cues.")).toBeInTheDocument();
  });

  it("lets live voice use camera cues only with the local model, and says why otherwise", async () => {
    const onSave = vi.fn(async (_next: DesktopDecisionModelSettings) => undefined);
    const result = render(<DecisionModelDefaults snapshot={snapshot({ model: "local" })} saving={false} onSave={onSave} />);
    const toggle = screen.getByRole("switch", { name: "Camera cues in live voice" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await act(async () => { fireEvent.click(toggle); });
    expect(onSave).toHaveBeenCalledWith({ model: "local", cameraCues: false });

    result.rerender(<DecisionModelDefaults snapshot={snapshot({ model: "jev" })} saving={false} onSave={onSave} />);
    const locked = screen.getByRole("switch", { name: "Camera cues in live voice" });
    expect(locked).toHaveAttribute("aria-checked", "false");
    expect(locked).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/never leave this Mac/)).toBeInTheDocument();
    expect(screen.getByText(/once it has an API key/)).toBeInTheDocument();
  });
});

describe("decision provider screens", () => {
  it("saves a local endpoint on this Mac and refuses one elsewhere", async () => {
    const onSave = vi.fn(async (_next: DesktopDecisionModelSettings) => undefined);
    render(
      <DecisionProviderScreen
        provider="local"
        snapshot={snapshot({ model: "local" })}
        saving={false}
        onSave={onSave}
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
      />,
    );
    expect(screen.getByText("In use")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Clef on Hugging Face" })).toHaveAttribute("href", "https://huggingface.co/Cloudflare/clef-flash");
    const endpoint = screen.getByRole("textbox", { name: "Endpoint" });
    fireEvent.change(endpoint, { target: { value: "http://192.168.1.20:8787" } });
    fireEvent.blur(endpoint);
    expect(await screen.findByText(/Use an address on this Mac/)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(endpoint, { target: { value: "http://localhost:9911/" } });
    await act(async () => { fireEvent.keyDown(endpoint, { key: "Enter" }); });
    expect(onSave).toHaveBeenCalledWith({ model: "local", local: { endpoint: "http://localhost:9911" } });
    expect(screen.getByLabelText("API key")).toHaveAttribute("type", "password");
  });

  it("keeps the local endpoint when the model changes, and drops the section when the default is chosen again", async () => {
    const onSave = vi.fn(async (_next: DesktopDecisionModelSettings) => undefined);
    const props = { provider: "local" as const, saving: false, onSave, onClearSecret: vi.fn(async () => true), onReplaceSecret: vi.fn(async () => true) };
    const result = render(<DecisionProviderScreen {...props} snapshot={snapshot({ local: { endpoint: "http://localhost:9911" } })} />);
    const model = screen.getByRole("combobox", { name: "Model" });
    expect(model).toHaveTextContent("clef-flash (default)");
    await chooseSelectOption(model, "Other model id…");
    const typed = screen.getByRole("textbox", { name: "Model id" });
    expect(typed).toHaveFocus();
    fireEvent.change(typed, { target: { value: "clef-pro" } });
    await act(async () => { fireEvent.keyDown(typed, { key: "Enter" }); });
    expect(onSave).toHaveBeenLastCalledWith({ local: { endpoint: "http://localhost:9911", model: "clef-pro" } });
    expect(screen.queryByRole("textbox", { name: "Model id" })).not.toBeInTheDocument();

    result.rerender(<DecisionProviderScreen {...props} snapshot={snapshot({ local: { model: "clef-pro" } })} />);
    const saved = screen.getByRole("combobox", { name: "Model" });
    expect(saved).toHaveTextContent("clef-pro");
    expect(selectOptionLabels(saved)).toEqual(["clef-flash (default)", "clef-pro", "Other model id…"]);
    await chooseSelectOption(saved, "clef-flash (default)");
    expect(onSave).toHaveBeenLastCalledWith({ local: undefined });
  });

  it("offers Jev's known models with the key unsaved, and saves a choice", async () => {
    const onSave = vi.fn(async (_next: DesktopDecisionModelSettings) => undefined);
    render(
      <DecisionProviderScreen
        provider="jev"
        snapshot={snapshot({}, true)}
        saving={false}
        onSave={onSave}
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
      />,
    );
    expect(screen.getByText(/Live voice camera cues run locally/)).toBeInTheDocument();
    expect(screen.getByText(/Experimental image input/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Get an API key" })).toHaveAttribute("href", "https://console.typesafe.ai/");
    expect(screen.getByLabelText("API key")).toHaveValue("");
    const model = screen.getByRole("combobox", { name: "Model" });
    expect(selectOptionLabels(model)).toEqual([
      "jev-latest (default)",
      "jev-preview",
      "jev-1.14.0",
      "jev-1.13.0",
      "Other model id…",
    ]);
    await chooseSelectOption(model, "jev-preview");
    expect(onSave).toHaveBeenCalledWith({ jev: { model: "jev-preview" } });
  });

  it("lists the models the provider offers for the saved key, and reads them again when the key changes", async () => {
    const listDecisionModels = vi.fn(async (): Promise<DecisionModelListing> => ({
      ok: true,
      models: [{ id: "jev-preview", description: "Preview build" }, { id: "jev-latest" }, { id: "jev-team-tuned" }],
    }));
    const desktopApi = { listDecisionModels } as unknown as DesktopApi;
    const props = { provider: "jev" as const, saving: false, desktopApi, onSave: vi.fn(async () => undefined), onClearSecret: vi.fn(async () => true), onReplaceSecret: vi.fn(async () => true) };
    const result = render(<DecisionProviderScreen {...props} snapshot={snapshot({}, true)} />);
    expect(await screen.findByText(/Lists the models your key can use/)).toBeInTheDocument();
    const model = screen.getByRole("combobox", { name: "Model" });
    expect(selectOptionLabels(model)).toEqual([
      "jev-latest (default)",
      "jev-preview",
      "jev-team-tuned",
      "jev-1.14.0",
      "jev-1.13.0",
      "Other model id…",
    ]);
    expect(listDecisionModels).toHaveBeenCalledTimes(1);
    expect(listDecisionModels).toHaveBeenCalledWith({ provider: "jev" });

    listDecisionModels.mockResolvedValueOnce({ ok: false, detail: "TypeSafe rejected the API key." });
    result.rerender(<DecisionProviderScreen {...props} snapshot={snapshot({}, false)} />);
    expect(await screen.findByText("TypeSafe rejected the API key. Showing the models PwrAgent knows.")).toBeInTheDocument();
    expect(listDecisionModels).toHaveBeenCalledTimes(2);
    expect(selectOptionLabels(screen.getByRole("combobox", { name: "Model" }))).not.toContain("jev-team-tuned");
  });

  it("says when the local server does not offer the saved model", async () => {
    const desktopApi = {
      listDecisionModels: vi.fn(async (): Promise<DecisionModelListing> => ({ ok: true, models: [{ id: "clef-pro" }] })),
    } as unknown as DesktopApi;
    render(
      <DecisionProviderScreen
        provider="local"
        snapshot={snapshot({ model: "local" })}
        desktopApi={desktopApi}
        saving={false}
        onSave={vi.fn(async () => undefined)}
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("The server does not offer clef-flash. Choose one it offers.");
    expect(screen.getByText("The server offers 1 model.")).toBeInTheDocument();
  });
});

describe("turning a decision provider off", () => {
  const screenFor = (provider: "local" | "jev", settings: DesktopDecisionModelSettings, onSave = vi.fn(async (_next: DesktopDecisionModelSettings) => undefined)) => {
    render(
      <DecisionProviderScreen
        provider={provider}
        snapshot={snapshot(settings, true)}
        saving={false}
        onSave={onSave}
        onClearSecret={vi.fn(async () => true)}
        onReplaceSecret={vi.fn(async () => true)}
      />,
    );
    return onSave;
  };

  it("keeps the rest of the section when a provider is switched off and back on", async () => {
    const onSave = screenFor("jev", { model: "jev", jev: { model: "jev-2" } });
    const toggle = screen.getByRole("switch", { name: /Enabled.*TypeSafe Jev/ });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await act(async () => { fireEvent.click(toggle); });
    expect(onSave).toHaveBeenLastCalledWith({ model: "jev", jev: { enabled: false, model: "jev-2" } });
    cleanup();

    const again = screenFor("local", { model: "local", local: { enabled: false, endpoint: "http://127.0.0.1:9000" } });
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("switch", { name: /Enabled.*Local decision model/ })); });
    // On is the default, so turning it back on drops the key.
    expect(again).toHaveBeenLastCalledWith({ model: "local", local: { endpoint: "http://127.0.0.1:9000" } });
  });

  it("offers only providers that are on, and reads a choice whose provider is off as Off", () => {
    render(<DecisionModelDefaults snapshot={snapshot({ model: "local", local: { enabled: false } })} saving={false} onSave={vi.fn(async () => undefined)} />);
    const picker = screen.getByRole("combobox", { name: "Decision model" });
    expect(picker).toHaveTextContent("Off");
    expect(selectOptionLabels(picker)).toEqual(["TypeSafe Jev", "Off"]);
    expect(screen.getByText(/Local decision model is off/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Camera cues in live voice" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Turn on the local decision model to use camera cues.")).toBeInTheDocument();
  });
});
