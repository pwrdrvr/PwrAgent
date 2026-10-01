import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopCodexVersionAdvisory,
  DesktopSettingsSnapshot,
} from "@pwragent/shared";
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
    let sendProgress: ((event: ManagedRuntimeProgress) => void) | undefined;
    let finish: ((saved: boolean) => void) | undefined;
    const change = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const openSettings = vi.fn();
    const api = {
      readManagedRuntimeProgress: vi.fn(async () => []),
      onManagedRuntimeProgress: vi.fn((handler: (event: ManagedRuntimeProgress) => void) => {
        sendProgress = handler;
        return vi.fn();
      }),
    };
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
      act(() => sendProgress?.({ runtime: "codex", phase, receivedBytes: 50, totalBytes: 100, updatedAt: Date.now() }));
      expect(screen.getByTestId("managed-progress-codex")).toBeInTheDocument();
      if (phase === "downloading") expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    }
    act(() => sendProgress?.({ runtime: "codex", phase: "ready", updatedAt: Date.now() }));
    rerender(<Host {...props} snapshot={snapshot(undefined)} />);
    await act(async () => finish?.(true));
    expect(screen.getByTestId("managed-progress-codex")).toHaveTextContent("Verified and ready");
    expect(screen.getByText("PwrAgent custom Codex build installed")).toBeInTheDocument();
    vi.useFakeTimers();
    // Re-arm the ready strip's expiry under the test clock.
    act(() => sendProgress?.({ runtime: "codex", phase: "ready", updatedAt: Date.now() }));
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
});
