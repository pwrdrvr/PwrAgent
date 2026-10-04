import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopDecisionModelSettings,
  DesktopSettingsSecretState,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";
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
    render(<DecisionModelDefaults snapshot={snapshot({ cameraCues: true })} saving={false} onSave={onSave} />);
    const picker = screen.getByRole("combobox", { name: "Decision model" });
    expect(selectOptionLabels(picker)).toEqual(["Local decision model", "TypeSafe Jev", "Off"]);
    expect(screen.getByText(/Runs clef-flash at http:\/\/127\.0\.0\.1:8787/)).toBeInTheDocument();
    await chooseSelectOption(picker, "TypeSafe Jev");
    expect(onSave).toHaveBeenCalledWith({ cameraCues: true, model: "jev" });
  });

  it("lets live voice use camera cues only with the local model, and says why otherwise", async () => {
    const onSave = vi.fn(async (_next: DesktopDecisionModelSettings) => undefined);
    const result = render(<DecisionModelDefaults snapshot={snapshot({})} saving={false} onSave={onSave} />);
    const toggle = screen.getByRole("switch", { name: "Camera cues in live voice" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith({ cameraCues: false }));

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
    fireEvent.keyDown(endpoint, { key: "Enter" });
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith({ model: "local", local: { endpoint: "http://localhost:9911" } }));
    expect(screen.getByLabelText("API key")).toHaveAttribute("type", "password");
  });

  it("keeps the local endpoint when the model changes, and drops the section when both are cleared", async () => {
    const onSave = vi.fn(async (_next: DesktopDecisionModelSettings) => undefined);
    const props = { provider: "local" as const, saving: false, onSave, onClearSecret: vi.fn(async () => true), onReplaceSecret: vi.fn(async () => true) };
    const result = render(<DecisionProviderScreen {...props} snapshot={snapshot({ local: { endpoint: "http://localhost:9911" } })} />);
    const model = screen.getByRole("textbox", { name: "Model" });
    expect(model).toHaveAttribute("placeholder", "clef-flash");
    fireEvent.change(model, { target: { value: "clef-pro" } });
    fireEvent.blur(model);
    await vi.waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ local: { endpoint: "http://localhost:9911", model: "clef-pro" } }));
    result.rerender(<DecisionProviderScreen {...props} snapshot={snapshot({ local: { model: "clef-pro" } })} />);
    const cleared = screen.getByRole("textbox", { name: "Model" });
    fireEvent.change(cleared, { target: { value: "" } });
    fireEvent.blur(cleared);
    await vi.waitFor(() => expect(onSave).toHaveBeenLastCalledWith({ local: undefined }));
  });

  it("keeps Jev's key write-only and its model editable", async () => {
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
    expect(screen.getByText(/camera frames never go to it/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Get an API key" })).toHaveAttribute("href", "https://console.typesafe.ai/");
    expect(screen.getByLabelText("API key")).toHaveValue("");
    const model = screen.getByRole("textbox", { name: "Model" });
    expect(model).toHaveAttribute("placeholder", "jev-latest");
    fireEvent.change(model, { target: { value: "jev-preview" } });
    fireEvent.blur(model);
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith({ jev: { model: "jev-preview" } }));
  });
});
