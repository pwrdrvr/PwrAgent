import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettingsConfigPatch, DesktopSettingsSnapshot } from "@pwragent/shared/contracts/settings";
import {
  resolveResearchHarnessSource,
  type ResearchHarnessConfig,
  type ResearchHarnessSource,
  type ResearchMathosConfig,
} from "@pwragent/shared/research-harness";
import type { DesktopApi } from "../../../lib/desktop-api";
import { chooseSelectOption } from "../../../test/select";
import { ResearchHarnessSettings } from "../ResearchHarnessSettings";

afterEach(cleanup);

const TEAM = "o-12345678-1234-4123-8123-123456789abc";
const OTHER_TEAM = "o-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

type Saved = { harness?: ResearchHarnessConfig; mathos?: ResearchMathosConfig; source?: ResearchHarnessSource; keyStored?: boolean; researchOff?: boolean };

function snapshot(saved: Saved): DesktopSettingsSnapshot {
  return {
    experimental: { researchEnabled: { value: saved.researchOff !== true, source: "config" } },
    research: {
      source: resolveResearchHarnessSource(saved),
      ...(saved.harness ? { harness: saved.harness } : {}),
      ...(saved.mathos ? { mathos: saved.mathos } : {}),
      platformApiKey: { configured: saved.keyStored ?? false, source: saved.keyStored ? "secret-store" : "unset", writable: true },
    },
  } as unknown as DesktopSettingsSnapshot;
}

function renderForm(options: Saved & { api?: Partial<DesktopApi> } = {}) {
  const onWriteConfig = vi.fn(async (_patch: DesktopSettingsConfigPatch, _onError?: (message: string) => void) => true);
  const onReplaceSecret = vi.fn(async () => true);
  const onClearSecret = vi.fn(async () => true);
  render(
    <ResearchHarnessSettings
      desktopApi={options.api as DesktopApi | undefined}
      saving={false}
      snapshot={snapshot(options)}
      onWriteConfig={onWriteConfig}
      onReplaceSecret={onReplaceSecret}
      onClearSecret={onClearSecret}
    />,
  );
  return { onWriteConfig, onReplaceSecret, onClearSecret };
}

const bridgeSource = () => fireEvent.click(screen.getByRole("radio", { name: "Custom bridge" }));

describe("ResearchHarnessSettings — MathOS Platform", () => {
  it("reads the MathOS Platform by default: key, team and address, no bridge fields", () => {
    renderForm();
    expect(screen.getByRole("radio", { name: "MathOS Platform" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("MathOS Platform API key", { selector: "input" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Team" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Bridge program")).toBeNull();
    // Finding teams needs the key first.
    expect(screen.getByText("Store the API key, then find your teams.")).toBeInTheDocument();
  });

  it("finds the key's teams, picks the only one, and saves source and team in one patch", async () => {
    const listMathosTeams = vi.fn(async () => ({ ok: true as const, teams: [{ id: TEAM, name: "Contrived team" }] }));
    const { onWriteConfig } = renderForm({ keyStored: true, api: { listMathosTeams } });
    fireEvent.click(screen.getByRole("button", { name: "Find teams" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Team" })).toHaveTextContent("Contrived team"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onWriteConfig).toHaveBeenCalledTimes(1));
    expect(onWriteConfig.mock.calls[0]?.[0]).toEqual({
      research: { source: "mathos", mathos: { team: TEAM, origin: "https://os.openmathmodel.org" } },
    });
  });

  it("lets the operator choose among several teams", async () => {
    const listMathosTeams = vi.fn(async () => ({ ok: true as const, teams: [{ id: TEAM, name: "Contrived team" }, { id: OTHER_TEAM, name: "Second team" }] }));
    const { onWriteConfig } = renderForm({ keyStored: true, api: { listMathosTeams } });
    fireEvent.click(screen.getByRole("button", { name: "Find teams" }));
    await waitFor(() => expect(listMathosTeams).toHaveBeenCalled());
    chooseSelectOption(screen.getByRole("combobox", { name: "Team" }), /Second team/);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onWriteConfig).toHaveBeenCalledTimes(1));
    expect(onWriteConfig.mock.calls[0]?.[0]?.research?.mathos?.team).toBe(OTHER_TEAM);
  });

  it("shows the platform's refusal and writes nothing without a team or with a bad address", async () => {
    const listMathosTeams = vi.fn(async () => ({ ok: false as const, error: "The MathOS Platform did not accept this API key." }));
    const { onWriteConfig } = renderForm({ keyStored: true, api: { listMathosTeams } });
    fireEvent.click(screen.getByRole("button", { name: "Find teams" }));
    expect(await screen.findByText("The MathOS Platform did not accept this API key.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Platform address"), { target: { value: "https://os.example.test/app" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter only the platform’s address, without a path.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Platform address"), { target: { value: "" } });
    expect(onWriteConfig).not.toHaveBeenCalled();
  });

  it("stores the Platform key through the secret store and only reports presence", async () => {
    const { onReplaceSecret, onWriteConfig } = renderForm({ keyStored: true });
    const row = screen.getByText("MathOS Platform API key").closest(".settings-field") as HTMLElement;
    const input = within(row).getByLabelText("MathOS Platform API key", { selector: "input" });
    // Write-only: a password box that is never filled from the store.
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveValue("");
    fireEvent.change(input, { target: { value: "nuc_ak_contrived_key_0000" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onReplaceSecret).toHaveBeenCalledWith("mathosPlatformApiKey", "nuc_ak_contrived_key_0000"));
    // The key is never part of a config write.
    expect(onWriteConfig).not.toHaveBeenCalled();
  });

  it("checks the saved connection and lists what the team's VM offers", async () => {
    const checkResearchHarnessBridge = vi.fn(async () => ({
      ok: true as const, checkedAt: 1,
      capabilities: { import: true, discovery: false, execute: false, cancel: false, researchFunctions: false },
    }));
    renderForm({ keyStored: true, mathos: { team: TEAM }, api: { checkResearchHarnessBridge } });
    fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
    expect(await screen.findByText("MathOS Platform · responding")).toBeInTheDocument();
    const supports = screen.getByLabelText("Source supports");
    expect(within(supports).getByText("Import")).toHaveTextContent("Import supported");
    expect(within(supports).getByText("Execute")).toHaveTextContent("Execute not supported");
  });

  it("asks for Research runs to be on instead of checking while they are off", () => {
    const checkResearchHarnessBridge = vi.fn();
    renderForm({ keyStored: true, mathos: { team: TEAM }, researchOff: true, api: { checkResearchHarnessBridge } });
    expect(screen.getByRole("button", { name: "Check connection" })).toBeDisabled();
    expect(screen.getByText("Turn on Research runs to check.")).toBeInTheDocument();
    expect(checkResearchHarnessBridge).not.toHaveBeenCalled();
  });

  it("says what the hosted platform supports today", () => {
    renderForm();
    const support = screen.getByRole("list", { name: "MathOS Platform support" });
    expect(support).toHaveTextContent("Available Import swarm records");
    expect(support).toHaveTextContent("Not yet Run or stop a swarm");
  });
});

describe("ResearchHarnessSettings — custom bridge", () => {
  it("keeps a profile that already has a bridge on it", () => {
    renderForm({ harness: { command: "/opt/example/harness-bridge", args: [] } });
    expect(screen.getByRole("radio", { name: "Custom bridge" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Bridge program")).toHaveValue("/opt/example/harness-bridge");
  });

  it("saves the source with one normalized [research.harness] patch: arguments per line, blanks absent", async () => {
    const { onWriteConfig } = renderForm();
    bridgeSource();
    fireEvent.change(screen.getByLabelText("Bridge program"), { target: { value: " /opt/example/harness-bridge " } });
    fireEvent.change(screen.getByLabelText("Bridge arguments"), { target: { value: "--profile\n\n contrived \n" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "example-model" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onWriteConfig).toHaveBeenCalledTimes(1));
    expect(onWriteConfig.mock.calls[0]?.[0]).toEqual({
      research: { source: "bridge", harness: { command: "/opt/example/harness-bridge", args: ["--profile", "contrived"], model: "example-model" } },
    });
  });

  it("keeps hand-written arguments exactly when only another field changes", async () => {
    // Shapes the one-per-line textarea cannot represent: blank, padded, tab, embedded newline.
    const args = ["--name", "", " padded ", "a\tb", "two\nlines"];
    const { onWriteConfig } = renderForm({ harness: { command: "/opt/example/harness-bridge", args } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "example-model" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onWriteConfig).toHaveBeenCalledTimes(1));
    expect(onWriteConfig.mock.calls[0]?.[0]).toEqual({
      research: { source: "bridge", harness: { command: "/opt/example/harness-bridge", args, model: "example-model" } },
    });
  });

  it("shows a field's error inline and writes nothing", async () => {
    const { onWriteConfig } = renderForm();
    bridgeSource();
    fireEvent.change(screen.getByLabelText("Bridge program"), { target: { value: "harness-bridge" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Use the program’s full path.");
    expect(onWriteConfig).not.toHaveBeenCalled();
  });

  it("removes the bridge with a null patch", async () => {
    const { onWriteConfig } = renderForm({ harness: { command: "/opt/example/harness-bridge", args: [] } });
    fireEvent.click(screen.getByRole("button", { name: "Remove bridge" }));
    await waitFor(() => expect(onWriteConfig).toHaveBeenCalledWith({ research: { harness: null } }, expect.any(Function)));
  });
});
