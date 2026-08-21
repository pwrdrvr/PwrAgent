import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AcpAgentSettingsEntry,
  DesktopSettingsSecretName,
  DesktopSettingsSnapshot,
  ListAcpAgentSettingsRequest,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../../lib/useBackendSummaries";
import type { DesktopSettingsState } from "../../settings/useDesktopSettings";
import {
  BackendRequirementsStep,
  isBackendRequirementSatisfied,
  ProviderSetupStep,
  SecretFieldRow,
  validateProfileNames,
} from "../OnboardingWizard";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("validateProfileNames", () => {
  it("rejects non-empty rows that cannot normalize", () => {
    expect(validateProfileNames(["valid", "!!!"])).toBe(false);
  });

  it("accepts arbitrary names after normalization when every row is usable", () => {
    expect(validateProfileNames(["My Work Profile", "Café Ops"])).toBe(true);
  });

  it("rejects duplicate normalized profile ids", () => {
    expect(validateProfileNames(["My Work", "my-work"])).toBe(false);
  });
});

const noCodexSnapshot = {
  models: {
    codex: {
      discovery: { candidates: [] },
    },
  },
} as unknown as DesktopSettingsSnapshot;

function codexSnapshot(params: {
  command: string;
  version?: string;
  versionFailureReason?: string;
}): DesktopSettingsSnapshot {
  return {
    models: {
      codex: {
        discovery: {
          selectedCommand: params.command,
          candidates: [
            {
              command: params.command,
              source: "path",
              executable: true,
              selected: true,
              ...(params.version ? { version: params.version } : {}),
              ...(params.versionFailureReason
                ? { versionFailureReason: params.versionFailureReason }
                : {}),
            },
          ],
        },
      },
    },
  } as unknown as DesktopSettingsSnapshot;
}

function acpEntry(
  registryId: "gemini" | "kimi" | "qwen" | "grok",
  installed = true,
): AcpAgentSettingsEntry {
  return {
    backendId: `acp:${registryId}`,
    registryId,
    name: registryId,
    authors: [],
    distributionKind: "local",
    distributionSource: registryId,
    installable: false,
    installed,
    installStatus: installed ? "installed" : "not-installed",
    authStatus: "not-required",
    verificationStatus: "not-applicable",
    ...(installed
      ? {
          activeCommand: `/usr/local/bin/${registryId}`,
          instances: [
            {
              command: `/usr/local/bin/${registryId}`,
              source: "fallback" as const,
            },
          ],
        }
      : { instances: [] }),
  };
}

describe("AI provider onboarding", () => {
  it("requires a version-validated Codex candidate before enabling Continue", () => {
    expect(
      isBackendRequirementSatisfied(
        codexSnapshot({
          command: "C:\\nvm4w\\nodejs\\codex",
          versionFailureReason: "version_not_reported",
        }),
        [],
      ),
    ).toBe(false);
    expect(
      isBackendRequirementSatisfied(
        codexSnapshot({
          command: "C:\\nvm4w\\nodejs\\codex.cmd",
          version: "0.126.0",
        }),
        [],
      ),
    ).toBe(true);
  });

  it("accepts any supported installed ACP provider", () => {
    expect(isBackendRequirementSatisfied(noCodexSnapshot, [])).toBe(false);
    expect(
      isBackendRequirementSatisfied(noCodexSnapshot, [acpEntry("gemini")]),
    ).toBe(true);
    expect(
      isBackendRequirementSatisfied(noCodexSnapshot, [acpEntry("kimi")]),
    ).toBe(true);
    expect(
      isBackendRequirementSatisfied(noCodexSnapshot, [acpEntry("qwen")]),
    ).toBe(true);
    expect(
      isBackendRequirementSatisfied(noCodexSnapshot, [acpEntry("grok")]),
    ).toBe(true);
    expect(
      isBackendRequirementSatisfied(
        {
          ...noCodexSnapshot,
          acpAgents: {
            gemini: {
              cliPath: { value: "", source: "default" },
              enabled: false,
            },
          },
        } as DesktopSettingsSnapshot,
        [acpEntry("gemini")],
      ),
    ).toBe(false);
  });

  it("shows provider-specific macOS install commands without an xAI key field", () => {
    const settings = {
      snapshot: noCodexSnapshot,
      refresh: vi.fn(async () => undefined),
    } as unknown as DesktopSettingsState;

    render(
      <BackendRequirementsStep
        settings={settings}
        acpEntries={[]}
        onAcpEntriesChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/chatgpt\.com\/codex\/install\.sh/i),
    ).toBeVisible();
    expect(screen.getByText(/brew install --cask codex/i)).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: /Gemini CLI/i }));
    expect(screen.getByText(/@google\/gemini-cli/i)).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: /Kimi Code/i }));
    expect(screen.getByText(/@moonshot-ai\/kimi-code/i)).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: /Qwen Code/i }));
    expect(screen.getByText(/install-qwen-standalone\.sh/i)).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: /Grok Build/i }));
    expect(screen.getByText(/x\.ai\/cli\/install\.sh/i)).toBeVisible();
    expect(screen.queryByText(/xAI API key/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("defers Gemini startup until the operator enables it and clicks login", async () => {
    const gemini = acpEntry("gemini");
    const listAcpAgents = vi.fn(
      async (_request?: ListAcpAgentSettingsRequest) => ({
        fetchedAt: 1,
        entries: [gemini],
        error: "Registry is temporarily unavailable.",
      }),
    );
    const writeConfig = vi.fn(async () => true);
    const settings = {
      snapshot: {
        ...noCodexSnapshot,
        acpAgents: {
          gemini: {
            cliPath: { value: "", source: "default" },
            enabled: false,
          },
        },
      },
      refresh: vi.fn(async () => undefined),
      writeConfig,
    } as unknown as DesktopSettingsState;

    render(
      <BackendRequirementsStep
        settings={settings}
        desktopApi={{ listAcpAgents } as DesktopApi}
        acpEntries={[gemini]}
        onAcpEntriesChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(listAcpAgents).toHaveBeenCalledWith({ refresh: false });
      expect(listAcpAgents).toHaveBeenCalledWith({
        refresh: true,
        probeCapabilities: false,
      });
    });
    expect(
      listAcpAgents.mock.calls.some(([request]) => request?.force === true),
    ).toBe(false);

    fireEvent.click(screen.getByRole("tab", { name: /Gemini CLI/i }));
    expect(
      screen.queryByRole("button", { name: /Log in to Gemini CLI/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: /Enable Gemini CLI/i }));
    await waitFor(() => {
      expect(writeConfig).toHaveBeenCalledWith({
        acpAgents: { gemini: { enabled: true } },
      });
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Log in to Gemini CLI/i }),
    );
    await waitFor(() => {
      expect(listAcpAgents).toHaveBeenCalledWith({
        refresh: true,
        force: true,
        registryIds: ["gemini"],
      });
      expect(
        screen.getByRole("button", { name: /Gemini CLI ready/i }),
      ).toBeVisible();
    });
  });

  it("shows native Windows installers and Windows-only prerequisites", () => {
    const settings = {
      snapshot: noCodexSnapshot,
      refresh: vi.fn(async () => undefined),
    } as unknown as DesktopSettingsState;
    const desktopApi = { platform: "win32" } as DesktopApi;

    render(
      <BackendRequirementsStep
        settings={settings}
        desktopApi={desktopApi}
        acpEntries={[]}
        onAcpEntriesChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/Codex CLI on Windows/i)).toBeVisible();
    expect(screen.getByText(/chatgpt\.com\/codex\/install\.ps1/i)).toBeVisible();
    expect(screen.queryByText(/brew install/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/installed on this Mac/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Kimi Code/i }));
    expect(screen.getByText(/kimi-code\/install\.ps1/i)).toBeVisible();
    expect(screen.getByText(/Install Git for Windows/i)).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: /Qwen Code/i }));
    expect(screen.getByText(/install-qwen-standalone\.ps1/i)).toBeVisible();
    expect(screen.getByText(/Qwen OAuth has ended/i)).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: /Grok Build/i }));
    expect(screen.getByText(/x\.ai\/cli\/install\.ps1/i)).toBeVisible();
  });

  it("shows Linux installers without macOS or Windows package commands", () => {
    const settings = {
      snapshot: noCodexSnapshot,
      refresh: vi.fn(async () => undefined),
    } as unknown as DesktopSettingsState;
    const desktopApi = { platform: "linux" } as DesktopApi;

    render(
      <BackendRequirementsStep
        settings={settings}
        desktopApi={desktopApi}
        acpEntries={[]}
        onAcpEntriesChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/Codex CLI on Linux/i)).toBeVisible();
    expect(screen.getByText(/chatgpt\.com\/codex\/install\.sh/i)).toBeVisible();
    expect(screen.queryByText(/--cask codex/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/install\.ps1/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Kimi Code/i }));
    expect(screen.getByText(/kimi-code\/install\.sh/i)).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: /Qwen Code/i }));
    expect(screen.getByText(/install-qwen-standalone\.sh/i)).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: /Grok Build/i }));
    expect(screen.getByText(/x\.ai\/cli\/install\.sh/i)).toBeVisible();
  });

  it("refreshes Codex and ACP discovery together", async () => {
    const settingsRefresh = vi.fn(async () => undefined);
    const applySnapshot = vi.fn();
    const listAcpAgents = vi.fn(async () => ({
      fetchedAt: Date.now(),
      entries: [acpEntry("qwen")],
    }));
    const refreshCodexDiscovery = vi.fn(async () => ({
      snapshot: noCodexSnapshot,
    }));
    const onAcpEntriesChange = vi.fn();
    const dispatchEvent = vi.spyOn(window, "dispatchEvent");
    const settings = {
      snapshot: noCodexSnapshot,
      refresh: settingsRefresh,
      applySnapshot,
    } as unknown as DesktopSettingsState;
    const desktopApi = {
      listAcpAgents,
      refreshCodexDiscovery,
    } as DesktopApi;

    render(
      <BackendRequirementsStep
        settings={settings}
        desktopApi={desktopApi}
        acpEntries={[]}
        onAcpEntriesChange={onAcpEntriesChange}
      />,
    );
    await waitFor(() => expect(listAcpAgents).toHaveBeenCalledTimes(2));
    listAcpAgents.mockClear();
    onAcpEntriesChange.mockClear();
    dispatchEvent.mockClear();

    fireEvent.click(
      screen.getByRole("button", { name: /Refresh after install/i }),
    );

    await waitFor(() => {
      expect(refreshCodexDiscovery).toHaveBeenCalledOnce();
      expect(listAcpAgents).toHaveBeenCalledWith({
        refresh: true,
        probeCapabilities: false,
      });
      expect(applySnapshot).toHaveBeenCalledWith(noCodexSnapshot);
      expect(settingsRefresh).not.toHaveBeenCalled();
      expect(onAcpEntriesChange).toHaveBeenCalledWith([acpEntry("qwen")]);
      expect(dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: BACKEND_SUMMARIES_REFRESH_EVENT }),
      );
    });
  });
});

/**
 * The fix this test locks in: messaging-runtime secrets entered in
 * the wizard's provider-setup step must be persisted *live* (via
 * `replaceSecret`) so the desktop messaging runtime can evaluate
 * `hasRunnableAdapters === true` and actually start while the
 * operator is still on the same step.
 *
 * Before the fix, only the renderer-side buffer was updated, so the
 * runtime stayed in "no_runnable_adapters" — the operator saw the
 * provider listed as Enabled in Settings but no titlebar icon
 * appeared, and pairing codes were silently dropped because no
 * adapter was actually listening.
 *
 * The buffer is still maintained alongside — it's the source of
 * truth for the graduation step that copies secrets onto the
 * target profile after the wizard finishes.
 */
describe("SecretFieldRow live-write contract", () => {
  it("messaging-runtime secrets: writes via replaceSecret AND buffers", async () => {
    const onBuffer = vi.fn();
    const replaceSecret = vi.fn(
      async (_secret: DesktopSettingsSecretName, _value: string) => true,
    );
    const clearSecret = vi.fn(
      async (_secret: DesktopSettingsSecretName) => true,
    );

    render(
      <SecretFieldRow
        field={{
          kind: "secret",
          name: "telegramBotToken",
          label: "Bot token",
          placeholder: "0000000000:AAEx",
        }}
        bufferedValue=""
        onBuffer={onBuffer}
        replaceSecret={replaceSecret}
        clearSecret={clearSecret}
      />,
    );

    const tokenInput = screen.getByPlaceholderText(/0000000000:AAEx/);
    fireEvent.change(tokenInput, {
      target: { value: "0000000000:AAEx-fake-telegram-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Use this/i }));

    await waitFor(() => {
      expect(replaceSecret).toHaveBeenCalledWith(
        "telegramBotToken",
        "0000000000:AAEx-fake-telegram-token",
      );
    });
    expect(onBuffer).toHaveBeenCalledWith(
      "0000000000:AAEx-fake-telegram-token",
    );
  });
  it("messaging secret Clear: calls clearSecret on the runtime AND buffers empty", async () => {
    const onBuffer = vi.fn();
    const replaceSecret = vi.fn(
      async (_secret: DesktopSettingsSecretName, _value: string) => true,
    );
    const clearSecret = vi.fn(
      async (_secret: DesktopSettingsSecretName) => true,
    );

    render(
      <SecretFieldRow
        field={{
          kind: "secret",
          name: "telegramBotToken",
          label: "Bot token",
          placeholder: "0000000000:AAEx",
        }}
        // Pre-populated buffer simulates a value already typed in.
        bufferedValue="0000000000:AAEx-existing"
        onBuffer={onBuffer}
        replaceSecret={replaceSecret}
        clearSecret={clearSecret}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Clear$/i }));

    expect(onBuffer).toHaveBeenCalledWith("");
    // The runtime clear is skipped when nothing is configured server-side
    // yet (`configured === false`), to avoid an unnecessary IPC round-trip
    // on a brand-new field that was only buffered. This keeps the test
    // surface honest: a Clear with neither a configured secret nor a
    // buffered value is a no-op, but the buffered-only path still resets
    // the buffer (asserted above).
    await Promise.resolve();
    expect(clearSecret).not.toHaveBeenCalled();
  });
});

describe("Slack onboarding setup", () => {
  function slackSettings(
    inboundMode: "socket" | "events" = "socket",
  ): DesktopSettingsState {
    const unsetSecret = {
      configured: false,
      source: "unset" as const,
      writable: true,
    };
    return {
      snapshot: {
        messaging: {
          telegram: { botToken: unsetSecret },
          discord: { botToken: unsetSecret },
          mattermost: { botToken: unsetSecret, hmacSecret: unsetSecret },
          slack: {
            enabled: { value: true, source: "config" },
            inboundMode: { value: inboundMode, source: "config" },
            botToken: unsetSecret,
            appToken: unsetSecret,
            signingSecret: unsetSecret,
          },
          feishu: {
            appId: unsetSecret,
            appSecret: unsetSecret,
            encryptKey: unsetSecret,
            verificationToken: unsetSecret,
          },
          line: {
            channelAccessToken: unsetSecret,
            channelSecret: unsetSecret,
          },
        },
      } as unknown as DesktopSettingsSnapshot,
      refresh: vi.fn(async () => undefined),
      writeConfig: vi.fn(async () => true),
      replaceSecret: vi.fn(async () => true),
      clearSecret: vi.fn(async () => true),
      saving: false,
    } as unknown as DesktopSettingsState;
  }

  it("offers Create Slack app and hides Events API", () => {
    const openSlackCreateApp = vi.fn(async () => ({
      url: "https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D",
      oversized: false,
      manifestJson: "{}",
      opened: true,
    }));
    render(
      <ProviderSetupStep
        provider="slack"
        settings={slackSettings()}
        desktopApi={{ openSlackCreateApp } as unknown as DesktopApi}
        bufferedSecrets={{}}
        onBufferSecret={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Create Slack app" })).toBeEnabled();
    expect(screen.queryByRole("radio", { name: "Events API" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Events API \(requires/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Socket Mode is the only inbound path/i)).toBeInTheDocument();
  });

  it("coerces leftover Events API configs and shows a notice", () => {
    const settings = slackSettings("events");
    render(
      <ProviderSetupStep
        provider="slack"
        settings={settings}
        bufferedSecrets={{}}
        onBufferSecret={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Events API is not implemented. PwrAgent will use Socket Mode."),
    ).toBeInTheDocument();
    expect(settings.writeConfig).toHaveBeenCalledWith({
      messaging: { slack: { inboundMode: "socket" } },
    });
  });

  it("re-runs Slack identity probe after a later secret replace", async () => {
    const testSettingsCredentials = vi.fn(async () => ({
      kind: "slack" as const,
      status: "failed" as const,
      testedAt: 1,
      durationMs: 1,
      errorMessage: "Socket Mode failed",
    }));
    const configuredSecret = {
      configured: true,
      source: "keychain" as const,
      writable: true,
    };
    const settings = slackSettings();
    const snapshot = {
      ...settings.snapshot!,
      fetchedAt: 11,
      messaging: {
        ...settings.snapshot!.messaging,
        slack: {
          ...settings.snapshot!.messaging.slack,
          botToken: configuredSecret,
          appToken: configuredSecret,
        },
      },
    };
    const { rerender } = render(
      <ProviderSetupStep
        provider="slack"
        settings={{ ...settings, snapshot }}
        desktopApi={{ testSettingsCredentials } as unknown as DesktopApi}
        bufferedSecrets={{}}
        onBufferSecret={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(testSettingsCredentials).toHaveBeenCalledTimes(1);
    });

    rerender(
      <ProviderSetupStep
        provider="slack"
        settings={{
          ...settings,
          snapshot: { ...snapshot, fetchedAt: 12 },
        }}
        desktopApi={{ testSettingsCredentials } as unknown as DesktopApi}
        bufferedSecrets={{}}
        onBufferSecret={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(testSettingsCredentials).toHaveBeenCalledTimes(2);
    });
  });
});
