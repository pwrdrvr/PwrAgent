import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopMessagingSettingsProjection,
  DesktopSettingsSnapshot,
  MessagingPlatformStatus,
  MessagingPlatformStatusEvent,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { HOVER_TRANSITION_GRACE_MS } from "../../lib/useHoverTransitionGrace";
import discordBlurpleUrl from "../../assets/discord/symbol-blurple.svg";
import { MessagingStatusBar } from "./MessagingStatusBar";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("MessagingStatusBar", () => {
  it("keeps a hover popover mounted across the title-bar boundary grace period", async () => {
    const statuses = [
      {
        changedAt: 1000,
        health: "enabled",
        platform: "telegram",
      },
    ] satisfies MessagingPlatformStatus[];
    const desktopApi: DesktopApi = {
      getMessagingPlatformStatuses: vi.fn(async () => statuses),
      onMessagingPlatformStatusEvent: vi.fn(() => () => {}),
    };

    render(<MessagingStatusBar desktopApi={desktopApi} />);
    await screen.findByRole("button", { name: /Telegram/ });
    const statusBar = screen.getByRole("group", {
      name: "Messaging platform status",
    });
    vi.useFakeTimers();

    fireEvent.pointerEnter(statusBar);
    expect(
      screen.getByRole("dialog", { name: "Messaging platforms" }),
    ).toBeInTheDocument();
    fireEvent.pointerLeave(statusBar);
    expect(
      screen.getByRole("dialog", { name: "Messaging platforms" }),
    ).toBeInTheDocument();

    fireEvent.pointerEnter(
      screen.getByRole("dialog", { name: "Messaging platforms" }),
    );
    act(() => vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS));
    expect(
      screen.getByRole("dialog", { name: "Messaging platforms" }),
    ).toBeInTheDocument();

    fireEvent.pointerLeave(statusBar);
    act(() => vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS));
    expect(
      screen.queryByRole("dialog", { name: "Messaging platforms" }),
    ).not.toBeInTheDocument();
  });

  it("renders Feishu / Lark with the brand icon instead of the text fallback", async () => {
    const statuses = [
      {
        changedAt: 1000,
        health: "enabled",
        platform: "feishu",
        account: "PwrAgent",
        detail: "open.larksuite.com",
      },
    ] satisfies MessagingPlatformStatus[];
    const desktopApi: DesktopApi = {
      getMessagingPlatformStatuses: vi.fn(async () => statuses),
      onMessagingPlatformStatusEvent: vi.fn(() => () => {}),
    };

    const { container } = render(<MessagingStatusBar desktopApi={desktopApi} />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /1 online/ }),
      ).toBeInTheDocument();
    });
    expect(container.querySelector(".messaging-status-chip img")).not.toBeNull();
    expect(container.querySelector(".messaging-status-chip__fallback")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Feishu \/ Lark/ }));

    const popover = await screen.findByRole("dialog", {
      name: "Messaging platforms",
    });
    expect(popover).toHaveTextContent("open.larksuite.com");
    expect(popover).toHaveTextContent("Bot: PwrAgent");
    expect(popover).not.toHaveTextContent("Account detail: open.larksuite.com");
  });

  it("renders Discord with the visible Blurple brand icon", async () => {
    const statuses = [
      {
        changedAt: 1000,
        health: "enabled",
        platform: "discord",
      },
    ] satisfies MessagingPlatformStatus[];
    const desktopApi: DesktopApi = {
      getMessagingPlatformStatuses: vi.fn(async () => statuses),
      onMessagingPlatformStatusEvent: vi.fn(() => () => {}),
    };

    const { container } = render(<MessagingStatusBar desktopApi={desktopApi} />);

    await screen.findByRole("button", { name: /Discord/ });
    expect(
      container.querySelector<HTMLImageElement>(
        '.messaging-status-chip[title="Discord"] img',
      ),
    ).toHaveAttribute("src", discordBlurpleUrl);
  });

  it("renders degraded status with rate-limit detail in the tooltip", async () => {
    const statuses = [
      {
        changedAt: 1000,
        degradationReasons: [
          {
            expiresAt: 8000,
            key: "telegram:rate-limited:group",
            kind: "rate-limited",
            retryAfterMs: 5000,
            scope: {
              id: "telegram:group:-100123",
              kind: "group",
              label: "Telegram group -100123",
              platform: "telegram",
            },
            startedAt: 1000,
          },
        ],
        health: "degraded",
        platform: "telegram",
        account: "@pwragent_bot",
        detail: "api.telegram.org",
      },
    ] satisfies MessagingPlatformStatus[];
    const desktopApi: DesktopApi = {
      getMessagingPlatformStatuses: vi.fn(async () => statuses),
      onMessagingPlatformStatusEvent: vi.fn(() => () => {}),
    };

    render(<MessagingStatusBar desktopApi={desktopApi} />);

    fireEvent.click(await screen.findByRole("button", { name: /1 degraded/ }));

    const popover = await screen.findByRole("dialog", {
      name: "Messaging platforms",
    });
    await waitFor(() => {
      expect(
        screen.getByText("Telegram"),
      ).toBeInTheDocument();
    });
    expect(popover).toHaveTextContent("Rate limited");
    expect(popover).toHaveTextContent("Telegram group -100123");
    expect(popover).toHaveTextContent("remaining");
    expect(popover).toHaveTextContent("Bot: @pwragent_bot");
    expect(popover).toHaveTextContent("Account detail: api.telegram.org");
  });

  it("keeps credential identity visible when messaging is suspended", async () => {
    const statuses = [
      {
        changedAt: 1000,
        health: "enabled",
        platform: "telegram",
        account: "@pwragent_bot",
        detail: "api.telegram.org",
      },
    ] satisfies MessagingPlatformStatus[];
    let emitStatusEvent: ((event: MessagingPlatformStatusEvent) => void) | null =
      null;
    const desktopApi: DesktopApi = {
      getMessagingPlatformStatuses: vi.fn(async () => statuses),
      onMessagingPlatformStatusEvent: vi.fn((listener) => {
        emitStatusEvent = listener;
        return () => {};
      }),
    };

    render(<MessagingStatusBar desktopApi={desktopApi} />);

    fireEvent.click(await screen.findByRole("button", { name: /1 online/ }));

    const popover = await screen.findByRole("dialog", {
      name: "Messaging platforms",
    });
    await waitFor(() => {
      expect(screen.getByText("Telegram")).toBeInTheDocument();
    });
    expect(popover).toHaveTextContent("Bot: @pwragent_bot");
    expect(popover).toHaveTextContent("api.telegram.org");
    expect(popover).not.toHaveTextContent("Account detail: api.telegram.org");

    act(() => {
      emitStatusEvent?.({
        at: 2000,
        health: "suspended",
        kind: "health-changed",
        platform: "telegram",
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Globally disabled")).toBeInTheDocument();
    });
    expect(popover).toHaveTextContent("Bot: @pwragent_bot");
    expect(popover).toHaveTextContent("Account detail: api.telegram.org");
  });

  it("pins the popover and toggles messaging from the status controller", async () => {
    const statuses = [
      {
        changedAt: 1000,
        health: "enabled",
        platform: "telegram",
      },
    ] satisfies MessagingPlatformStatus[];
    const setMessagingEnabled = vi.fn(async () => ({
      enabled: false,
      overridden: false,
      disabledReason: "Messaging is stopped for this app instance.",
      disabledReasonKind: "runtime_stopped" as const,
    }));
    const desktopApi: DesktopApi = {
      getMessagingPlatformStatuses: vi.fn(async () => statuses),
      onMessagingPlatformStatusEvent: vi.fn(() => () => {}),
      setMessagingEnabled,
    };

    render(
      <MessagingStatusBar
        desktopApi={desktopApi}
        onOpenActivity={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /1 online/ }));
    const popover = await screen.findByRole("dialog", {
      name: "Messaging platforms",
    });
    expect(
      popover.querySelector(".messaging-status-popover__rows"),
    ).not.toHaveClass("messaging-status-popover__rows--without-footer");

    fireEvent.click(screen.getByRole("button", { name: "On" }));

    await waitFor(() => {
      expect(setMessagingEnabled).toHaveBeenCalledWith({ enabled: false });
    });
    expect(screen.getByRole("button", { name: "Off" })).toBeInTheDocument();
  });

  it("opens Messaging settings from the gear immediately before the master toggle", async () => {
    const statuses = [
      {
        changedAt: 1000,
        health: "enabled",
        platform: "telegram",
      },
    ] satisfies MessagingPlatformStatus[];
    const desktopApi: DesktopApi = {
      getMessagingPlatformStatuses: vi.fn(async () => statuses),
      onMessagingPlatformStatusEvent: vi.fn(() => () => {}),
    };
    const onOpenSettings = vi.fn();

    render(
      <MessagingStatusBar
        desktopApi={desktopApi}
        onOpenSettings={onOpenSettings}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /1 online/ }));
    const settingsButton = await screen.findByRole("button", {
      name: "Open Messaging Settings",
    });
    const masterToggle = screen.getByRole("button", { name: "On" });

    expect(settingsButton.nextElementSibling).toBe(masterToggle);
    fireEvent.mouseEnter(settingsButton);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveClass("messaging-status-tooltip");
    expect(tooltip).toHaveTextContent("Open Messaging Settings");

    fireEvent.click(settingsButton);

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Messaging platforms" }),
    ).not.toBeInTheDocument();
  });

  it("uses runtime-disabled settings instead of stale errored platform health", async () => {
    const statuses = [
      {
        changedAt: 1000,
        health: "errored",
        platform: "telegram",
        reason: "Invalid token",
      },
    ] satisfies MessagingPlatformStatus[];
    const setMessagingEnabled = vi.fn(async () => ({
      enabled: true,
      overridden: false,
    }));
    const desktopApi: DesktopApi = {
      getMessagingPlatformStatuses: vi.fn(async () => statuses),
      onMessagingPlatformStatusEvent: vi.fn(() => () => {}),
      readMessagingSettings: vi.fn(async () => ({
        snapshot: messagingSettingsSnapshot(
          { telegram: true },
          { runtimeMessagingDisabled: true },
        ),
      })),
      setMessagingEnabled,
    };

    render(<MessagingStatusBar desktopApi={desktopApi} />);

    const controller = await screen.findByRole("button", {
      name: /1 configured platform off/,
    });
    expect(controller).toHaveTextContent("Off");

    fireEvent.click(controller);
    fireEvent.click(await screen.findByRole("button", { name: "Off" }));

    await waitFor(() => {
      expect(setMessagingEnabled).toHaveBeenCalledWith({ enabled: true });
    });
  });

  it("persists per-platform enabled toggles from the popover rows", async () => {
    const statuses = [
      {
        changedAt: 1000,
        health: "enabled",
        platform: "telegram",
        account: "@pwragent_bot",
      },
    ] satisfies MessagingPlatformStatus[];
    const writeSettingsConfig = vi.fn(async () => ({
      update: {
        version: 2,
        configRevision: "next",
        changedDomains: ["messaging"] as const,
        normalizedPatch: { messaging: { telegram: { enabled: false } } },
        scheduledProviderRefreshes: [],
      },
      snapshot: {} as DesktopSettingsSnapshot,
    }));
    const desktopApi: DesktopApi = {
      getMessagingPlatformStatuses: vi.fn(async () => statuses),
      onMessagingPlatformStatusEvent: vi.fn(() => () => {}),
      readMessagingSettings: vi.fn(async () => ({
        snapshot: messagingSettingsSnapshot({ telegram: true }),
      })),
      writeSettingsConfig,
    };

    render(<MessagingStatusBar desktopApi={desktopApi} />);

    fireEvent.click(await screen.findByRole("button", { name: /1 online/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Disable Telegram" }),
    );

    await waitFor(() => {
      expect(writeSettingsConfig).toHaveBeenCalledWith({
        patch: { messaging: { telegram: { enabled: false } } },
      });
    });
  });

  it("does not write provider settings while messaging is stopped for the session", async () => {
    const statuses = [
      {
        changedAt: 1000,
        health: "enabled",
        platform: "telegram",
      },
    ] satisfies MessagingPlatformStatus[];
    const setMessagingEnabled = vi.fn(async () => ({
      enabled: false,
      overridden: false,
      disabledReasonKind: "runtime_stopped" as const,
    }));
    const writeSettingsConfig = vi.fn(async () => ({
      update: {
        version: 2,
        configRevision: "next",
        changedDomains: ["messaging"] as const,
        normalizedPatch: { messaging: { telegram: { enabled: false } } },
        scheduledProviderRefreshes: [],
      },
      snapshot: {} as DesktopSettingsSnapshot,
    }));
    const desktopApi: DesktopApi = {
      getMessagingPlatformStatuses: vi.fn(async () => statuses),
      onMessagingPlatformStatusEvent: vi.fn(() => () => {}),
      readMessagingSettings: vi.fn(async () => ({
        snapshot: messagingSettingsSnapshot({ telegram: true }),
      })),
      setMessagingEnabled,
      writeSettingsConfig,
    };

    render(<MessagingStatusBar desktopApi={desktopApi} />);

    fireEvent.click(await screen.findByRole("button", { name: /1 online/ }));
    fireEvent.click(screen.getByRole("button", { name: "On" }));

    await waitFor(() => {
      expect(setMessagingEnabled).toHaveBeenCalledWith({ enabled: false });
    });

    const platformSwitch = await screen.findByRole("button", {
      name: "Disable Telegram",
    });
    expect(platformSwitch).toBeDisabled();

    fireEvent.click(platformSwitch);
    expect(writeSettingsConfig).not.toHaveBeenCalled();
  });

  it("shows configured disabled platforms omitted by runtime startup and enables them from the row", async () => {
    const writeSettingsConfig = vi.fn(async () => ({
      update: {
        version: 2,
        configRevision: "next",
        changedDomains: ["messaging"] as const,
        normalizedPatch: { messaging: { line: { enabled: true } } },
        scheduledProviderRefreshes: [],
      },
      snapshot: {} as DesktopSettingsSnapshot,
    }));
    const desktopApi: DesktopApi = {
      getMessagingPlatformStatuses: vi.fn(async () => []),
      onMessagingPlatformStatusEvent: vi.fn(() => () => {}),
      readMessagingSettings: vi.fn(async () => ({
        snapshot: messagingSettingsSnapshot(
          { line: false },
          { configured: { line: true } },
        ),
      })),
      writeSettingsConfig,
    };

    render(<MessagingStatusBar desktopApi={desktopApi} />);

    const controller = await screen.findByRole("button", { name: /LINE/ });
    expect(controller).toHaveTextContent("Msg");

    fireEvent.click(controller);
    expect(
      await screen.findByRole("dialog", { name: "Messaging platforms" }),
    ).toHaveTextContent("LINE");

    fireEvent.click(await screen.findByRole("button", { name: "Enable LINE" }));

    await waitFor(() => {
      expect(writeSettingsConfig).toHaveBeenCalledWith({
        patch: { messaging: { line: { enabled: true } } },
      });
    });
  });

  it("shows persisted provider request and response activity summaries", async () => {
    const now = Date.now();
    const statuses = [
      {
        changedAt: 1000,
        health: "enabled",
        platform: "telegram",
      },
    ] satisfies MessagingPlatformStatus[];
    const desktopApi: DesktopApi = {
      getMessagingPlatformStatuses: vi.fn(async () => statuses),
      getMessagingActivitySummary: vi.fn(async () => ({
        summaries: [
          {
            platform: "telegram" as const,
            lastRequestAt: now - 60_000,
            lastResponseAt: now - 30_000,
          },
        ],
      })),
      onMessagingPlatformStatusEvent: vi.fn(() => () => {}),
    };

    render(<MessagingStatusBar desktopApi={desktopApi} />);

    fireEvent.click(await screen.findByRole("button", { name: /1 online/ }));

    const popover = await screen.findByRole("dialog", {
      name: "Messaging platforms",
    });
    await waitFor(() => {
      expect(popover).toHaveTextContent("Last request:");
      expect(popover).toHaveTextContent("Last response:");
    });
  });

  it("shows an explicit empty response state when only requests have been recorded", async () => {
    const now = Date.now();
    const statuses = [
      {
        changedAt: 1000,
        health: "enabled",
        platform: "telegram",
      },
    ] satisfies MessagingPlatformStatus[];
    const desktopApi: DesktopApi = {
      getMessagingPlatformStatuses: vi.fn(async () => statuses),
      getMessagingActivitySummary: vi.fn(async () => ({
        summaries: [
          {
            platform: "telegram" as const,
            lastRequestAt: now - 60_000,
          },
        ],
      })),
      onMessagingPlatformStatusEvent: vi.fn(() => () => {}),
    };

    render(<MessagingStatusBar desktopApi={desktopApi} />);

    fireEvent.click(await screen.findByRole("button", { name: /1 online/ }));

    const popover = await screen.findByRole("dialog", {
      name: "Messaging platforms",
    });
    await waitFor(() => {
      expect(popover).toHaveTextContent("Last request:");
      expect(popover).toHaveTextContent("Last response: none yet");
    });
  });

  it("dismisses a pinned popover with Escape and outside pointerdown", async () => {
    const statuses = [
      {
        changedAt: 1000,
        health: "enabled",
        platform: "telegram",
      },
    ] satisfies MessagingPlatformStatus[];
    const desktopApi: DesktopApi = {
      getMessagingPlatformStatuses: vi.fn(async () => statuses),
      onMessagingPlatformStatusEvent: vi.fn(() => () => {}),
    };

    render(<MessagingStatusBar desktopApi={desktopApi} />);

    fireEvent.click(await screen.findByRole("button", { name: /Telegram/ }));
    expect(
      await screen.findByRole("dialog", { name: "Messaging platforms" }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Messaging platforms" }),
      ).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Telegram/ }));
    expect(
      await screen.findByRole("dialog", { name: "Messaging platforms" }),
    ).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Messaging platforms" }),
      ).not.toBeInTheDocument();
    });
  });

  it("renders the peer's statuses read-only in a federation window", async () => {
    const federationWindow = window as typeof window & {
      __pwragentFederationTarget?: { scope: string; instanceId: string };
    };
    federationWindow.__pwragentFederationTarget = {
      scope: "remote",
      instanceId: "peer_one",
    };
    const statuses = [
      {
        changedAt: 1000,
        health: "enabled",
        platform: "telegram",
        account: "@peer_bot",
      },
    ] satisfies MessagingPlatformStatus[];
    const getMessagingPlatformStatuses = vi.fn(async () => statuses);
    const onMessagingPlatformStatusEvent = vi.fn(() => () => {});
    const desktopApi: DesktopApi = {
      getMessagingPlatformStatuses,
      onMessagingPlatformStatusEvent,
      readMessagingSettings: vi.fn(),
      setMessagingEnabled: vi.fn(),
      writeSettingsConfig: vi.fn(),
      getMessagingActivitySummary: vi.fn(),
    };

    try {
      render(
        <MessagingStatusBar
          desktopApi={desktopApi}
          onOpenActivity={() => {}}
          onOpenSettings={() => {}}
        />,
      );

      fireEvent.click(await screen.findByRole("button", { name: /1 online/ }));
      const popover = await screen.findByRole("dialog", {
        name: "Messaging platforms",
      });
      expect(popover).toHaveTextContent("Telegram");
      expect(popover).toHaveTextContent("@peer_bot");

      // The read routes to the owning instance, not the local runtime.
      expect(getMessagingPlatformStatuses).toHaveBeenCalledWith({
        federationTarget: { scope: "remote", instanceId: "peer_one" },
      });
      // Local status events describe THIS machine; a remote window must
      // not fold them into the peer's list.
      expect(onMessagingPlatformStatusEvent).not.toHaveBeenCalled();
      // No local settings/activity polling for a remote window.
      expect(desktopApi.readMessagingSettings).not.toHaveBeenCalled();
      expect(desktopApi.getMessagingActivitySummary).not.toHaveBeenCalled();

      // Read-only: no master toggle, no per-platform switches, no
      // Settings gear, no Activity shortcut.
      expect(popover.querySelector(".settings-switch")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Open Messaging Settings" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Open Messaging Activity" }),
      ).not.toBeInTheDocument();
      expect(
        popover.querySelector(".messaging-status-popover__rows"),
      ).toHaveClass("messaging-status-popover__rows--without-footer");
    } finally {
      delete federationWindow.__pwragentFederationTarget;
    }
  });

  it("stops remote status polling until the peer reconnects", async () => {
    vi.useFakeTimers();
    const federationWindow = window as typeof window & {
      __pwragentFederationTarget?: { scope: string; instanceId: string };
    };
    federationWindow.__pwragentFederationTarget = {
      scope: "remote",
      instanceId: "peer_polling",
    };
    const listeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const getMessagingPlatformStatuses = vi.fn(async () => []);
    const desktopApi: DesktopApi = {
      getMessagingPlatformStatuses,
      onAgentEvent: (callback) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    };

    try {
      const view = render(<MessagingStatusBar desktopApi={desktopApi} />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(getMessagingPlatformStatuses).toHaveBeenCalledTimes(1);

      act(() => {
        for (const listener of listeners) {
          listener({
            backend: "codex",
            federationTarget: {
              scope: "remote",
              instanceId: "peer_polling",
            },
            notification: {
              method: "federation/peerStatus/changed",
              params: {
                instanceId: "peer_polling",
                status: "disconnected",
              },
            },
          });
        }
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(getMessagingPlatformStatuses).toHaveBeenCalledTimes(1);

      act(() => {
        for (const listener of listeners) {
          listener({
            backend: "codex",
            federationTarget: {
              scope: "remote",
              instanceId: "peer_polling",
            },
            notification: {
              method: "federation/peerStatus/changed",
              params: {
                instanceId: "peer_polling",
                status: "connected",
              },
            },
          });
        }
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(getMessagingPlatformStatuses).toHaveBeenCalledTimes(2);
      view.unmount();
    } finally {
      delete federationWindow.__pwragentFederationTarget;
      vi.useRealTimers();
    }
  });
});

function messagingSettingsSnapshot(enabled: {
  telegram?: boolean;
  discord?: boolean;
  mattermost?: boolean;
  slack?: boolean;
  feishu?: boolean;
  line?: boolean;
}, options: {
  configured?: {
    telegram?: boolean;
    discord?: boolean;
    mattermost?: boolean;
    slack?: boolean;
    feishu?: boolean;
    line?: boolean;
  };
  runtimeMessagingDisabled?: boolean;
} = {}): DesktopMessagingSettingsProjection {
  const setting = (value: boolean) => ({ value, source: "config" });
  const secret = (configured: boolean | undefined) => ({
    configured: configured ?? false,
    source: "keychain",
    writable: true,
  });
  return {
    fetchedAt: 1,
    runtime: {
      disabled: options.runtimeMessagingDisabled ?? false,
    },
    messaging: {
      telegram: { enabled: setting(enabled.telegram ?? true) },
      discord: { enabled: setting(enabled.discord ?? true) },
      mattermost: { enabled: setting(enabled.mattermost ?? true) },
      slack: { enabled: setting(enabled.slack ?? true) },
      feishu: { enabled: setting(enabled.feishu ?? true) },
      line: {
        enabled: setting(enabled.line ?? true),
        channelAccessToken: secret(options.configured?.line),
      },
    },
  } as unknown as DesktopMessagingSettingsProjection;
}
