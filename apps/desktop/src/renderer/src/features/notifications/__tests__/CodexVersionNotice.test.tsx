import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopCodexVersionAdvisory,
  DesktopSettingsSnapshot,
} from "@pwragent/shared/contracts/settings";
import {
  CodexVersionNotice,
  buildCodexVersionNotice,
} from "../CodexVersionNotice";
import { AppNoticeToast, type AppNoticeToastNotice } from "../AppNoticeToast";
import type { ManagedRuntimeProgress } from "../../../../../shared/managed-runtime-progress";
import { checkForManagedCodexUpdates } from "../../settings/managed-codex-actions";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function advisory(patch: Partial<DesktopCodexVersionAdvisory> = {}): DesktopCodexVersionAdvisory {
  return {
    version: "0.152.0",
    minimumVersion: "0.159.0",
    command: "/opt/homebrew/bin/codex",
    installer: "homebrew",
    upgradeCommand: "brew upgrade codex",
    ...patch,
  };
}

function build(patch: Partial<DesktopCodexVersionAdvisory> | null, extra: {
  dismissedVersion?: string;
} = {}) {
  const handlers = {
    onCopyCommand: vi.fn(),
    onDismiss: vi.fn(),
    onOpenCodexSettings: vi.fn(),
    onOpenReleasePage: vi.fn(),
  };
  const notice = buildCodexVersionNotice({
    advisory: patch === null ? undefined : advisory(patch),
    ...extra,
    ...handlers,
  });
  return { handlers, notice };
}

describe("buildCodexVersionNotice", () => {
  it("says what is missing and gives a Homebrew user the command to copy", () => {
    const { handlers, notice } = build({});
    expect(notice).toMatchObject({
      id: "codex-version:0.152.0",
      autoDismiss: false,
      tone: "warning",
      copyText: "brew upgrade codex",
    });
    expect(notice?.message).toBe(
      "Codex 0.152.0 is too old for GPT-6.1-Sol. Update to Codex 0.159.0+ to use it.",
    );
    expect(notice?.detail).toContain("brew upgrade codex");

    const copy = notice?.actions?.find((action) => action.label === "Copy command");
    copy?.onClick();
    expect(handlers.onCopyCommand).toHaveBeenCalledWith("brew upgrade codex");
    notice?.actions?.find((action) => action.label === "Open Codex settings")?.onClick();
    expect(handlers.onOpenCodexSettings).toHaveBeenCalledOnce();
  });

  it("points an unrecognized install at the release page instead of inventing a command", () => {
    const { handlers, notice } = build({
      installer: "unknown",
      upgradeCommand: undefined,
    });
    expect(notice?.copyText).toBeUndefined();
    expect(notice?.detail).not.toMatch(/brew|npm/u);
    notice?.actions?.find((action) => action.label === "Open releases")?.onClick();
    expect(handlers.onOpenReleasePage).toHaveBeenCalledWith(
      "https://github.com/openai/codex/releases/latest",
    );
  });

  it("sends an app-bundled Codex to settings, with app update guidance and no command", () => {
    const { notice } = build({ installer: "application", upgradeCommand: undefined });
    expect(notice?.actions?.map((action) => action.label)).toEqual(["Open Codex settings"]);
    expect(notice?.copyText).toBeUndefined();
    expect(notice?.detail).toContain("ChatGPT / Codex app");
  });

  it("tells a stale PwrAgent build to check for updates rather than install anything", () => {
    const { notice } = build({ installer: "pwragent", upgradeCommand: undefined });
    expect(notice?.title).toBe("PwrAgent's Codex build is out of date");
    expect(notice?.actions?.map((action) => action.label)).toEqual(["Open Codex settings"]);
  });

  it("tells an old OpenAI Codex that PwrAgent installed that PwrAgent updates it", () => {
    const { notice } = build({ installer: "pwragent-openai", upgradeCommand: undefined });
    expect(notice?.title).toBe("Update Codex for GPT-6.1-Sol");
    expect(notice?.detail).toContain("installed this Codex from OpenAI");
    expect(notice?.detail).not.toContain("custom build");
    expect(notice?.actions?.map((action) => action.label)).toEqual(["Open Codex settings"]);
  });

  it("leads with OpenAI's Codex for an old Homebrew Codex and keeps the command beside it", () => {
    const onInstall = vi.fn();
    const notice = buildCodexVersionNotice({
      advisory: advisory(),
      onCopyCommand: vi.fn(),
      onDismiss: vi.fn(),
      onOpenCodexSettings: vi.fn(),
      onOpenReleasePage: vi.fn(),
      openAiInstall: { onInstall },
    });
    expect(notice?.actions?.map((action) => [action.label, action.tone])).toEqual([
      ["Install latest Codex", "primary"],
      ["Copy command", "secondary"],
    ]);
    expect(notice?.detail).toContain("install OpenAI's latest Codex");
    expect(notice?.detail).toContain("brew upgrade codex");
    expect(notice?.copyText).toBe("brew upgrade codex");
    notice?.actions?.[0]?.onClick();
    expect(onInstall).toHaveBeenCalledOnce();
  });

  it.each([
    ["application", "ChatGPT / Codex app"],
    ["unknown", "the way you installed it"],
  ] as const)("offers OpenAI's Codex for an old %s Codex", (installer, guidance) => {
    const notice = buildCodexVersionNotice({
      advisory: advisory({ installer, upgradeCommand: undefined }),
      onCopyCommand: vi.fn(),
      onDismiss: vi.fn(),
      onOpenCodexSettings: vi.fn(),
      onOpenReleasePage: vi.fn(),
      openAiInstall: { onInstall: vi.fn() },
    });
    expect(notice?.actions?.map((action) => action.label))
      .toEqual(["Install latest Codex", "Open Codex settings"]);
    expect(notice?.detail).toContain(guidance);
    expect(notice?.detail).not.toContain("custom build");
  });

  it("drops the install button while the install runs, keeping the same guidance", () => {
    const notice = buildCodexVersionNotice({
      advisory: advisory(),
      onCopyCommand: vi.fn(),
      onDismiss: vi.fn(),
      onOpenCodexSettings: vi.fn(),
      onOpenReleasePage: vi.fn(),
      openAiInstall: {},
    });
    expect(notice?.actions?.map((action) => action.label)).toEqual(["Copy command"]);
    expect(notice?.detail).toContain("install OpenAI's latest Codex");
  });

  it("leaves PwrAgent's own installs on their own guidance", () => {
    for (const installer of ["pwragent", "pwragent-openai"] as const) {
      const notice = buildCodexVersionNotice({
        advisory: advisory({ installer, upgradeCommand: undefined }),
        onCopyCommand: vi.fn(),
        onDismiss: vi.fn(),
        onOpenCodexSettings: vi.fn(),
        onOpenReleasePage: vi.fn(),
        openAiInstall: { onInstall: vi.fn() },
      });
      expect(notice?.actions?.map((action) => action.label)).toEqual(["Open Codex settings"]);
    }
  });

  it("names the installed OpenAI release once it is ready", () => {
    const notice = buildCodexVersionNotice({
      advisory: advisory(),
      onCopyCommand: vi.fn(),
      onDismiss: vi.fn(),
      onOpenCodexSettings: vi.fn(),
      onOpenReleasePage: vi.fn(),
      openAiInstalled: { version: "0.160.0" },
    });
    expect(notice).toMatchObject({
      tone: "success",
      title: "OpenAI Codex installed",
      message: "Codex 0.160.0 is installed and ready. PwrAgent keeps it up to date.",
    });
  });

  it("stays quiet with no advisory, or once the version was dismissed", () => {
    expect(build(null).notice).toBeUndefined();
    expect(build({}, { dismissedVersion: "0.152.0" }).notice).toBeUndefined();
    // A different old version is new information.
    expect(build({ version: "0.153.0" }, { dismissedVersion: "0.152.0" }).notice)
      .toBeDefined();
  });

  it("closing the toast records the version", () => {
    const { handlers, notice } = build({});
    notice?.onDismiss?.();
    expect(handlers.onDismiss).toHaveBeenCalledWith("0.152.0");
  });
});

/** The preload bridge: every subscriber hears every runtime's events. */
function progressBridge(initial: ManagedRuntimeProgress[] = []) {
  const handlers = new Set<(event: ManagedRuntimeProgress) => void>();
  const api = {
    readManagedRuntimeProgress: vi.fn(async () => initial),
    onManagedRuntimeProgress: vi.fn((handler: (event: ManagedRuntimeProgress) => void) => {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    }),
  };
  const sendProgress = (event: ManagedRuntimeProgress) => {
    for (const handler of handlers) handler(event);
  };
  return { api, sendProgress };
}

describe("CodexVersionNotice", () => {
  function snapshot(value: DesktopCodexVersionAdvisory | undefined): DesktopSettingsSnapshot {
    return { models: { codex: { versionAdvisory: value } } } as unknown as DesktopSettingsSnapshot;
  }

  it("stays quiet while a bootstrap snapshot has no model settings", () => {
    const onNoticeChanged = vi.fn();
    render(<CodexVersionNotice snapshot={{} as DesktopSettingsSnapshot}
      onNoticeChanged={onNoticeChanged} onOpenCodexSettings={vi.fn()} />);
    expect(onNoticeChanged).toHaveBeenCalledWith(undefined);
  });

  it("shows once at startup and does not re-show for an unchanged advisory", () => {
    // App passes stable callbacks (`useCallback`), so the test does too.
    const openSettings = () => undefined;
    const seen: Array<AppNoticeToastNotice | undefined> = [];
    const onNoticeChanged = (notice: AppNoticeToastNotice | undefined) => {
      seen.push(notice);
    };
    const { rerender } = render(
      <CodexVersionNotice
        snapshot={snapshot(advisory())}
        onNoticeChanged={onNoticeChanged}
        onOpenCodexSettings={openSettings}
      />,
    );
    expect(seen.map((notice) => notice?.id)).toEqual(["codex-version:0.152.0"]);

    // A later snapshot with an equal but new advisory object.
    rerender(
      <CodexVersionNotice
        snapshot={snapshot(advisory())}
        onNoticeChanged={onNoticeChanged}
        onOpenCodexSettings={openSettings}
      />,
    );
    expect(seen).toHaveLength(1);

    // Updating Codex clears it.
    rerender(
      <CodexVersionNotice
        snapshot={snapshot(undefined)}
        onNoticeChanged={onNoticeChanged}
        onOpenCodexSettings={openSettings}
      />,
    );
    expect(seen.at(-1)).toBeUndefined();
  });

  it("stays dismissed for the launch after the toast is closed", () => {
    let latest: AppNoticeToastNotice | undefined;
    render(
      <CodexVersionNotice
        snapshot={snapshot(advisory())}
        onNoticeChanged={(notice) => {
          latest = notice;
        }}
        onOpenCodexSettings={() => undefined}
      />,
    );
    expect(latest).toBeDefined();
    act(() => latest?.onDismiss?.());
    expect(latest).toBeUndefined();
  });

  function Host(props: Omit<Parameters<typeof CodexVersionNotice>[0], "onNoticeChanged">) {
    const [notice, setNotice] = useState<AppNoticeToastNotice>();
    return <>
      <CodexVersionNotice {...props} onNoticeChanged={setNotice} />
      <AppNoticeToast notice={notice} onDismiss={() => setNotice(undefined)} />
    </>;
  }

  it("uses the shared Settings update action only after the user clicks, with a discovery intent", async () => {
    const value = snapshot(advisory({ installer: "pwragent", upgradeCommand: undefined }));
    value.models.codex.managedBuilds = { value: true, source: "config" };
    const api = {
      refreshCodexDiscovery: vi.fn(async () => ({ snapshot: value })),
      listBackends: vi.fn(async () => ({ fetchedAt: Date.now(), backends: [] })),
    };
    const check = async () => { await checkForManagedCodexUpdates(api); };
    render(<Host snapshot={value} onManagedBuildsChange={vi.fn(async () => true)}
      onCheckManagedBuildUpdates={check} onOpenCodexSettings={vi.fn()} />);
    expect(api.refreshCodexDiscovery).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(api.refreshCodexDiscovery).toHaveBeenCalledExactlyOnceWith({
      discoveryIntent: "settings-user-action",
    }));
    await waitFor(() => expect(api.listBackends).toHaveBeenCalledExactlyOnceWith({
      includeUnavailable: true,
      refreshModels: "codex",
      discoveryIntent: "settings-user-action",
    }));
  });

  it("enables the custom build from the toast and keeps progress when the advisory clears", async () => {
    let finish: ((saved: boolean) => void) | undefined;
    const change = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const openSettings = vi.fn();
    const { api, sendProgress } = progressBridge();
    const props = { desktopApi: api, onManagedBuildsChange: change, onOpenCodexSettings: openSettings };
    const { rerender } = render(<Host {...props} snapshot={snapshot(advisory())} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Open Codex settings" }));
    expect(openSettings).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("switch"));
    expect(change).toHaveBeenCalledWith(true);
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    for (const phase of ["checking", "downloading", "verifying", "unpacking", "activating"] as const) {
      act(() => sendProgress({ runtime: "codex", phase, receivedBytes: 50, totalBytes: 100, updatedAt: Date.now() }));
      expect(screen.getByTestId("managed-progress-codex")).toBeInTheDocument();
      if (phase === "downloading") expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    }
    act(() => sendProgress({ runtime: "codex", phase: "ready", updatedAt: Date.now() }));
    rerender(<Host {...props} snapshot={snapshot(undefined)} />);
    await act(async () => finish?.(true));
    expect(screen.getByTestId("managed-progress-codex")).toHaveTextContent("Verified and ready");
    expect(screen.getByText("PwrAgent custom Codex build installed")).toBeInTheDocument();
    vi.useFakeTimers();
    // Re-arm the ready strip's expiry under the test clock.
    act(() => sendProgress({ runtime: "codex", phase: "ready", updatedAt: Date.now() }));
    act(() => vi.advanceTimersByTime(6_100));
    expect(screen.queryByTestId("managed-progress-codex")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("reports a failed enable and retries without navigating away", async () => {
    const change = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    render(<Host snapshot={snapshot(advisory())} onManagedBuildsChange={change} onOpenCodexSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("switch"));
    await screen.findByText(/Could not change the Codex build/u);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(change).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/Could not change the Codex build/u)).not.toBeInTheDocument());
  });

  it.each(["save rejected", "save threw", "retained install failure"])(
    "retries disabling after %s without checking for updates",
    async (failure) => {
      const value = snapshot(advisory({ installer: "pwragent", upgradeCommand: undefined }));
      value.models.codex.managedBuilds = { value: true, source: "config" };
      const change = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
      if (failure === "save threw") change.mockReset().mockRejectedValueOnce(new Error("Invalid config.toml")).mockResolvedValue(true);
      const check = vi.fn(async () => undefined);
      render(<Host snapshot={value} onManagedBuildsChange={change} onCheckManagedBuildUpdates={check}
        onOpenCodexSettings={vi.fn()} desktopApi={failure === "retained install failure" ? {
          readManagedRuntimeProgress: async () => [{ runtime: "codex", phase: "failed", error: "Archive verification failed", updatedAt: Date.now() }],
          onManagedRuntimeProgress: () => () => undefined,
        } : undefined} />);
      if (failure === "retained install failure") await screen.findByText("Archive verification failed");
      fireEvent.click(screen.getByRole("switch"));
      await waitFor(() => expect(change).toHaveBeenCalledExactlyOnceWith(false));
      await waitFor(() => expect(screen.getByRole("switch")).not.toBeDisabled());
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(change).toHaveBeenCalledTimes(2));
      expect(change.mock.calls).toEqual([[false], [false]]);
      expect(check).not.toHaveBeenCalled();
    },
  );

  it("retries a failed explicit update check as a check", async () => {
    const value = snapshot(advisory({ installer: "pwragent", upgradeCommand: undefined }));
    value.models.codex.managedBuilds = { value: true, source: "config" };
    const check = vi.fn().mockRejectedValueOnce(new Error("Release check failed")).mockResolvedValue(undefined);
    const change = vi.fn(async () => true);
    render(<Host snapshot={value} onManagedBuildsChange={change} onCheckManagedBuildUpdates={check}
      onOpenCodexSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await screen.findByText("Release check failed");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    expect(change).not.toHaveBeenCalled();
  });

  it("shows an install failure and retries the update for an already enabled build", async () => {
    const value = snapshot(advisory({ installer: "pwragent", upgradeCommand: undefined }));
    value.models.codex.managedBuilds = { value: true, source: "config" };
    value.models.codex.managedBuildsRequiredBy = "token-miser";
    value.runtime = { tokenMiser: { managedCodex: { state: "pending-switch" } } } as DesktopSettingsSnapshot["runtime"];
    const check = vi.fn(async () => undefined);
    const change = vi.fn(async () => true);
    render(<Host snapshot={value} onManagedBuildsChange={change} onCheckManagedBuildUpdates={check}
      onOpenCodexSettings={vi.fn()} desktopApi={{
        readManagedRuntimeProgress: async () => [{ runtime: "codex", phase: "failed", error: "Archive verification failed", updatedAt: Date.now() }],
        onManagedRuntimeProgress: () => () => undefined,
      }} />);
    await screen.findByText("Archive verification failed");
    expect(screen.getByRole("switch")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("switch"));
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(check).toHaveBeenCalledOnce());
    expect(change).not.toHaveBeenCalled();
  });
  describe("OpenAI's Codex", () => {
    function userSnapshot(source: "path" | "config" = "path"): DesktopSettingsSnapshot {
      return {
        models: {
          codex: {
            path: { value: "", source: "default" },
            versionAdvisory: advisory(),
            discovery: {
              candidates: [{
                command: "/opt/homebrew/bin/codex",
                source,
                executable: true,
                selected: true,
                version: "0.152.0",
              }],
            },
          },
        },
      } as unknown as DesktopSettingsSnapshot;
    }
    function cleared(): DesktopSettingsSnapshot {
      const value = userSnapshot();
      delete value.models.codex.versionAdvisory;
      return value;
    }

    it("installs it from the toast, follows its progress, and reports the release", async () => {
      const { api: bridge, sendProgress } = progressBridge();
      let finish: (() => void) | undefined;
      const api = {
        ...bridge,
        refreshCodexDiscovery: vi.fn(() => new Promise<never>((resolve) => {
          finish = () => resolve(undefined as never);
        })),
      };
      const installed = vi.fn(async () => undefined);
      const props = {
        desktopApi: api,
        onOpenCodexSettings: vi.fn(),
        onManagedBuildsChange: vi.fn(async () => true),
        onOpenAiCodexInstalled: installed,
      };
      const { rerender } = render(<Host {...props} snapshot={userSnapshot()} />);
      await act(async () => {});
      // The custom build stays on offer, second.
      expect(screen.getByRole("switch", { name: "Use PwrAgent custom Codex build" })).toBeInTheDocument();
      expect(api.refreshCodexDiscovery).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Install latest Codex" }));
      expect(api.refreshCodexDiscovery).toHaveBeenCalledExactlyOnceWith({
        discoveryIntent: "settings-user-action",
        installOpenAiCodex: true,
      });
      expect(screen.queryByRole("button", { name: "Install latest Codex" })).not.toBeInTheDocument();
      expect(screen.getByRole("switch")).toBeDisabled();

      // PwrAgent's own build reports on another runtime; it is not this install.
      act(() => sendProgress({ runtime: "codex", phase: "checking", updatedAt: Date.now() }));
      expect(screen.queryByTestId("managed-progress-openai-codex")).not.toBeInTheDocument();
      act(() => sendProgress({ runtime: "codex", phase: "idle", updatedAt: Date.now() }));

      act(() => sendProgress({
        runtime: "openai-codex", phase: "downloading", tag: "0.160.0",
        receivedBytes: 25, totalBytes: 100, updatedAt: Date.now(),
      }));
      expect(screen.getByTestId("managed-progress-openai-codex")).toBeInTheDocument();
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");

      act(() => sendProgress({ runtime: "openai-codex", phase: "ready", tag: "0.160.0", updatedAt: Date.now() }));
      // Discovery selects the new Codex, which clears the advisory.
      rerender(<Host {...props} snapshot={cleared()} />);
      await act(async () => finish?.());
      expect(installed).toHaveBeenCalledOnce();
      expect(screen.getByText("OpenAI Codex installed")).toBeInTheDocument();
      expect(screen.getByText(/Codex 0\.160\.0 is installed and ready/u)).toBeInTheDocument();
      expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    });

    it("shows a failed install and retries the same request", async () => {
      const { api: bridge, sendProgress } = progressBridge();
      const api = { ...bridge, refreshCodexDiscovery: vi.fn(async () => ({ snapshot: userSnapshot() })) };
      render(<Host desktopApi={api} snapshot={userSnapshot()} onOpenCodexSettings={vi.fn()} />);
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "Install latest Codex" }));
      await waitFor(() => expect(api.refreshCodexDiscovery).toHaveBeenCalledOnce());
      act(() => sendProgress({
        runtime: "openai-codex", phase: "failed", failedPhase: "verifying",
        error: "SHA-256 mismatch for codex-package", updatedAt: Date.now(),
      }));
      expect(screen.getByText("SHA-256 mismatch for codex-package")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(api.refreshCodexDiscovery).toHaveBeenCalledTimes(2));
      expect(api.refreshCodexDiscovery).toHaveBeenLastCalledWith({
        discoveryIntent: "settings-user-action",
        installOpenAiCodex: true,
      });
    });

    it("says why a request failed before any download started, and offers it again", async () => {
      const { api: bridge } = progressBridge();
      const api = {
        ...bridge,
        refreshCodexDiscovery: vi.fn()
          .mockRejectedValueOnce(new Error("PwrAgent couldn't install Codex."))
          .mockResolvedValue({ snapshot: userSnapshot() }),
      };
      render(<Host desktopApi={api} snapshot={userSnapshot()} onOpenCodexSettings={vi.fn()} />);
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: "Install latest Codex" }));
      await screen.findByText("PwrAgent couldn't install Codex.");
      fireEvent.click(screen.getByRole("button", { name: "Install latest Codex" }));
      await waitFor(() => expect(api.refreshCodexDiscovery).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByText("PwrAgent couldn't install Codex.")).not.toBeInTheDocument());
    });

    it("offers no install over a path the operator chose, which would keep winning", async () => {
      const { api: bridge } = progressBridge();
      const api = { ...bridge, refreshCodexDiscovery: vi.fn() };
      render(<Host desktopApi={api} snapshot={userSnapshot("config")} onOpenCodexSettings={vi.fn()}
        onManagedBuildsChange={vi.fn(async () => true)} />);
      await act(async () => {});
      expect(screen.getByRole("button", { name: "Copy command" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Install latest Codex" })).not.toBeInTheDocument();
      expect(screen.getByRole("switch")).toBeInTheDocument();
    });

    it("shows an install another window started", async () => {
      const { api: bridge } = progressBridge([
        { runtime: "openai-codex", phase: "unpacking", tag: "0.160.0", updatedAt: Date.now() },
      ]);
      const api = { ...bridge, refreshCodexDiscovery: vi.fn() };
      render(<Host desktopApi={api} snapshot={userSnapshot()} onOpenCodexSettings={vi.fn()} />);
      await screen.findByTestId("managed-progress-openai-codex");
      expect(screen.queryByRole("button", { name: "Install latest Codex" })).not.toBeInTheDocument();
    });
  });
});
