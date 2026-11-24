import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettingsConfigPatch, DesktopSettingsSnapshot } from "@pwragent/shared/contracts/settings";
import type { ResearchHarnessConfig } from "@pwragent/shared/research-harness";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ResearchHarnessSettings } from "../ResearchHarnessSettings";

afterEach(cleanup);

function snapshot(harness?: ResearchHarnessConfig, keyStored = false): DesktopSettingsSnapshot {
  return {
    research: {
      ...(harness ? { harness } : {}),
      platformApiKey: { configured: keyStored, source: keyStored ? "secret-store" : "unset", writable: true },
    },
  } as unknown as DesktopSettingsSnapshot;
}

function renderForm(options: { harness?: ResearchHarnessConfig; keyStored?: boolean; api?: Partial<DesktopApi> } = {}) {
  const onWriteConfig = vi.fn(async (_patch: DesktopSettingsConfigPatch, _onError?: (message: string) => void) => true);
  const onReplaceSecret = vi.fn(async () => true);
  const onClearSecret = vi.fn(async () => true);
  render(
    <ResearchHarnessSettings
      desktopApi={options.api as DesktopApi | undefined}
      saving={false}
      snapshot={snapshot(options.harness, options.keyStored)}
      onWriteConfig={onWriteConfig}
      onReplaceSecret={onReplaceSecret}
      onClearSecret={onClearSecret}
    />,
  );
  return { onWriteConfig, onReplaceSecret, onClearSecret };
}

describe("ResearchHarnessSettings", () => {
  it("saves one normalized [research.harness] patch: arguments per line, blanks absent", async () => {
    const { onWriteConfig } = renderForm();
    fireEvent.change(screen.getByLabelText("Bridge program"), { target: { value: " /opt/example/harness-bridge " } });
    fireEvent.change(screen.getByLabelText("Bridge arguments"), { target: { value: "--profile\n\n contrived \n" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "example-model" } });
    fireEvent.click(screen.getByRole("button", { name: "Save bridge" }));
    await waitFor(() => expect(onWriteConfig).toHaveBeenCalledTimes(1));
    expect(onWriteConfig.mock.calls[0]?.[0]).toEqual({
      research: { harness: { command: "/opt/example/harness-bridge", args: ["--profile", "contrived"], model: "example-model" } },
    });
  });

  it("keeps hand-written arguments exactly when only another field changes", async () => {
    // Shapes the one-per-line textarea cannot represent: blank, padded, tab, embedded newline.
    const args = ["--name", "", " padded ", "a\tb", "two\nlines"];
    const { onWriteConfig } = renderForm({ harness: { command: "/opt/example/harness-bridge", args } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "example-model" } });
    fireEvent.click(screen.getByRole("button", { name: "Save bridge" }));
    await waitFor(() => expect(onWriteConfig).toHaveBeenCalledTimes(1));
    expect(onWriteConfig.mock.calls[0]?.[0]).toEqual({
      research: { harness: { command: "/opt/example/harness-bridge", args, model: "example-model" } },
    });
  });

  it("shows a field's error inline and writes nothing", async () => {
    const { onWriteConfig } = renderForm();
    fireEvent.change(screen.getByLabelText("Bridge program"), { target: { value: "harness-bridge" } });
    fireEvent.click(screen.getByRole("button", { name: "Save bridge" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Use the program’s full path.");
    fireEvent.change(screen.getByLabelText("Bridge program"), { target: { value: "/opt/example/harness-bridge" } });
    fireEvent.change(screen.getByLabelText("Model key variable"), { target: { value: "MATHOS_PLATFORM_API_KEY" } });
    fireEvent.click(screen.getByRole("button", { name: "Save bridge" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That name is the Platform key’s.");
    expect(onWriteConfig).not.toHaveBeenCalled();
  });

  it("removes the bridge with a null patch", async () => {
    const { onWriteConfig } = renderForm({ harness: { command: "/opt/example/harness-bridge", args: [] } });
    fireEvent.click(screen.getByRole("button", { name: "Remove bridge" }));
    await waitFor(() => expect(onWriteConfig).toHaveBeenCalledWith({ research: { harness: null } }, expect.any(Function)));
  });

  it("stores the Platform key through the secret store and only reports presence", async () => {
    const { onReplaceSecret, onWriteConfig } = renderForm({ keyStored: true });
    const row = screen.getByText("MathOS Platform API key").closest(".settings-field") as HTMLElement;
    expect(within(row).queryByDisplayValue(/./)).toBeNull();
    const input = within(row).getByLabelText("MathOS Platform API key", { selector: "input" });
    // Write-only: a password box that is never filled from the store.
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveValue("");
    fireEvent.change(input, { target: { value: "mathos_contrived_key_0000" } });
    // A stored key offers Replace; Enter commits either way.
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onReplaceSecret).toHaveBeenCalledWith("mathosPlatformApiKey", "mathos_contrived_key_0000"));
    // The key is never part of a config write.
    expect(onWriteConfig).not.toHaveBeenCalled();
  });

  it("checks the saved bridge and lists what it supports", async () => {
    const checkResearchHarnessBridge = vi.fn(async () => ({
      ok: true as const, checkedAt: 1,
      capabilities: { import: true, discovery: true, execute: false, cancel: false, researchFunctions: false },
    }));
    renderForm({ harness: { command: "/opt/example/harness-bridge", args: [] }, api: { checkResearchHarnessBridge } });
    fireEvent.click(screen.getByRole("button", { name: "Check bridge" }));
    expect(await screen.findByText("harness-bridge · responding")).toBeInTheDocument();
    const supports = screen.getByLabelText("Bridge supports");
    expect(within(supports).getByText("Import")).toHaveTextContent("Import supported");
    expect(within(supports).getByText("Execute")).toHaveTextContent("Execute not supported");
    expect(checkResearchHarnessBridge).toHaveBeenCalledTimes(1);
  });

  it("says what the hosted platform supports today", () => {
    renderForm();
    const support = screen.getByRole("list", { name: "MathOS Platform support" });
    expect(support).toHaveTextContent("Available Import swarm records");
    expect(support).toHaveTextContent("Not yet Run or stop a swarm");
  });
});
