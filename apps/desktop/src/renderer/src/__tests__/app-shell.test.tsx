import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { resolveNewThreadBackend } from "@pwragent/shared";
import type {
  AgentEvent,
  AppServerBackendKind,
  BackendSummary,
  CreateScheduledThreadActionRequest,
  DesktopPwrAgentProfileSummary,
  DesktopSettingsSnapshot,
  EnsureDirectoryLaunchpadRequest,
  FederationPeerSummary,
  FederationTarget,
  NavigationSnapshot,
  StartTurnRequest,
  StartTurnResponse,
} from "@pwragent/shared";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  App,
  inferReplayCodexProfileModel,
  inferReplayCodexProfileSetup,
} from "../App";

beforeAll(() => {
  const emptyRect = {
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    toJSON: () => ({}),
    top: 0,
    width: 0,
    x: 0,
    y: 0,
  } as DOMRect;
  const textPrototype = Text.prototype as Text & {
    getClientRects?: () => DOMRect[];
    getBoundingClientRect?: () => DOMRect;
  };
  textPrototype.getClientRects ??= () => [];
  textPrototype.getBoundingClientRect ??= () => emptyRect;
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => emptyRect;
});

function pasteComposerText(textbox: HTMLElement, value: string): void {
  fireEvent.paste(textbox, {
    clipboardData: {
      files: [],
      getData: (type: string) => (type === "text/plain" ? value : ""),
      items: [],
      types: ["text/plain"],
    },
  });
}

function getComposerValueHost(textbox: HTMLElement): HTMLElement {
  return (
    textbox.closest<HTMLElement>('[data-testid="composer-tiptap-input"]') ??
    textbox
  );
}

async function clickButton(name: string | RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function flushReactUpdates(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function backendToastEvents(
  federationTarget?: AgentEvent["federationTarget"],
): AgentEvent[] {
  const target = federationTarget ? { federationTarget } : {};
  return [
    {
      backend: "codex",
      ...target,
      notification: {
        method: "turn/failed",
        params: {
          threadId: "turn-failure-thread",
          turnId: "failed-turn",
          turn: {
            id: "failed-turn",
            status: "failed",
            error: { message: "Scoped turn failure" },
          },
        },
      },
    },
    {
      backend: "codex",
      ...target,
      notification: {
        method: "thread/codexInvalidIdRecovery/updated",
        params: {
          threadId: "recovery-thread",
          turnId: "recovery-turn",
          status: "failed",
          failureMessage: "Scoped invalid message ID",
          recoveryError: "Scoped recovery failure",
        },
      },
    },
    {
      backend: "codex",
      ...target,
      notification: {
        method: "thread/status/changed",
        params: {
          threadId: "system-error-thread",
          status: { type: "systemError" },
        },
      },
    },
  ];
}

function profileSummary(
  name: string,
  codexProfileName: string,
  active = false,
): DesktopPwrAgentProfileSummary {
  return {
    name,
    active,
    canDelete: name !== "default",
    codexProfile: {
      name: codexProfileName,
      displayName: codexProfileName || "System default",
      codexHome: codexProfileName
        ? `/home/example/.codex/profiles/${codexProfileName}`
        : "/home/example/.codex",
      exists: true,
      hasAuthFile: true,
      hasConfigFile: true,
      selected: true,
      source: codexProfileName ? "directory" : "default",
    },
    default: name === "default",
    profileDir: `/home/example/.pwragent/profiles/${name}`,
  };
}

describe("inferReplayCodexProfileModel", () => {
  it("opens Replay Onboarding in Multiple when multiple profiles have named Codex pairings", () => {
    const profiles = [
      profileSummary("personal", "personal", true),
      profileSummary("work", "work"),
    ];

    expect(inferReplayCodexProfileModel("shared", profiles)).toBe("multiple");
    expect(inferReplayCodexProfileSetup("shared", profiles)).toEqual({
      model: "multiple",
      profileNames: ["personal", "work"],
    });
  });

  it("opens Replay Onboarding in Isolated when the active profile has a named Codex pairing", () => {
    const profiles = [profileSummary("pwragent", "pwragent", true)];

    expect(inferReplayCodexProfileModel("shared", profiles)).toBe("isolated");
    expect(inferReplayCodexProfileSetup("shared", profiles)).toEqual({
      model: "isolated",
      profileNames: ["pwragent"],
    });
  });

  it("falls back to the persisted wizard choice when profile pairings are shared", () => {
    expect(
      inferReplayCodexProfileModel("multiple", [
        profileSummary("default", "", true),
      ]),
    ).toBe("multiple");
  });
});

describe("App", () => {
  afterEach(async () => {
    await flushReactUpdates();
    cleanup();
    delete (window as typeof window & {
      __pwragentFederationTarget?: unknown;
    }).__pwragentFederationTarget;
  });

  it("shows the thread shell without starting backends while the startup settings read is pending", async () => {
    const listBackends = vi.fn(async () => ({
      fetchedAt: Date.now(),
      backends: [],
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const readSettings = vi.fn(
      async () =>
        await new Promise<never>(() => {
          // Keep startup in the pending settings-read state.
        }),
    );

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        readSettings,
        listBackends,
        getNavigationSnapshot,
      },
    });

    render(<App />);

    expect(screen.queryByText("Exit Settings")).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Threads" })).toBeInTheDocument();
    expect(document.querySelector(".app-main")).toHaveClass(
      "app-main--thread-detail-pending"
    );
    expect(screen.getByRole("heading", { level: 2, name: "Loading..." })).toBeInTheDocument();
    await waitFor(() => {
      expect(readSettings).toHaveBeenCalledTimes(1);
    });
    expect(listBackends).not.toHaveBeenCalled();
    expect(getNavigationSnapshot).not.toHaveBeenCalled();
  });

  it("dismisses quick thread search before opening global search", async () => {
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        platform: "darwin",
        listBackends: async () => ({ fetchedAt: Date.now(), backends: [] }),
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: [],
          threads: [],
          directories: [],
          launchpadDefaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        readSettings: async () =>
          await new Promise<never>(() => {
            // Keep the shell mounted without needing a full settings fixture.
          }),
      },
    });

    render(<App />);

    fireEvent.keyDown(window, {
      metaKey: true,
      code: "KeyK",
      key: "k",
    });
    const quickSearch = await screen.findByRole("dialog", {
      name: "Jump to thread",
    });
    fireEvent.change(
      within(quickSearch).getByRole("textbox", { name: "Jump to thread" }),
      { target: { value: "something" } },
    );

    fireEvent.keyDown(window, {
      metaKey: true,
      shiftKey: true,
      code: "KeyF",
      key: "F",
    });

    expect(
      screen.queryByRole("dialog", { name: "Jump to thread" }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { level: 2, name: "Search" }),
    ).toBeInTheDocument();
  });

  // `useDesktopApi` resolves the preload bridge by polling, so the header's
  // Star Map control mounts and is clickable whether or not the bridge has
  // landed — and `desktopApi?.openStarMapWindow?.()` used to drop that click
  // without a sound. A Linux E2E lane failed twice on exactly that shape
  // (click, then six seconds of nothing, then "Star Map window did not
  // open"), so the no-op has to be audible from the renderer console.
  it("reports a Star Map click that the desktop bridge cannot serve", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        platform: "darwin",
        listBackends: async () => ({ fetchedAt: Date.now(), backends: [] }),
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: [],
          threads: [],
          directories: [],
          launchpadDefaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        readSettings: async () =>
          await new Promise<never>(() => {
            // Keep the shell mounted without needing a full settings fixture.
          }),
        // Deliberately absent: `openStarMapWindow`.
      },
    });

    try {
      render(<App />);

      fireEvent.click(
        await screen.findByRole("button", { name: "Open Star Map" }),
      );

      expect(consoleError).toHaveBeenCalledWith(
        "Open Star Map ignored: the desktop bridge is not ready.",
        { bridgePresent: true },
      );
    } finally {
      // Restore even when the assertion throws: `console.error` is how React
      // reports act() and render warnings, so leaving it stubbed would mute
      // every remaining test in this file and turn one failure into a
      // misleading cascade.
      consoleError.mockRestore();
    }
  });

  it("starts a new thread on a selected federation machine and profile", async () => {
    const federationListeners = new Set<(event: AgentEvent) => void>();
    const threadViewImported = createDeferred<void>();
    const remoteTarget = { scope: "remote" as const, instanceId: "studio-work" };
    const remoteWorkspace = {
      key: "workspace:new-thread",
      kind: "workspace" as const,
      label: "Workspaces",
      threadKeys: [],
      needsAttentionCount: 0,
    };
    const remoteProject = {
      key: "directory:/Users/harold/src/PwrAgent",
      kind: "directory" as const,
      label: "PwrAgent",
      path: "/Users/harold/src/PwrAgent",
      threadKeys: [],
      needsAttentionCount: 0,
      latestUpdatedAt: 1,
    };
    const getNavigationSnapshot = vi.fn(
      async (request?: { federationTarget?: FederationTarget }) => ({
        backend: "all" as const,
        fetchedAt: Date.now(),
        unchanged: false,
        inboxThreadKeys: [],
        threads: [],
        directories: request?.federationTarget
          ? [remoteWorkspace, remoteProject]
          : [],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
        ...(request?.federationTarget
          ? { federationTarget: request.federationTarget }
          : {}),
      }),
    );
    const ensureDirectoryLaunchpad = vi.fn(
      async (request: EnsureDirectoryLaunchpadRequest) => ({
        launchpad: {
          directoryKey: request.directoryKey,
          directoryKind: request.directoryKind,
          directoryLabel: request.directoryLabel,
          directoryPath: request.directoryPath,
          backend: "codex" as const,
          executionMode: "default" as const,
          prompt: "",
          workMode: "local" as const,
          ...(request.federationTarget
            ? { federationTarget: request.federationTarget }
            : {}),
          createdAt: 1,
          updatedAt: 2,
        },
        defaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
        },
      }),
    );
    let peers: FederationPeerSummary[] = [
      {
        id: "studio-work",
        label: "Studio Mac",
        profileName: "work",
        role: "client" as const,
        status: "connected" as const,
        capabilities: [
          "thread_navigation",
          "environment_actions",
        ] as const,
      },
      {
        id: "read-only",
        label: "Read-only peer",
        role: "client" as const,
        status: "connected" as const,
        capabilities: ["remote_window", "thread_navigation"] as const,
      },
    ];
    const readFederationHealth = vi.fn(async () => ({
      health: {
        enabled: true,
        role: "gateway" as const,
        status: "connected" as const,
        instanceId: "local-instance",
        localLabel: "Studio Mac",
        localProfileName: "default",
        peers,
      },
    }));
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        getNavigationSnapshot,
        ensureDirectoryLaunchpad,
        listBackends: async () => ({ fetchedAt: Date.now(), backends: [] }),
        onAgentEvent: (listener: (event: AgentEvent) => void) => {
          federationListeners.add(listener);
          return () => federationListeners.delete(listener);
        },
        onWindowFocus: () => () => undefined,
        readFederationHealth,
        recordStartupProfileEvent: (event: string) => {
          if (event === "thread-view-import:end") {
            threadViewImported.resolve(undefined);
          }
        },
      },
    });

    render(<App />);
    await waitFor(() => expect(readFederationHealth).toHaveBeenCalled());

    const button = screen.getByRole("button", { name: "New thread" });
    fireEvent.mouseEnter(button.parentElement as HTMLElement);
    // A peer whose build cannot host a thread stays listed and disabled —
    // vanishing from the list is indistinguishable from a bug, and Settings →
    // Federation already keeps such a peer visible with a disabled action.
    expect(
      await screen.findByRole("menuitem", { name: /Read-only peer/ }),
    ).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(await screen.findByRole("menuitem", {
      name: "Studio Mac / work",
    }));

    await waitFor(() => expect(getNavigationSnapshot).toHaveBeenCalledWith({
      federationTarget: remoteTarget,
    }));
    await waitFor(() => expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "workspace:new-thread",
      directoryKind: "workspace",
      directoryLabel: "Workspaces",
      directoryPath: undefined,
      federationTarget: remoteTarget,
      preferredBackend: undefined,
    }));
    // The menu intentionally fire-and-forgets its async target callback, and
    // thread detail is loaded after two animation frames. The bridge call can
    // therefore finish before the composer module is ready on a loaded CI
    // runner. Synchronize on the app's startup-profile readiness event rather
    // than extending the query timeout.
    await threadViewImported.promise;
    await flushReactUpdates();
    expect(await screen.findByRole("textbox", { name: "New thread" }))
      .toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Choose a project" }));
    expect(await screen.findByRole("option", { name: /PwrAgent/ }))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /PwrAgent/ }));

    await waitFor(() => expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: remoteProject.key,
      directoryKind: "directory",
      directoryLabel: "PwrAgent",
      directoryPath: "/Users/harold/src/PwrAgent",
      federationTarget: remoteTarget,
      preferredBackend: undefined,
    }));
    expect(screen.getByRole("button", { name: "Project: PwrAgent" }))
      .toBeInTheDocument();

    const healthReadCount = readFederationHealth.mock.calls.length;
    peers = [
      {
        id: "laptop-default",
        label: "Laptop",
        role: "client" as const,
        status: "connected" as const,
        capabilities: [
          "thread_navigation",
          "environment_actions",
        ] as const,
      },
    ];
    act(() => {
      for (const listener of federationListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "federation/peerStatus/changed",
            params: {
              instanceId: "laptop-default",
              status: "connected",
            },
          },
        });
      }
    });
    await waitFor(() => {
      expect(readFederationHealth.mock.calls.length).toBeGreaterThan(healthReadCount);
    });

    fireEvent.mouseEnter(button.parentElement as HTMLElement);
    expect(await screen.findByRole("menuitem", {
      name: "Laptop",
    })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", {
      name: "Studio Mac / work",
    })).not.toBeInTheDocument();
  });

  it("does not offer the current remote window as a new-thread target", async () => {
    (window as typeof window & {
      __pwragentFederationTarget?: unknown;
    }).__pwragentFederationTarget = {
      scope: "remote",
      instanceId: "m4",
    };
    const windowFocusListeners = new Set<() => void>();
    const readFederationHealth = vi.fn(async () => ({
      health: {
        enabled: true,
        role: "gateway" as const,
        status: "connected" as const,
        instanceId: "local-instance",
        peers: [
          {
            id: "m4",
            label: "Harold-Mac-Mini-M4",
            role: "client" as const,
            status: "connected" as const,
            capabilities: [
              "remote_window",
              "thread_navigation",
              "environment_actions",
            ] as const,
          },
          {
            id: "laptop",
            label: "Harold-MBP-M2-Max",
            role: "client" as const,
            status: "connected" as const,
            capabilities: [
              "remote_window",
              "thread_navigation",
              "environment_actions",
            ] as const,
          },
        ],
      },
    }));
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        ensureDirectoryLaunchpad: async () => ({
          launchpad: {
            directoryKey: "workspace:new-thread",
            directoryKind: "workspace" as const,
            directoryLabel: "Workspaces",
            backend: "codex" as const,
            executionMode: "default" as const,
            prompt: "",
            workMode: "local" as const,
            createdAt: 1,
            updatedAt: 1,
          },
          defaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: [],
          threads: [],
          directories: [],
          launchpadDefaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        listBackends: async () => ({ fetchedAt: Date.now(), backends: [] }),
        onAgentEvent: () => () => undefined,
        onWindowFocus: (listener: () => void) => {
          windowFocusListeners.add(listener);
          return () => {
            windowFocusListeners.delete(listener);
          };
        },
        openFederationWindow: vi.fn(),
        readFederationHealth,
      },
    });

    render(<App />);
    await waitFor(() => expect(windowFocusListeners.size).toBeGreaterThan(0));
    act(() => {
      for (const listener of windowFocusListeners) {
        listener();
      }
    });
    await waitFor(() => expect(readFederationHealth).toHaveBeenCalled());

    const button = screen.getByRole("button", { name: "New thread" });
    await waitFor(() => expect(button).toHaveAttribute("aria-haspopup", "menu"));
    fireEvent.mouseEnter(button.parentElement as HTMLElement);

    expect(await screen.findByRole("menuitem", {
      name: "Harold-MBP-M2-Max",
    })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", {
      name: "Harold-Mac-Mini-M4",
    })).not.toBeInTheDocument();
  });

  it("surfaces GitHub organization SAML enforcement as a sticky error toast", async () => {
    let samlListener:
      | ((event: {
          branch?: string;
          occurredAt: number;
          target: { kind: "github-repository"; owner: string; repo: string };
        }) => void)
      | undefined;
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: [],
          threads: [],
          directories: [],
          launchpadDefaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        listBackends: async () => ({ fetchedAt: Date.now(), backends: [] }),
        onGithubPrSamlEnforcement: (listener: typeof samlListener) => {
          samlListener = listener;
          return () => {
            samlListener = undefined;
          };
        },
        readSettings: async () =>
          await new Promise<never>(() => {
            // Keep the shell mounted without needing a full settings fixture.
          }),
      },
    });

    render(<App />);
    await waitFor(() => expect(samlListener).toBeDefined());
    act(() => {
      samlListener?.({
        branch: "main",
        occurredAt: 123,
        target: {
          kind: "github-repository",
          owner: "EXAMPLE",
          repo: "catalog-service",
        },
      });
      samlListener?.({
        occurredAt: 124,
        target: {
          kind: "github-repository",
          owner: "historical",
          repo: "retained-repo",
        },
      });
    });

    expect(screen.getByText("GitHub access blocked by SSO")).toBeInTheDocument();
    expect(screen.getByText(/organization requires SAML SSO/)).toBeInTheDocument();
    expect(
      screen.getByText(
        "Repository: github.com/EXAMPLE/catalog-service · Branch: main",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(
      screen.getByText("Repository: github.com/historical/retained-repo"),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Open Git settings" }),
    );
    // Settings is a lazy chunk. Under a loaded Windows worker the module can
    // settle after Testing Library's default one-second find bound, even
    // though navigation completed normally. Wait for the import lifecycle
    // itself so this assertion measures the selected settings section.
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    const gitSettingsButton = screen.getByRole("button", { name: "Git" });
    expect(gitSettingsButton).toHaveAttribute("aria-current", "page");
  });

  it.each([
    {
      label: "the local window",
      rendererTarget: undefined,
      expected: true,
    },
    {
      label: "a federation-only window",
      rendererTarget: {
        scope: "remote" as const,
        instanceId: "remote-gateway",
      },
      expected: false,
    },
  ])("replays pending spend alerts only to $label", async ({
    rendererTarget,
    expected,
  }) => {
    if (rendererTarget) {
      (window as typeof window & {
        __pwragentFederationTarget?: unknown;
      }).__pwragentFederationTarget = rendererTarget;
    }
    const acknowledgeThreadSpendAlert = vi.fn(async () => ({
      acknowledged: true,
      backend: "codex",
      threadId: "thread-spend-pending",
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [{
        id: "thread-spend-pending",
        title: "Expensive build",
        titleSource: "explicit" as const,
        source: "codex" as const,
        linkedDirectories: [],
        inbox: { inInbox: false },
        updatedAt: 2_000,
        threadSpendAlertPending: {
          alertId: "spend-alert:thread:codex:thread-spend-pending",
          createdAt: 1_800_000_000_000,
          currency: "USD" as const,
          kind: "thread-spend" as const,
          spendMicros: 31_000_000,
          threadId: "thread-spend-pending",
          thresholdMicros: 25_000_000,
        },
      }],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
      ...(rendererTarget ? { federationTarget: rendererTarget } : {}),
    }));
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        acknowledgeThreadSpendAlert,
        getNavigationSnapshot,
        listBackends: async () => ({ fetchedAt: Date.now(), backends: [] }),
        onAgentEvent: () => () => undefined,
        onWindowFocus: () => () => undefined,
      },
    });

    render(<App />);
    await waitFor(() => expect(getNavigationSnapshot).toHaveBeenCalled());

    if (!expected) {
      expect(screen.queryByText("Thread spend threshold reached"))
        .not.toBeInTheDocument();
      expect(acknowledgeThreadSpendAlert).not.toHaveBeenCalled();
      return;
    }

    expect(await screen.findByText("Thread spend threshold reached"))
      .toBeInTheDocument();
    await waitFor(() => {
      expect(acknowledgeThreadSpendAlert).toHaveBeenCalledWith({
        alertId: "spend-alert:thread:codex:thread-spend-pending",
        backend: "codex",
        threadId: "thread-spend-pending",
      });
    });
  });

  it.each([
    {
      label: "local events in the main window",
      rendererTarget: undefined,
      eventTarget: undefined,
      expected: true,
    },
    {
      label: "remote events with no matching viewer",
      rendererTarget: undefined,
      eventTarget: { scope: "remote" as const, instanceId: "remote-gateway" },
      expected: false,
    },
    {
      label: "matching events in a remote viewer",
      rendererTarget: {
        scope: "remote" as const,
        instanceId: "remote-gateway",
      },
      eventTarget: { scope: "remote" as const, instanceId: "remote-gateway" },
      expected: true,
    },
    {
      label: "local events in a remote viewer",
      rendererTarget: {
        scope: "remote" as const,
        instanceId: "remote-gateway",
      },
      eventTarget: undefined,
      expected: false,
    },
    {
      label: "nonmatching events in a remote viewer",
      rendererTarget: {
        scope: "remote" as const,
        instanceId: "remote-gateway",
      },
      eventTarget: { scope: "remote" as const, instanceId: "another-peer" },
      expected: false,
    },
  ])("scopes all backend error toast paths for $label", async ({
    rendererTarget,
    eventTarget,
    expected,
  }) => {
    const agentEventListeners = new Set<(event: AgentEvent) => void>();
    const copyText = vi.fn(async () => undefined);
    if (rendererTarget) {
      (window as typeof window & {
        __pwragentFederationTarget?: unknown;
      }).__pwragentFederationTarget = rendererTarget;
    }
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        copyText,
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: [],
          threads: [],
          directories: [],
          launchpadDefaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        listBackends: async () => ({ fetchedAt: Date.now(), backends: [] }),
        onAgentEvent: (listener: (event: AgentEvent) => void) => {
          agentEventListeners.add(listener);
          return () => {
            agentEventListeners.delete(listener);
          };
        },
        readSettings: async () =>
          await new Promise<never>(() => {
            // Keep the shell mounted without needing a full settings fixture.
          }),
      },
    });

    render(<App />);
    await waitFor(() => expect(agentEventListeners.size).toBeGreaterThan(0));

    act(() => {
      for (const event of backendToastEvents(eventTarget)) {
        for (const listener of agentEventListeners) {
          listener(event);
        }
      }
    });

    if (!expected) {
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      return;
    }

    expect(screen.getByText("Turn failed")).toBeInTheDocument();
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    if (rendererTarget?.scope === "remote") {
      fireEvent.contextMenu(screen.getByRole("button", {
        name: "Open thread Codex thread",
      }));
      fireEvent.click(screen.getByRole("menuitem", {
        name: "Copy Thread Link",
      }));
      expect(copyText).toHaveBeenCalledWith(
        "pwragent://thread/turn-failure-thread?backend=codex"
        + "&instanceId=remote-gateway",
      );
    }
    fireEvent.click(screen.getByRole("button", { name: "Next notice" }));
    expect(screen.getByText("Codex repair failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next notice" }));
    expect(screen.getByText("Agent backend error")).toBeInTheDocument();
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
  });

  it("opens the incident explorer from a replay-risk notice", async () => {
    const agentEventListeners = new Set<(event: AgentEvent) => void>();
    const openToolOutputIncidentExplorerWindow = vi.fn(async () => ({
      opened: true as const,
    }));
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: [],
          threads: [],
          directories: [],
          launchpadDefaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        listBackends: async () => ({ fetchedAt: Date.now(), backends: [] }),
        onAgentEvent: (listener: (event: AgentEvent) => void) => {
          agentEventListeners.add(listener);
          return () => {
            agentEventListeners.delete(listener);
          };
        },
        readSettings: async () =>
          await new Promise<never>(() => {
            // Keep the shell mounted without needing a full settings fixture.
          }),
        openToolOutputIncidentExplorerWindow,
      },
    });

    render(<App />);
    await waitFor(() => expect(agentEventListeners.size).toBeGreaterThan(0));

    act(() => {
      const event = {
        backend: "codex",
        notification: {
          method: "thread/toolAccounting/updated",
          params: {
            threadId: "thread-1",
            toolAccounting: {
              alerts: [],
              invocations: Array.from({ length: 5 }, (_, index) => ({
                backend: "codex",
                category: "polling",
                debugLines: 0,
                errorLines: 0,
                estimatedOutputTokens: 0,
                infoLines: 0,
                invocationId: `wait-${index}`,
                itemId: `item-${index}`,
                noisy: true,
                noisyReason: "repeat-polling-output",
                observedAt: 1_000 + index * 30_000,
                outputChars: 0,
                outputLines: 0,
                outputTruncated: false,
                status: "completed",
                threadId: "thread-1",
                toolName: "wait",
                turnId: "turn-1",
                updatedAt: 1_000 + index * 30_000,
                warningLines: 0,
              })),
              summaries: [],
            },
            triggeredAlerts: [{
              alertId: "noisy-polling:codex:thread-1:wait:turn-1",
              backend: "codex",
              createdAt: 1,
              estimatedOutputTokens: 0,
              firstObservedAt: 1,
              invocationCount: 5,
              kind: "noisy-polling",
              lastObservedAt: 2,
              message: "Five queued checks keep replaying the turn context.",
              severity: "warning",
              suggestedPrompt: "Stop polling and use a monitor job.",
              threadId: "thread-1",
              toolName: "wait",
              totalOutputChars: 0,
              turnId: "turn-1",
              updatedAt: 2,
            }],
          },
        },
      } as AgentEvent;
      for (const listener of agentEventListeners) {
        listener(event);
      }
    });

    expect(screen.getByText("Repeated queued checks")).toBeInTheDocument();
    /* One consolidated card for the thread, describing the whole pattern,
       rather than one card per turn that tripped the detector. */
    expect(screen.getByText(/5 are repeated queued checks/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Examine 5 cases" }));

    await waitFor(() => {
      expect(openToolOutputIncidentExplorerWindow).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        title: "Codex thread",
      });
    });
  });

  it("does not raise a tool-output card when no new threshold tripped", async () => {
    /* Accounting updates fire on every tool call. Folding on all of them
       re-alerted about last week's calls the first time an old thread ran
       anything. */
    const agentEventListeners = new Set<(event: AgentEvent) => void>();
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: [],
          threads: [],
          directories: [],
          launchpadDefaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        listBackends: async () => ({ fetchedAt: Date.now(), backends: [] }),
        onAgentEvent: (listener: (event: AgentEvent) => void) => {
          agentEventListeners.add(listener);
          return () => {
            agentEventListeners.delete(listener);
          };
        },
        readSettings: async () =>
          await new Promise<never>(() => {
            // Keep the shell mounted without needing a full settings fixture.
          }),
      },
    });
    render(<App />);
    await waitFor(() => expect(agentEventListeners.size).toBeGreaterThan(0));

    act(() => {
      const event = {
        backend: "codex",
        notification: {
          method: "thread/toolAccounting/updated",
          params: {
            threadId: "thread-1",
            toolAccounting: {
              alerts: [],
              invocations: [{
                backend: "codex",
                category: "shell",
                debugLines: 0,
                errorLines: 0,
                estimatedOutputTokens: 5_000,
                infoLines: 0,
                invocationId: "old-large-call",
                itemId: "old-item",
                noisy: true,
                observedAt: 1_000,
                outputChars: 20_000,
                outputLines: 100,
                outputTruncated: false,
                status: "completed",
                threadId: "thread-1",
                toolName: "commandExecution",
                turnId: "turn-old",
                updatedAt: 1_000,
                warningLines: 0,
              }],
              summaries: [],
            },
            /* No triggeredAlerts: nothing crossed a threshold just now. */
          },
        },
      } as AgentEvent;
      for (const listener of agentEventListeners) listener(event);
    });

    expect(screen.queryByText("Large tool output")).not.toBeInTheDocument();
  });

  it("reveals the sidebar when adding a project from the hidden-sidebar masthead", async () => {
    const pickDirectoryFromDisk = vi.fn(async () => ({
      canceled: false as const,
      path: "/Users/me/repos/PwrAgent",
    }));
    const registerDirectoryFromDisk = vi.fn(async () => ({
      ok: true as const,
      directoryPath: "/Users/me/repos/PwrAgent",
      directoryKey: "directory:/Users/me/repos/PwrAgent",
      directoryLabel: "PwrAgent",
      currentBranch: "main",
      launchpad: {
        directoryKey: "directory:/Users/me/repos/PwrAgent",
        directoryKind: "directory" as const,
        directoryLabel: "PwrAgent",
        directoryPath: "/Users/me/repos/PwrAgent",
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "",
        workMode: "local" as const,
        createdAt: 1,
        updatedAt: 1,
        registeredAt: 1,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        platform: "darwin",
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [],
        }),
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: [],
          threads: [],
          directories: [],
          launchpadDefaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        pickDirectoryFromDisk,
        registerDirectoryFromDisk,
        onAgentEvent: () => () => undefined,
      },
    });

    const { container } = render(<App />);
    await clickButton("Hide sidebar");

    const shell = container.querySelector(".app-shell");
    expect(shell).toHaveAttribute("data-sidebar-hidden", "true");

    const relocatedMasthead = await waitFor(() => {
      const masthead = container.querySelector<HTMLElement>(
        ".thread-header__masthead",
      );
      expect(masthead).not.toBeNull();
      return masthead!;
    });
    fireEvent.mouseEnter(
      within(relocatedMasthead).getByRole("button", { name: "New thread" }),
    );
    fireEvent.click(
      await within(relocatedMasthead).findByRole("menuitem", {
        name: "Add a Project Directory…",
      }),
    );

    await waitFor(() => {
      expect(pickDirectoryFromDisk).toHaveBeenCalledTimes(1);
      expect(registerDirectoryFromDisk).toHaveBeenCalledTimes(1);
      expect(shell).not.toHaveAttribute("data-sidebar-hidden");
    });
    expect(
      within(screen.getByRole("complementary", { name: "Threads" })).getByText(
        "PwrAgent",
      ),
    ).toBeInTheDocument();
  });

  it("surfaces Codex config warnings and can trust the indicated project", async () => {
    const agentEventListeners = new Set<(event: AgentEvent) => void>();
    const trustCodexProject = vi.fn(
      async (request: { projectPath: string; configPath?: string }) => ({
        ...request,
        trusted: true,
      }),
    );

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [],
        }),
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: [],
          threads: [],
          directories: [],
          launchpadDefaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        onAgentEvent: (listener: (event: AgentEvent) => void) => {
          agentEventListeners.add(listener);
          return () => {
            agentEventListeners.delete(listener);
          };
        },
        trustCodexProject,
      },
    });

    render(<App />);

    await waitFor(() => {
      expect(agentEventListeners.size).toBeGreaterThan(0);
    });

    await act(async () => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "configWarning",
            params: {
              summary:
                "Project-local config, hooks, and exec policies are disabled.\n" +
                "To load project-local config, hooks, and exec policies, add /Users/fixture-user/github/PwrAgnt as a trusted project in /Users/fixture-user/.codex/profiles/acp-smoke/config.toml.",
              details: null,
              trustedProjectPath: "/Users/fixture-user/github/PwrAgnt",
              configPath: "/Users/fixture-user/.codex/profiles/acp-smoke/config.toml",
            },
          },
        });
      }
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Codex config warning"
    );
    fireEvent.click(screen.getByRole("button", { name: "Trust PwrAgnt" }));

    await waitFor(() => {
      expect(trustCodexProject).toHaveBeenCalledWith({
        projectPath: "/Users/fixture-user/github/PwrAgnt",
        configPath: "/Users/fixture-user/.codex/profiles/acp-smoke/config.toml",
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  it("surfaces a buffered Codex config warning captured before renderer subscription", async () => {
    const trustCodexProject = vi.fn(
      async (request: { projectPath: string; configPath?: string }) => ({
        ...request,
        trusted: true,
      }),
    );
    const getLatestCodexConfigWarning = vi.fn(async () => ({
      event: {
        backend: "codex" as const,
        notification: {
          method: "configWarning" as const,
          params: {
            summary:
              "Project-local config, hooks, and exec policies are disabled.\n" +
              "To load project-local config, hooks, and exec policies, add /Users/fixture-user/github/PwrAgnt as a trusted project in /Users/fixture-user/.codex/profiles/acp-smoke/config.toml.",
            details: null,
            trustedProjectPath: "/Users/fixture-user/github/PwrAgnt",
            configPath: "/Users/fixture-user/.codex/profiles/acp-smoke/config.toml",
          },
        },
      },
    }));

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [],
        }),
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: [],
          threads: [],
          directories: [],
          launchpadDefaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        getLatestCodexConfigWarning,
        trustCodexProject,
      },
    });

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Codex config warning"
    );
    expect(getLatestCodexConfigWarning).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Trust PwrAgnt" }));

    await waitFor(() => {
      expect(trustCodexProject).toHaveBeenCalledWith({
        projectPath: "/Users/fixture-user/github/PwrAgnt",
        configPath: "/Users/fixture-user/.codex/profiles/acp-smoke/config.toml",
      });
    });
  });

  it("keeps the app shell on the last good config when desktop settings is malformed", async () => {
    const listBackends = vi.fn(async () => ({
      fetchedAt: Date.now(),
      backends: [],
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const snapshot = {
      fetchedAt: 1,
      configPath: "/tmp/pwragent/config.toml",
      configError: "line 3: expected a key",
      runtime: {
        messaging: {
          disabled: false,
        },
      },
      secretStorage: {
        available: true,
        backend: "memory",
        encrypted: false,
      },
      general: {
        confirmQuitWithInProgressThreads: {
          value: true,
          source: "default",
        },
        attentionPromoteOnTurnEnd: {
          value: true,
          source: "default",
        },
        developerMode: {
          value: false,
          source: "default",
        },
        pdfAnalysisEnabled: {
          value: true,
          source: "default",
        },
        hotCpuProfilingEnabled: {
          value: false,
          source: "default",
        },
        hotCpuProfilingStartDelayMs: {
          value: 0,
          source: "default",
        },
        hotCpuProfilingTriggerMode: {
          value: "sustained",
          source: "default",
        },
        hotCpuProfilingSlowburnThresholdPercent: {
          value: 15,
          source: "default",
        },
        hotCpuProfilingCaptureHeapSnapshot: {
          value: false,
          source: "default",
        },
        hotCpuProfilingHeapSnapshotLimit: {
          value: 2,
          source: "default",
        },
        notificationsEnabled: {
          value: false,
          source: "default",
        },
        toolOutputAlerts: {
          outputCapHitsEnabled: { value: true, source: "config" },
          repeatedLargeOutputsEnabled: { value: true, source: "config" },
          repeatedLargeOutputMinimumCalls: { value: 5, source: "default" },
          repeatedLargeOutputMinimumPercent: { value: 50, source: "default" },
          repeatedQueuedChecksEnabled: { value: true, source: "config" },
        },
        spendAlerts: {
          activeTurnSpendEnabled: { value: true, source: "config" },
          activeTurnSpendThresholdUsd: { value: 5, source: "default" },
          threadSpendEnabled: { value: true, source: "default" },
          threadSpendThresholdUsd: { value: 25, source: "default" },
        },
        appearance: {
          theme: { value: "system", source: "default" },
          density: { value: "mission-control", source: "default" },
          sidebarTextSize: { value: "md", source: "default" },
          transcriptTextSize: { value: "md", source: "default" },
        },
        codexProfileModel: { value: "shared", source: "default" },
        messagingAcknowledgment: { value: null, source: "default" },
      },
      onboarding: {
        completed: { value: true, source: "default" },
        completedSource: { value: "migrated", source: "default" },
      },
      experimental: {
        chatReplyComposer: {
          value: "tiptap-wysiwyg-markdown-chips",
          source: "default",
        },
        fullAccessRiskWarningDismissed: {
          value: false,
          source: "default",
        },
        liveTranscriptEventFiltering: {
          value: false,
          source: "default",
        },
        lightweightNavigationRefresh: {
          value: false,
          source: "default",
        },
        tokenMiserEnabled: {
          value: false,
          source: "default",
        },
        codexDefaultModeRequestUserInput: {
          value: false,
          source: "default",
        },
        diffCondensation: {
          enabled: { value: false, source: "default" },
        },
      },
      imageUploads: {
        pastedImageMaxPatches: { value: 1536, source: "default" },
      },
      updates: {
        channel: { value: "latest", source: "default" },
        train: { value: "stable", source: "default" },
      },
      integratedTerminal: {
        windowsShell: { value: "auto", source: "default" },
      },
      ui: {
        sidebarHidden: { value: false, source: "default" },
        contextRailPinned: { value: false, source: "default" },
        activeContextTab: { value: "info", source: "default" },
        editedFilesDock: { value: "above", source: "default" },
        actionRunsDock: { value: "above", source: "default" },
      },
      federation: {
        mode: { value: "disabled", source: "default" },
        instanceLabel: { value: "", source: "default" },
        instanceNotes: { value: "", source: "default" },
        listenHost: { value: "127.0.0.1", source: "default" },
        listenPort: { value: 47830, source: "default" },
        publicUrl: { value: "", source: "default" },
        gatewayUrl: { value: "", source: "default" },
        gatewayEndpoints: { value: [], source: "default" },
        advertisedEndpoints: { value: [], source: "default" },
        cloudflareEndpoint: { value: "", source: "default" },
        cloudflareMtlsEnabled: { value: false, source: "default" },
        cloudflareAccessServiceAuthEnabled: {
          value: false,
          source: "default",
        },
        instancePrivateKey: {
          configured: false,
          source: "unset",
          writable: true,
        },
        noiseStaticPrivateKey: {
          configured: false,
          source: "unset",
          writable: true,
        },
        cloudflareClientCertificate: {
          configured: false,
          source: "unset",
          writable: true,
        },
        cloudflareClientPrivateKey: {
          configured: false,
          source: "unset",
          writable: true,
        },
        cloudflareAccessClientId: {
          configured: false,
          source: "unset",
          writable: true,
        },
        cloudflareAccessClientSecret: {
          configured: false,
          source: "unset",
          writable: true,
        },
      },
      messaging: {
        enabled: { value: true, source: "default" },
        allowFullAccessEscalation: { value: true, source: "default" },
        allowFullAccessThreadResume: { value: true, source: "default" },
        fullAccessWarning: { value: "dismissable", source: "default" },
        inputDebounceMs: { value: 500, source: "default" },
        toolUpdateMode: { value: "show_some", source: "default" },
        managerToolUpdateMode: { value: "show_none", source: "default" },
        showStreamingOption: { value: false, source: "default" },
        telegram: {
          enabled: { value: false, source: "default" },
          responseMode: { value: "every_message", source: "default" },
          streamingResponses: { value: false, source: "default" },
          botToken: { configured: false, source: "unset", writable: true },
          authorizedUserIds: { value: [], source: "default" },
          authorizedSupergroups: { value: [], source: "default" },
        },
        discord: {
          enabled: { value: false, source: "default" },
          responseMode: { value: "every_message", source: "default" },
          responseModeOverrides: { value: [], source: "default" },
          streamingResponses: { value: false, source: "default" },
          botToken: { configured: false, source: "unset", writable: true },
          applicationId: { value: "", source: "default" },
          authorizedUserIds: { value: [], source: "default" },
          authorizedGuilds: { value: [], source: "default" },
        },
        mattermost: {
          enabled: { value: false, source: "default" },
          streamingResponses: { value: false, source: "default" },
          botToken: { configured: false, source: "unset", writable: true },
          hmacSecret: { configured: false, source: "unset", writable: true },
          serverUrl: { value: "", source: "default" },
          callbackBaseUrl: { value: "", source: "default" },
          slashCommandPrefix: { value: "pwragent_", source: "default" },
          registerSlashCommands: { value: false, source: "default" },
          authorizedUserIds: { value: [], source: "default" },
          authorizedTeams: { value: [], source: "default" },
          authorizedConversations: { value: [], source: "default" },
        },
        slack: {
          enabled: { value: false, source: "default" },
          liveWorkingCards: { value: false, source: "default" },
          responseMode: { value: "mention_only", source: "default" },
          streamingResponses: { value: false, source: "default" },
          botToken: { configured: false, source: "unset", writable: true },
          appToken: { configured: false, source: "unset", writable: true },
          signingSecret: { configured: false, source: "unset", writable: true },
          workspaceUrl: { value: "", source: "default" },
          inboundMode: { value: "socket", source: "default" },
          teamAuthorizationMode: { value: "approved_only", source: "default" },
          channelAuthorizationMode: { value: "approved_only", source: "default" },
          dmAccessMode: { value: "authorized_users", source: "default" },
          groupDmAccessMode: { value: "none", source: "default" },
          channelUserAccessMode: { value: "authorized_users", source: "default" },
          slashCommandPrefix: { value: "pwragent_", source: "default" },
          registerSlashCommands: { value: false, source: "default" },
          authorizedUserIds: { value: [], source: "default" },
          authorizedWorkspaces: { value: [], source: "default" },
          authorizedChannels: { value: [], source: "default" },
        },
        feishu: {
          enabled: { value: false, source: "default" },
          streamingResponses: { value: false, source: "default" },
          appId: { configured: false, source: "unset", writable: true },
          appSecret: { configured: false, source: "unset", writable: true },
          encryptKey: { configured: false, source: "unset", writable: true },
          verificationToken: { configured: false, source: "unset", writable: true },
          inboundMode: { value: "persistent", source: "default" },
          tenantRegion: { value: "feishu", source: "default" },
          tenantUrl: { value: "https://open.feishu.cn", source: "default" },
          callbackBaseUrl: { value: "http://127.0.0.1:47823", source: "default" },
          slashCommandPrefix: { value: "pwragent_", source: "default" },
          registerSlashCommands: { value: false, source: "default" },
          authorizedUserIds: { value: [], source: "default" },
          authorizedChats: { value: [], source: "default" },
          authorizedTenants: { value: [], source: "default" },
        },
        line: {
          enabled: { value: false, source: "default" },
          streamingResponses: { value: false, source: "default" },
          channelAccessToken: { configured: false, source: "unset", writable: true },
          channelSecret: { configured: false, source: "unset", writable: true },
          webhookUrl: { value: "", source: "default" },
          callbackBaseUrl: { value: "", source: "default" },
          botUserId: { value: "", source: "default" },
          authorizedUserIds: { value: [], source: "default" },
          authorizedGroups: { value: [], source: "default" },
          authorizedRooms: { value: [], source: "default" },
        },
        attachments: {
          imageProfile: { value: "medium", source: "default" },
          pdfProfile: { value: "high", source: "default" },
          maxAttachmentBytes: { value: 10485760, source: "default" },
          maxAttachmentCount: { value: 4, source: "default" },
        },
      },
      models: {
        codex: {
          path: { value: "", source: "default" },
          profile: { value: "", source: "default" },
          discovery: {
            selectedCommand: undefined,
            candidates: [],
          },
          profiles: {
            profileRoot: "/home/example/.codex/profiles",
            effectiveCodexHome: "/home/example/.codex",
            profiles: [],
          },
        },
      },
      acpAgents: {
        gemini: { cliPath: { value: "", source: "default" }, enabled: true },
        grok: { cliPath: { value: "", source: "default" }, enabled: true },
        kimi: { cliPath: { value: "", source: "default" }, enabled: true },
        qwen: { cliPath: { value: "", source: "default" }, enabled: true },
      },
      git: {
        backgroundPrPolling: { value: true, source: "default" },
        prAutoDispatchAllowed: { value: true, source: "default" },
        defaultPrAutoDispatchEnabled: { value: true, source: "default" },
        prAutoDispatchBudgetCapacity: { value: 30, source: "default" },
        prAutoDispatchBudgetRefillPerMinute: {
          value: 1,
          source: "default",
        },
        pausePrAutoDispatchWhenBudgetEmpty: {
          value: true,
          source: "default",
        },
      },
      applications: {
        editors: [],
        terminals: [],
        preferredEditorId: { value: "", source: "default" },
        preferredTerminalId: { value: "", source: "default" },
        gh: {
          path: { value: "", source: "default" },
          discovery: { candidates: [] },
        },
        git: {
          discovery: { candidates: [] },
        },
      },
      worktrees: {
        storage: { value: "user-home", source: "default" },
        effectivePath: "/home/example/.pwragent/worktrees",
      },
    } satisfies DesktopSettingsSnapshot;

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        readSettings: async () => ({ snapshot }),
        listBackends,
        getNavigationSnapshot,
      },
    });

    render(<App />);

    expect(await screen.findByText("Settings config did not load")).toBeInTheDocument();
    expect(screen.getByText(/line 3: expected a key/)).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Threads" })).toBeInTheDocument();
  });

  it("starts loading navigation without waiting for settings discovery", async () => {
    const settings = createDeferred<{ snapshot: DesktopSettingsSnapshot }>();
    const backends = createDeferred<{
      fetchedAt: number;
      backends: [];
    }>();
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
      providerRefresh: {
        state: "checking" as const,
      },
    }));

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        readConfigBootstrap: vi.fn(async () => ({
          snapshot: {
            version: 1,
            configRevision: "fixture",
            appearance: {
              theme: "system" as const,
              density: "mission-control" as const,
              sidebarTextSize: "md" as const,
              transcriptTextSize: "md" as const,
            },
            onboarding: {
              completed: true,
              completedSource: "migrated" as const,
            },
          },
        })),
        readSettings: () => settings.promise,
        listBackends: vi.fn(() => backends.promise),
        getNavigationSnapshot,
        onAgentEvent: () => () => undefined,
      },
    });

    render(<App />);

    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole("complementary", { name: "Threads" })).toBeInTheDocument();
    expect(screen.getByText("Checking providers…")).toBeInTheDocument();

    await act(async () => {
      settings.resolve({
        snapshot: {
          general: {
            appearance: {
              theme: { value: "system", source: "default" },
              density: { value: "mission-control", source: "default" },
              sidebarTextSize: { value: "md", source: "default" },
              transcriptTextSize: { value: "md", source: "default" },
            },
          },
          onboarding: {
            completed: { value: true, source: "default" },
          },
          imageUploads: {
            pastedImageMaxPatches: { value: 1536, source: "default" },
          },
          experimental: {
            fullAccessRiskWarningDismissed: {
              value: false,
              source: "default",
            },
          },
        } as DesktopSettingsSnapshot,
      });
    });

    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);
  });

  it("renders the live thread shell with transcript history", async () => {
    const copyText = vi.fn(async () => undefined);
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const listSkills = vi.fn(async () => ({
      backend: "codex" as const,
      fetchedAt: Date.now(),
      data: [
        {
          cwd: "/Users/fixture-user/.codex/worktrees/0f38/PwrAgent",
          skills: [
            {
              name: "frontend-design",
              description: "Design and verify renderer UI work.",
              path: "/Users/fixture-user/.codex/skills/frontend-design/SKILL.md",
              enabled: true
            }
          ]
        }
      ]
    }));
    const startTurn = vi.fn<
      (request: StartTurnRequest) => Promise<StartTurnResponse>
    >(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-1"
    }));
    const interruptTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-1",
    }));
    let readThreadCalls = 0;
    let resolveRefreshRead:
      | ((value: {
          backend: "codex";
          fetchedAt: number;
          threadId: string;
          replay: {
            entries: Array<Record<string, unknown>>;
            messages: Array<Record<string, unknown>>;
            lastUserMessage?: string;
            lastAssistantMessage?: string;
            pagination: {
              supportsPagination: boolean;
              hasPreviousPage: boolean;
            };
          };
        }) => void)
      | undefined;

    const transcriptResponse = {
      backend: "codex" as const,
      fetchedAt: Date.now(),
      threadId: "thread-1",
      replay: {
        entries: [
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Open the desktop plan and build the Codex client."
          },
          {
            type: "plan",
            id: "plan-1",
            explanation: "Track the desktop transcript work in three steps.",
            steps: [
              { step: "Normalize replay", status: "pending" },
              { step: "Render plan card", status: "pending" },
              { step: "Verify with tests", status: "pending" }
            ]
          },
          {
            type: "activity",
            id: "activity-1",
            summary: "Explored 2 files, ran 1 command",
            details: [
              {
                id: "detail-1",
                kind: "read",
                label: "Read TranscriptList.tsx"
              },
              {
                id: "detail-2",
                kind: "read",
                label: "Read ThreadView.tsx"
              },
              {
                id: "detail-3",
                kind: "command",
                label: "pwd && rg --files"
              }
            ]
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "The Codex client is wired and the thread browser is live."
          }
        ],
        messages: [
          {
            id: "message-1",
            role: "user",
            text: "Open the desktop plan and build the Codex client."
          },
          {
            id: "message-2",
            role: "assistant",
            text: "The Codex client is wired and the thread browser is live."
          }
        ],
        lastUserMessage: "Open the desktop plan and build the Codex client.",
        lastAssistantMessage:
          "The Codex client is wired and the thread browser is live.",
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false
        }
      }
    };

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        copyText,
        getRuntimeIdentity: async () => ({
          branch: "codex/fix-thread-naming-ephemeral",
          cwd: "/Users/fixture-user/pwrdrvr/PwrAgent/.worktrees/pwragent-fix-thread-naming-moioth2352",
        }),
        ping: () => "pong",
        listSkills,
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read", "skills/list", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: false,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: true,
                interruptTurn: false,
                steerTurn: false,
                transcriptPagination: true,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: true
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
                {
                  mode: "full-access",
                  label: "Full Access",
                  available: true,
                },
              ],
            },
            {
              kind: "acp:grok",
              label: "Grok",
              available: true,
              methods: ["thread/list", "thread/read"],
              capabilities: {
                listThreads: true,
                createThread: true,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: true,
                transcriptPagination: false,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: false
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
              ],
            }
          ]
        }),
        getNavigationSnapshot: async () => ({
          backend: "all",
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: ["codex:thread-1"],
          threads: [
            {
              id: "thread-1",
              title: "Build Codex client",
              titleSource: "explicit",
              summary: "Wire the app-server transport and list threads",
              source: "codex",
              executionMode: "default",
              gitBranch: "codex/build-codex-client",
              linkedDirectories: [
                {
                  id: "/Users/fixture-user/pwrdrvr/PwrAgent",
                  label: "PwrAgent",
                  path: "/Users/fixture-user/pwrdrvr/PwrAgent",
                  worktreePath: "/Users/fixture-user/.codex/worktrees/0f38/PwrAgent",
                  kind: "worktree"
                }
              ],
              inbox: {
                inInbox: true,
                reason: "new-thread"
              },
              updatedAt: Date.now()
            }
          ]
        }),
        markThreadSeen: async () => ({
          backend: "codex",
          threadId: "thread-1",
          seenAt: Date.now()
        }),
        onWindowFocus: () => () => undefined,
        readThread: async () => {
          readThreadCalls += 1;
          if (readThreadCalls === 1) {
            return transcriptResponse;
          }

          return await new Promise((resolve) => {
            resolveRefreshRead = resolve;
          });
        },
        platform: "darwin",
        startTurn,
        interruptTurn,
        onAgentEvent: () => () => undefined,
        versions: {
          electron: "41.2.1"
        }
      }
    });

    render(<App />);

    expect(screen.getByRole("complementary", { name: "Threads" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "Threads" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "inbox" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "Created" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New thread" })).toBeInTheDocument();
    expect(
      await screen.findByRole(
        "heading",
        {
          level: 2,
          name: "Build Codex client"
        },
        { timeout: 5_000 },
      )
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Show selected thread in thread list",
      }),
    );
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
    expect(screen.getAllByText("PwrAgent").length).toBeGreaterThan(0);
    expect(await screen.findByText(".worktrees/pwragent-fix-t...ng-moioth2352")).toBeInTheDocument();
    expect(screen.getByText("codex/fix-thread-naming-ephemeral")).toBeInTheDocument();
    expect(screen.getAllByText("codex/build-codex-client").length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { level: 3, name: "Transcript" })).not.toBeInTheDocument();
    const transcript = screen.getByRole("region", { name: "Transcript" });
    await waitFor(() => {
      expect(transcript).toHaveTextContent("Open the desktop plan and build the Codex client.");
    });
    expect(transcript).toHaveTextContent(
      "The Codex client is wired and the thread browser is live."
    );
    expect(screen.getByText("0 out of 3 tasks completed")).toBeInTheDocument();
    expect(screen.getByText("Render plan card")).toBeInTheDocument();
    expect(screen.getByText("Explored 2 files, ran 1 command")).toBeInTheDocument();
    const context = screen.getByLabelText("Thread context");
    fireEvent.click(within(context).getByRole("tab", { name: "Linked projects" }));
    expect(
      await screen.findByRole("heading", { level: 3, name: "Linked projects" })
    ).toBeInTheDocument();
    fireEvent.click(
      within(context).getByRole("button", { name: "Copy path for PwrAgent" })
    );
    fireEvent.click(
      within(context).getByRole("button", { name: "Copy path for worktree PwrAgent" })
    );
    expect(copyText).toHaveBeenNthCalledWith(1, "/Users/fixture-user/pwrdrvr/PwrAgent");
    expect(copyText).toHaveBeenNthCalledWith(2, "/Users/fixture-user/.codex/worktrees/0f38/PwrAgent");
    expect(screen.getAllByText("Codex app server").length).toBeGreaterThan(0);
    fireEvent.click(within(context).getByRole("tab", { name: "Thread info" }));
    expect(screen.getByText("darwin")).toBeInTheDocument();
    // Provider availability now lives under its own context-rail tab.
    fireEvent.click(within(context).getByRole("tab", { name: "AI provider info" }));
    expect(screen.getByText("Grok")).toBeInTheDocument();
    expect(screen.getByLabelText("Reply")).toBeEnabled();
    expect(
      screen.queryByText("This thread's backend is unavailable right now. You can keep drafting, but send is unavailable.")
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    const reply = screen.getByLabelText("Reply");
    pasteComposerText(reply, "$frontend-design what can this skill do");
    fireEvent.click(reply);

    await clickButton("Send");

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledTimes(1);
    });
    expect(startTurn.mock.calls[0]?.[0]).toMatchObject({
      backend: "codex",
      threadId: "thread-1",
      input: [
        {
          type: "text",
          text: expect.stringContaining("what can this skill do")
        }
      ]
    });
    expect(
      screen.getByText("The Codex client is wired and the thread browser is live.")
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Thinking");
    expect(screen.getByRole("status").querySelector(".thinking-scanner")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(
      screen.queryByText("Thinking", {
        selector: ".composer__meta"
      })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("3 messages")).not.toBeInTheDocument();

    await clickButton("Stop");

    await waitFor(() => {
      expect(interruptTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
      });
    });

    resolveRefreshRead?.(transcriptResponse);
  }, 15_000);

  it("loads launchpad skill autocomplete from the project directory", async () => {
    const listSkills = vi.fn(async () => ({
      backend: "codex" as const,
      fetchedAt: Date.now(),
      data: [
        {
          cwd: "/Users/fixture-user/pwrdrvr/PwrAgent",
          skills: [
            {
              name: "frontend-design",
              description: "Design and verify renderer UI work.",
              path: "/Users/fixture-user/.codex/skills/frontend-design/SKILL.md",
              enabled: true,
              scope: "user",
            },
            {
              name: "desktop-e2e-fixture-seeding",
              description: "Replay-backed desktop E2E fixtures.",
              path: "/Users/fixture-user/pwrdrvr/PwrAgent/.agents/skills/desktop-e2e-fixture-seeding/SKILL.md",
              enabled: true,
              scope: "local",
            },
          ],
        },
      ],
    }));

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        ping: () => "pong",
        listSkills,
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read", "skills/list", "thread/start", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: true,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: false,
                transcriptPagination: true,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: true,
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
                {
                  mode: "full-access",
                  label: "Full Access",
                  available: true,
                },
              ],
            },
          ],
        }),
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: [],
          threads: [],
          directories: [
            {
              key: "directory:/Users/fixture-user/pwrdrvr/PwrAgent",
              kind: "directory" as const,
              label: "PwrAgent",
              path: "/Users/fixture-user/pwrdrvr/PwrAgent",
              threadKeys: [],
              needsAttentionCount: 0,
              gitStatus: {
                currentBranch: "main",
                branches: ["main", "release"],
                syncState: "in-sync" as const,
              },
              launchpad: {
                directoryKey: "directory:/Users/fixture-user/pwrdrvr/PwrAgent",
                directoryKind: "directory" as const,
                directoryLabel: "PwrAgent",
                directoryPath: "/Users/fixture-user/pwrdrvr/PwrAgent",
                backend: "codex" as const,
                executionMode: "default" as const,
                prompt: "",
                workMode: "local" as const,
                branchName: "main",
                createdAt: 1,
                updatedAt: 1,
              },
            },
          ],
          launchpadDefaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        onAgentEvent: () => () => undefined,
        onWindowFocus: () => () => undefined,
        updateDirectoryLaunchpad: async ({
          directoryKey,
          patch,
        }: {
          directoryKey: string;
          patch: Record<string, unknown>;
        }) => ({
          directoryKey,
          launchpad: {
            directoryKey,
            directoryKind: "directory" as const,
            directoryLabel: "PwrAgent",
            directoryPath: "/Users/fixture-user/pwrdrvr/PwrAgent",
            backend: "codex" as const,
            executionMode: "default" as const,
            prompt: typeof patch.prompt === "string" ? patch.prompt : "",
            workMode: "local" as const,
            branchName: "main",
            createdAt: 1,
            updatedAt: 2,
          },
          defaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        versions: {
          electron: "41.2.1",
        },
      },
    });

    render(<App />);

    await screen.findByRole(
      "heading",
      {
        level: 2,
        name: "New thread",
      },
      { timeout: 5_000 },
    );

    pasteComposerText(screen.getByRole("textbox", { name: "New thread" }), "$front");

    await waitFor(() => {
      expect(listSkills).toHaveBeenCalledWith({
        backend: "codex",
        cwd: "/Users/fixture-user/pwrdrvr/PwrAgent",
        cwds: ["/Users/fixture-user/pwrdrvr/PwrAgent"],
      });
    });

    expect(
      await screen.findByRole("option", { name: /\$frontend-design/i }, { timeout: 5_000 })
    ).toBeInTheDocument();
  }, 10_000);

  it("creates and sends on a new Grok thread", async () => {
    let resolveMaterializeLaunchpad: (() => void) | undefined;
    const materializeDirectoryLaunchpad = vi.fn(
      () =>
        new Promise<{
          backend: "acp:grok";
          threadId: string;
          executionMode: "default";
          workMode: "local";
        }>((resolve) => {
          resolveMaterializeLaunchpad = () => {
            resolve({
              backend: "acp:grok" as const,
              threadId: "thread-2",
              executionMode: "default" as const,
              workMode: "local" as const,
            });
          };
        })
    );
    const startTurn = vi.fn(
      async ({
        backend,
        threadId
      }: {
        backend: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend,
        threadId,
        turnId: "turn-1"
      })
    );
    let launchpadState = {
      directoryKey: "workspace:new-thread",
      directoryKind: "workspace" as const,
      directoryLabel: "Workspaces",
      backend: "acp:grok" as const,
      executionMode: "default" as const,
      prompt: "",
      workMode: "local" as const,
      createdAt: 1,
      updatedAt: 1,
    };
    let navigationCallCount = 0;

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        ping: () => "pong",
        listSkills: async () => ({
          backend: "codex",
          fetchedAt: Date.now(),
          data: []
        }),
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read"],
              capabilities: {
                listThreads: true,
                createThread: false,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: false,
                interruptTurn: false,
                steerTurn: false,
                transcriptPagination: true,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: true
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
                {
                  mode: "full-access",
                  label: "Full Access",
                  available: true,
                },
              ],
            },
            {
              kind: "acp:grok",
              label: "Grok",
              available: true,
              methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: true,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: true,
                transcriptPagination: false,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: false
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
              ],
            }
          ]
        }),
        getNavigationSnapshot: async () => {
          navigationCallCount += 1;

          if (navigationCallCount < 2) {
            return {
              backend: "all",
              fetchedAt: Date.now(),
              unchanged: false,
              inboxThreadKeys: ["codex:thread-1"],
              directories: [],
              launchpadDefaults: {
                backend: "acp:grok",
                executionMode: "default",
              },
              threads: [
                {
                  id: "thread-1",
                  title: "Build Codex client",
                  titleSource: "explicit",
                  summary: "Wire the app-server transport and list threads",
                  source: "codex",
                  executionMode: "default",
                  gitBranch: "codex/build-codex-client",
                  linkedDirectories: [],
                  inbox: {
                    inInbox: true,
                    reason: "new-thread"
                  },
                  updatedAt: Date.now()
                }
              ]
            };
          }

          return {
            backend: "all",
            fetchedAt: Date.now(),
            unchanged: false,
            inboxThreadKeys: ["grok:thread-2"],
            directories: [],
            launchpadDefaults: {
              backend: "acp:grok",
              executionMode: "default",
            },
            threads: [
              {
                id: "thread-2",
                title: "Investigate Grok thread",
                titleSource: "explicit",
                summary: "Start a new thread on Grok",
                source: "acp:grok",
                executionMode: "default",
                linkedDirectories: [],
                inbox: {
                  inInbox: true,
                  reason: "new-thread"
                },
                updatedAt: Date.now()
              },
              {
                id: "thread-1",
                title: "Build Codex client",
                titleSource: "explicit",
                summary: "Wire the app-server transport and list threads",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [],
                inbox: {
                  inInbox: false
                },
                updatedAt: Date.now() - 1000
              }
            ]
          };
        },
        markThreadSeen: async ({
          backend,
          threadId
        }: {
          backend: AppServerBackendKind;
          threadId: string;
        }) => ({
          backend,
          threadId,
          seenAt: Date.now()
        }),
        onAgentEvent: () => () => undefined,
        onWindowFocus: () => () => undefined,
        readThread: async ({
          backend,
          threadId
        }: {
          backend: AppServerBackendKind;
          threadId: string;
        }) => {
          const userText =
            backend === "acp:grok"
              ? "Start a Grok-backed thread from the sidebar."
              : "Open the desktop plan and build the Codex client.";
          const assistantText =
            backend === "acp:grok"
              ? "The Grok thread is live and selected."
              : "The Codex client is wired and the thread browser is live.";

          return {
            backend,
            fetchedAt: Date.now(),
            threadId,
            replay: {
              entries: [
                {
                  type: "message",
                  id: "message-1",
                  role: "user",
                  text: userText
                },
                {
                  type: "activity",
                  id: "activity-1",
                  summary: "Explored 2 files, ran 1 command",
                  details: []
                },
                {
                  type: "message",
                  id: "message-2",
                  role: "assistant",
                  text: assistantText
                }
              ],
              messages: [
                {
                  id: "message-1",
                  role: "user",
                  text: userText
                },
                {
                  id: "message-2",
                  role: "assistant",
                  text: assistantText
                }
              ],
              pagination: {
                supportsPagination: false,
                hasPreviousPage: false
              }
            }
          };
        },
        ensureDirectoryLaunchpad: async () => ({
          launchpad: launchpadState,
          defaults: {
            backend: "acp:grok" as const,
            executionMode: "default" as const,
          },
        }),
        updateDirectoryLaunchpad: async ({
          directoryKey,
          patch,
        }: {
          directoryKey: string;
          patch: Record<string, unknown>;
        }) => {
          launchpadState = {
            ...launchpadState,
            ...patch,
            directoryKey,
            updatedAt: launchpadState.updatedAt + 1,
          };

          return {
            launchpad: launchpadState,
            defaults: {
              backend: "acp:grok" as const,
              executionMode: "default" as const,
            },
          };
        },
        materializeDirectoryLaunchpad,
        startTurn,
        platform: "darwin",
        versions: {
          electron: "41.2.1"
        }
      }
    });

    render(<App />);

    await screen.findByRole("heading", {
      level: 2,
      name: "Build Codex client"
    });

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    const newThreadComposer = await screen.findByRole("textbox", { name: "New thread" });
    await act(async () => {
      pasteComposerText(newThreadComposer, "Start a Grok-backed thread from the sidebar.");
    });
    await waitFor(() => {
      expect(getComposerValueHost(newThreadComposer)).toHaveAttribute(
        "data-value",
        "Start a Grok-backed thread from the sidebar.",
      );
    });
    const startThreadButton = screen.getByRole("button", { name: "Start thread" });
    await waitFor(() => {
      expect(startThreadButton).toBeEnabled();
    }, { timeout: 5000 });
    fireEvent.click(startThreadButton);

    expect(
      await screen.findByRole("region", { name: "Preparing transcript" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "New thread" })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith({
        directoryKey: "workspace:new-thread",
        launchpad: expect.objectContaining({
          directoryKey: "workspace:new-thread",
        }),
        input: [
          {
            type: "text",
            text: "Start a Grok-backed thread from the sidebar.",
          },
        ],
      });
    });
    await act(async () => {
      resolveMaterializeLaunchpad?.();
    });
    expect(
      await screen.findByRole("heading", { level: 2, name: "Investigate Grok thread" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Investigate Grok thread" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText(/Grok/).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Transcript" })).toHaveTextContent(
        "The Grok thread is live and selected."
      );
    });

    pasteComposerText(
      await screen.findByLabelText("Reply"),
      "Can you check the plugin sdk boundary?",
    );
    await clickButton("Send");

    expect(startTurn).toHaveBeenCalledWith({
      backend: "acp:grok",
      threadId: "thread-2",
      input: [{ type: "text", text: "Can you check the plugin sdk boundary?" }],
      executionMode: "default",
      collaborationMode: undefined,
      model: undefined,
      reasoningEffort: undefined,
      serviceTier: undefined,
      fastMode: undefined,
    });
  });

  it("opens a directory-less composer on startup when no thread can be selected", async () => {
    const ensureDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: {
        directoryKey: "workspace:new-thread",
        directoryKind: "workspace" as const,
        directoryLabel: "Workspaces",
        backend: "acp:grok" as const,
        executionMode: "default" as const,
        prompt: "",
        workMode: "local" as const,
        createdAt: 1,
        updatedAt: 2,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        readSettings: async () => ({
          snapshot: {
            general: {
              appearance: {
                theme: { value: "system", source: "default" },
                density: { value: "mission-control", source: "default" },
                sidebarTextSize: { value: "md", source: "default" },
                transcriptTextSize: { value: "md", source: "default" },
              },
            },
            onboarding: {
              completed: { value: true, source: "config" },
              completedSource: { value: "migrated", source: "default" },
            },
            imageUploads: {
              pastedImageMaxPatches: { value: 1536, source: "default" },
            },
            experimental: {
              fullAccessRiskWarningDismissed: {
                value: false,
                source: "default",
              },
            },
          } as DesktopSettingsSnapshot,
        }),
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "acp:grok" as const,
              source: "acp" as const,
              label: "Grok",
              available: true,
              methods: ["thread/start", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: true,
                resumeThread: true,
                renameThread: true,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: true,
                transcriptPagination: false,
                toolUse: true,
                approvalRequests: true,
                multiDirectoryThreads: true,
              },
              executionModes: [],
            },
          ],
        }),
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: [],
          threads: [],
          directories: [],
          launchpadDefaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        ensureDirectoryLaunchpad,
        onAgentEvent: () => () => undefined,
      },
    });

    render(<App />);

    expect(
      await screen.findByRole("textbox", { name: "New thread" }),
    ).toBeInTheDocument();
    expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "workspace:new-thread",
      directoryKind: "workspace",
      directoryLabel: "Workspaces",
      directoryPath: undefined,
      preferredBackend: "acp:grok",
    });
    await flushReactUpdates();
    expect(ensureDirectoryLaunchpad).toHaveBeenCalledTimes(1);
  });

  it("keeps the startup thread selection instead of opening the workspace composer", async () => {
    const startupBackends: BackendSummary[] = [
      {
        kind: "codex",
        // `BackendSummary.source` is the discovery channel ("builtin" | "acp"),
        // not the backend kind — and `selectableNewThreadBackends` reads it.
        source: "builtin",
        label: "Codex",
        available: true,
        methods: ["thread/start", "turn/start"],
        capabilities: {
          listThreads: true,
          createThread: true,
          resumeThread: true,
          renameThread: true,
          readThread: true,
          startTurn: true,
          interruptTurn: true,
          steerTurn: true,
          transcriptPagination: true,
          toolUse: true,
          approvalRequests: true,
          multiDirectoryThreads: true,
        },
        executionModes: [
          {
            mode: "default",
            label: "Default Access",
            available: true,
            isDefault: true,
          },
        ],
      },
    ];
    // Pin the precondition this test depends on: the startup landing effect
    // reaches the guard under test only when a backend can create a thread.
    // An unselectable fixture sends it down the onboarding branch instead,
    // where every assertion below passes without exercising the guard.
    expect(resolveNewThreadBackend(startupBackends)).toBeDefined();
    const ensureDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: {
        directoryKey: "workspace:new-thread",
        directoryKind: "workspace" as const,
        directoryLabel: "Workspaces",
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "",
        workMode: "local" as const,
        createdAt: 1,
        updatedAt: 2,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        readSettings: async () => ({
          snapshot: {
            general: {
              appearance: {
                theme: { value: "system", source: "default" },
                density: { value: "mission-control", source: "default" },
                sidebarTextSize: { value: "md", source: "default" },
                transcriptTextSize: { value: "md", source: "default" },
              },
            },
            onboarding: {
              completed: { value: true, source: "config" },
              completedSource: { value: "migrated", source: "default" },
            },
            imageUploads: {
              pastedImageMaxPatches: { value: 1536, source: "default" },
            },
            experimental: {
              fullAccessRiskWarningDismissed: {
                value: false,
                source: "default",
              },
            },
          } as DesktopSettingsSnapshot,
        }),
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: startupBackends,
        }),
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: ["codex:thread-existing"],
          threads: [
            {
              id: "thread-existing",
              title: "Existing thread",
              titleSource: "explicit" as const,
              source: "codex" as const,
              linkedDirectories: [],
              inbox: {
                inInbox: true,
                reason: "new-thread" as const,
              },
              updatedAt: 1,
            },
          ],
          directories: [],
          launchpadDefaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        ensureDirectoryLaunchpad,
        onAgentEvent: () => () => undefined,
      },
    });

    render(<App />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Existing thread" }),
      ).toHaveAttribute("aria-pressed", "true");
    });
    // Three flushes cover the startup landing decision: the backend list
    // resolves, the effect runs, and `ensureDirectoryLaunchpad` would have
    // settled. Measured against the unguarded effect — the launchpad opens
    // inside this window — so the negative assertions below are load-bearing
    // rather than merely early.
    await flushReactUpdates();
    await flushReactUpdates();
    await flushReactUpdates();
    expect(ensureDirectoryLaunchpad).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "New thread" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Existing thread" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("preserves replay fixture navigation instead of opening the startup composer", async () => {
    const ensureDirectoryLaunchpad = vi.fn();

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        replayFixtureActive: true,
        readSettings: async () => ({
          snapshot: {
            general: {
              appearance: {
                theme: { value: "system", source: "default" },
                density: { value: "mission-control", source: "default" },
                sidebarTextSize: { value: "md", source: "default" },
                transcriptTextSize: { value: "md", source: "default" },
              },
            },
            onboarding: {
              completed: { value: true, source: "config" },
              completedSource: { value: "migrated", source: "default" },
            },
            imageUploads: {
              pastedImageMaxPatches: { value: 1536, source: "default" },
            },
            experimental: {
              fullAccessRiskWarningDismissed: {
                value: false,
                source: "default",
              },
            },
          } as DesktopSettingsSnapshot,
        }),
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex" as const,
              source: "codex" as const,
              label: "Codex",
              available: true,
              methods: ["thread/start", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: true,
                resumeThread: true,
                renameThread: true,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: true,
                transcriptPagination: true,
                toolUse: true,
                approvalRequests: true,
                multiDirectoryThreads: true,
              },
              executionModes: [],
            },
          ],
        }),
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: ["codex:thread-replay"],
          threads: [
            {
              id: "thread-replay",
              title: "Existing replay thread",
              titleSource: "explicit" as const,
              source: "codex" as const,
              linkedDirectories: [],
              inbox: {
                inInbox: true,
                reason: "new-thread" as const,
              },
              updatedAt: 1,
            },
          ],
          directories: [],
          launchpadDefaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        ensureDirectoryLaunchpad,
        onAgentEvent: () => () => undefined,
      },
    });

    render(<App />);

    expect(
      await screen.findByRole("button", { name: "Existing replay thread" }),
    ).toBeInTheDocument();
    await flushReactUpdates();
    expect(screen.queryByRole("textbox", { name: "New thread" })).not.toBeInTheDocument();
    expect(ensureDirectoryLaunchpad).not.toHaveBeenCalled();
  });

  it("reopens onboarding on startup when no backend can create a thread", async () => {
    const ensureDirectoryLaunchpad = vi.fn();

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        readSettings: async () => ({
          snapshot: {
            general: {
              appearance: {
                theme: { value: "system", source: "default" },
                density: { value: "mission-control", source: "default" },
                sidebarTextSize: { value: "md", source: "default" },
                transcriptTextSize: { value: "md", source: "default" },
              },
              codexProfileModel: { value: "shared", source: "default" },
            },
            onboarding: {
              completed: { value: true, source: "config" },
              completedSource: { value: "migrated", source: "default" },
            },
            imageUploads: {
              pastedImageMaxPatches: { value: 1536, source: "default" },
            },
            models: {
              codex: {
                path: { value: "", source: "default" },
                profile: { value: "", source: "default" },
                discovery: {
                  selectedCommand: undefined,
                  candidates: [],
                },
                profiles: {
                  profileRoot: "/home/example/.codex/profiles",
                  effectiveCodexHome: "/home/example/.codex",
                  profiles: [],
                },
              },
            },
            experimental: {
              fullAccessRiskWarningDismissed: {
                value: false,
                source: "default",
              },
            },
          } as unknown as DesktopSettingsSnapshot,
        }),
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [],
        }),
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: [],
          threads: [],
          directories: [],
          launchpadDefaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        ensureDirectoryLaunchpad,
        onAgentEvent: () => () => undefined,
      },
    });

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: /A few short choices/i }),
    ).toBeInTheDocument();
    expect(ensureDirectoryLaunchpad).not.toHaveBeenCalled();
  });

  it("routes the new-thread menu push into the existing launchpad flow", async () => {
    let openNewThreadListener: (() => void) | undefined;
    const ensureDirectoryLaunchpad = vi.fn(async () => ({
      launchpad: {
        directoryKey: "workspace:new-thread",
        directoryKind: "workspace" as const,
        directoryLabel: "Workspaces",
        backend: "codex" as const,
        executionMode: "default" as const,
        prompt: "",
        workMode: "local" as const,
        createdAt: 1,
        updatedAt: 2,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        readSettings: async () => ({
          snapshot: {
            general: {
              appearance: {
                theme: { value: "system", source: "default" },
                density: { value: "mission-control", source: "default" },
                sidebarTextSize: { value: "md", source: "default" },
                transcriptTextSize: { value: "md", source: "default" },
              },
            },
            onboarding: {
              completed: { value: true, source: "default" },
            },
            imageUploads: {
              pastedImageMaxPatches: { value: 1536, source: "default" },
            },
            experimental: {
              fullAccessRiskWarningDismissed: {
                value: false,
                source: "default",
              },
            },
          } as DesktopSettingsSnapshot,
        }),
        listBackends: async () => {
          throw new Error("Backend discovery is temporarily unavailable.");
        },
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: [],
          threads: [],
          directories: [],
          launchpadDefaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        ensureDirectoryLaunchpad,
        onAgentEvent: () => () => undefined,
        onOpenNewThreadRequested: (listener: () => void) => {
          openNewThreadListener = listener;
          return () => {
            openNewThreadListener = undefined;
          };
        },
      },
    });

    render(<App />);

    expect(await screen.findByRole("heading", { level: 2, name: "Select a thread" }))
      .toBeInTheDocument();

    await act(async () => {
      openNewThreadListener?.();
      await Promise.resolve();
    });

    expect(ensureDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "workspace:new-thread",
      directoryKind: "workspace",
      directoryLabel: "Workspaces",
      directoryPath: undefined,
      preferredBackend: undefined,
    });
    expect(await screen.findByRole("textbox", { name: "New thread" })).toBeInTheDocument();
  });

  it("copies the selected thread's local diagnostics from the Help menu push", async () => {
    let copyDiagnosticsListener: (() => void) | undefined;
    const copyText = vi.fn(async () => undefined);

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        copyText,
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: ["codex:thread-1"],
          directories: [],
          launchpadDefaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
          threads: [
            {
              id: "thread-1",
              title: "Fix handoff project paths and diagnostics",
              titleSource: "explicit" as const,
              source: "codex" as const,
              executionMode: "default" as const,
              projectKey: "/Users/operator/.codex/worktrees/abc/PwrAgent",
              linkedDirectories: [
                {
                  id: "/Users/operator/pwrdrvr/PwrAgent",
                  label: "PwrAgent",
                  path: "/Users/operator/pwrdrvr/PwrAgent",
                  worktreePath:
                    "/Users/operator/.codex/worktrees/abc/PwrAgent",
                  kind: "worktree" as const,
                },
              ],
              inbox: {
                inInbox: true,
                reason: "new-thread" as const,
              },
              updatedAt: Date.now(),
            },
          ],
        }),
        listBackends: async () => ({ fetchedAt: Date.now(), backends: [] }),
        markThreadSeen: async () => ({
          backend: "codex" as const,
          threadId: "thread-1",
          seenAt: Date.now(),
        }),
        onAgentEvent: () => () => undefined,
        onCopyLocalDiagnosticsInfoRequested: (listener: () => void) => {
          copyDiagnosticsListener = listener;
          return () => {
            copyDiagnosticsListener = undefined;
          };
        },
        readAppMetadata: async () => ({
          applicationName: "PwrAgent",
          applicationVersion: "1.2.3",
          copyright: "Copyright © 2026 PwrDrvr LLC.",
          homepage: "https://pwragent.ai",
          documentationUrl: "https://docs.pwragent.ai",
          electronVersion: "41.2.1",
          chromeVersion: "142.0.0.0",
          nodeVersion: "24.0.0",
          mainProcessId: 4100,
          rendererProcessId: 4101,
          activeProfileName: "work",
          logFilePath:
            "/Users/operator/Library/Logs/PwrAgent/profile-work.main.log",
          codexProfilePath: "/Users/operator/.codex/profiles/work",
        }),
        readThread: async () => ({
          backend: "codex" as const,
          threadId: "thread-1",
          messages: [],
          turns: [],
        }),
      },
    });

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "Fix handoff project paths and diagnostics",
      }),
    ).toBeInTheDocument();
    await waitFor(() => expect(copyDiagnosticsListener).toBeDefined());

    act(() => {
      copyDiagnosticsListener?.();
    });

    await waitFor(() => {
      expect(copyText).toHaveBeenCalledWith([
        "Thread ID: thread-1",
        "Project directory/worktree path: /Users/operator/.codex/worktrees/abc/PwrAgent",
        "Provider/backend: codex",
        "Thread title: Fix handoff project paths and diagnostics",
        "PwrAgent profile: work",
        "Main process PID: 4100",
        "Renderer process PID: 4101",
        "PwrAgent log path: /Users/operator/Library/Logs/PwrAgent/profile-work.main.log",
        "Codex profile path: /Users/operator/.codex/profiles/work",
      ].join("\n"));
    });
  });

  it("registers a remote queued review before navigating away and cleans up event subscriptions", async () => {
    const agentEventListeners = new Set<
      (event: {
        backend: "codex";
        notification: {
          method: string;
          params: Record<string, unknown>;
        };
      }) => void
    >();
    (window as typeof window & {
      __pwragentFederationTarget?: unknown;
    }).__pwragentFederationTarget = {
      scope: "remote",
      instanceId: "remote-gateway",
    };
    const startTurn = vi.fn<
      (request: StartTurnRequest) => Promise<StartTurnResponse>
    >(async (request) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "turn-active",
    }));
    const startReview = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-a",
      reviewThreadId: "thread-a",
      turnId: "turn-review",
    }));
    const createScheduledThreadAction = vi.fn(async (
      request: CreateScheduledThreadActionRequest,
    ) => ({
      action: {
        ...request,
        id: "scheduled-review-1",
        origin: request.origin ?? "desktop",
        status: "queued" as const,
        queueEntryId: "review-1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    }));
    const readThread = vi.fn(
      async ({
        backend,
        threadId
      }: {
        backend: "codex";
        threadId: string;
      }) => ({
        backend,
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false
          }
        }
      })
    );

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        ping: () => "pong",
        listSkills: async () => ({
          backend: "codex",
          fetchedAt: Date.now(),
          data: []
        }),
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read", "turn/start", "review/start"],
              capabilities: {
                listThreads: true,
                createThread: true,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: true,
                startReview: true,
                interruptTurn: true,
                steerTurn: false,
                transcriptPagination: true,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: true
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true
                }
              ]
            }
          ]
        }),
        getNavigationSnapshot: async () => ({
          backend: "all",
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: ["codex:thread-a", "codex:thread-b"],
          directories: [],
          launchpadDefaults: {
            backend: "codex",
            executionMode: "default",
          },
          threads: [
            {
              id: "thread-a",
              title: "Active background thread",
              titleSource: "explicit",
              summary: "Has an active turn with a queued reply",
              source: "codex",
              executionMode: "default",
              linkedDirectories: [],
              inbox: {
                inInbox: true,
                reason: "new-thread"
              },
              updatedAt: Date.now()
            },
            {
              id: "thread-b",
              title: "Focused thread",
              titleSource: "explicit",
              summary: "Selected while the first thread finishes",
              source: "codex",
              executionMode: "default",
              linkedDirectories: [],
              inbox: {
                inInbox: true,
                reason: "new-thread"
              },
              updatedAt: Date.now() - 1000
            }
          ]
        }),
        markThreadSeen: async ({
          backend,
          threadId
        }: {
          backend: "codex";
          threadId: string;
        }) => ({
          backend,
          threadId,
          seenAt: Date.now()
        }),
        onAgentEvent: (
          listener: (event: {
            backend: "codex";
            notification: {
              method: string;
              params: Record<string, unknown>;
            };
          }) => void
        ) => {
          agentEventListeners.add(listener);
          return () => {
            agentEventListeners.delete(listener);
          };
        },
        onWindowFocus: () => () => undefined,
        createScheduledThreadAction,
        readThread,
        startReview,
        startTurn,
        platform: "darwin",
        versions: {
          electron: "41.2.1"
        }
      }
    });

    const { unmount } = render(<App />);

    await screen.findByRole("heading", {
      level: 2,
      name: "Active background thread"
    });
    // A remote viewer adds peer-connectivity ownership to the selected-thread
    // feature subscriptions, legitimately taking the renderer past Node's
    // default EventEmitter warning threshold.
    expect(agentEventListeners.size).toBeGreaterThan(10);

    pasteComposerText(
      await screen.findByRole("textbox", { name: "Reply" }),
      "Start the active turn",
    );
    await clickButton("Send");

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "codex",
          threadId: "thread-a",
          input: [{ type: "text", text: "Start the active turn" }],
        })
      );
    });

    pasteComposerText(
      await screen.findByRole("textbox", { name: "Reply" }),
      "/review main",
    );
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    expect(await screen.findByLabelText("Queued message")).toHaveTextContent(
      "Review changes against main"
    );
    expect(createScheduledThreadAction).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-a",
      kind: "review",
      origin: "desktop",
      scheduledFor: expect.any(Number),
      displayText: "Review changes against main",
      federationTarget: {
        scope: "remote",
        instanceId: "remote-gateway",
      },
      review: {
        target: {
          type: "baseBranch",
          branch: "main",
        },
        draftText: "/review main",
        delivery: "inline",
        cwd: undefined,
        model: undefined,
        reasoningEffort: undefined,
        serviceTier: undefined,
        fastMode: undefined,
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /Focused thread/i }));
    await screen.findByRole("heading", {
      level: 2,
      name: "Focused thread"
    });

    await act(async () => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-a",
              turnId: "turn-active",
              turn: {
                id: "turn-active",
                status: "completed",
                output: [],
              },
            },
          },
        });
      }
    });

    await flushReactUpdates();
    expect(startReview).not.toHaveBeenCalled();
    expect(startTurn).toHaveBeenCalledTimes(1);

    unmount();
    expect(agentEventListeners.size).toBe(0);
  });

  it("keeps assistant response text out of the thread header", async () => {
    const response =
      'I don\'t have a built-in "X Search" tool or direct real-time access to the X/Twitter API with the available workspace tools.';
    const summary = "Grok thread summary";

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        ping: () => "pong",
        listSkills: async () => ({
          backend: "codex",
          fetchedAt: Date.now(),
          data: []
        }),
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "acp:grok",
              label: "Grok",
              available: true,
              methods: ["thread/list", "thread/read", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: true,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: true,
                transcriptPagination: false,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: false
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
              ],
            }
          ]
        }),
        getNavigationSnapshot: async () => ({
          backend: "all",
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: ["grok:thread-1"],
          threads: [
            {
              id: "thread-1",
              title: "Use X Search to find stats on fixtureuser's latest tweets for me",
              titleSource: "explicit",
              summary,
              source: "acp:grok",
              executionMode: "default",
              linkedDirectories: [],
              inbox: {
                inInbox: true,
                reason: "new-thread"
              },
              updatedAt: Date.now()
            }
          ]
        }),
        markThreadSeen: async () => ({
          backend: "acp:grok",
          threadId: "thread-1",
          seenAt: Date.now()
        }),
        onAgentEvent: () => () => undefined,
        onWindowFocus: () => () => undefined,
        readThread: async () => ({
          backend: "acp:grok",
          fetchedAt: Date.now(),
          threadId: "thread-1",
          replay: {
            entries: [
              {
                type: "message",
                id: "message-1",
                role: "user",
                text: "Use X Search to find stats on fixtureuser's latest tweets for me"
              },
              {
                type: "message",
                id: "message-2",
                role: "assistant",
                text: response
              }
            ],
            messages: [
              {
                id: "message-1",
                role: "user",
                text: "Use X Search to find stats on fixtureuser's latest tweets for me"
              },
              {
                id: "message-2",
                role: "assistant",
                text: response
              }
            ],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false
            }
          }
        }),
        platform: "darwin",
        startTurn: async () => ({
          backend: "acp:grok",
          threadId: "thread-1",
          turnId: "turn-1"
        }),
        versions: {
          electron: "41.2.1"
        }
      }
    });

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "Use X Search to find stats on fixtureuser's latest tweets for me"
      })
    ).toBeInTheDocument();

    const transcript = screen.getByRole("region", { name: "Transcript" });
    const header = document.querySelector(".thread-header");
    const main = document.querySelector(".app-main");

    expect(await within(transcript).findByText(response)).toBeInTheDocument();
    expect(header).not.toBeNull();
    expect(main).not.toHaveClass("app-main--thread-detail-pending");
    expect(screen.queryByRole("heading", { level: 2, name: "Loading..." })).toBeNull();
    expect(within(header as HTMLElement).queryByText(response)).not.toBeInTheDocument();
    expect(within(header as HTMLElement).queryByText(summary)).toBeNull();
  });

  it("falls back from loading chrome when a selected thread disappears after refresh", async () => {
    const agentEventListeners = new Set<
      (event: {
        backend: AppServerBackendKind;
        notification: {
          method: string;
          params: Record<string, unknown>;
        };
      }) => void
    >();
    let navigationSnapshot: NavigationSnapshot = {
      backend: "all",
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-stale"],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
      threads: [
        {
          id: "thread-stale",
          title: "Thread that disappears",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread",
          },
          updatedAt: Date.now(),
        },
      ],
    };
    const getNavigationSnapshot = vi.fn(async () => navigationSnapshot);

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        ping: () => "pong",
        listSkills: async () => ({
          backend: "codex",
          fetchedAt: Date.now(),
          data: [],
        }),
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: true,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: true,
                interruptTurn: false,
                steerTurn: false,
                transcriptPagination: false,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: true,
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
              ],
            },
          ],
        }),
        getNavigationSnapshot,
        markThreadSeen: async () => ({
          backend: "codex",
          threadId: "thread-stale",
          seenAt: Date.now(),
        }),
        onAgentEvent: (
          listener: (event: {
            backend: AppServerBackendKind;
            notification: {
              method: string;
              params: Record<string, unknown>;
            };
          }) => void
        ) => {
          agentEventListeners.add(listener);
          return () => {
            agentEventListeners.delete(listener);
          };
        },
        onWindowFocus: () => () => undefined,
        readThread: async () => ({
          backend: "codex",
          fetchedAt: Date.now(),
          threadId: "thread-stale",
          replay: {
            entries: [],
            messages: [],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        }),
        platform: "darwin",
        startTurn: async () => ({
          backend: "codex",
          threadId: "thread-stale",
          turnId: "turn-1",
        }),
        versions: {
          electron: "41.2.1",
        },
      },
    });

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "Thread that disappears",
      })
    ).toBeInTheDocument();

    navigationSnapshot = {
      backend: "all",
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
      threads: [],
    };

    await act(async () => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-stale",
              turnId: "turn-1",
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(getNavigationSnapshot).toHaveBeenCalledTimes(2);
    });
    expect(
      screen.queryByRole("heading", { level: 2, name: "Loading..." })
    ).toBeNull();
    expect(
      screen.getByRole("heading", { level: 2, name: "Pick a Thread" })
    ).toBeInTheDocument();
    expect(document.querySelector(".app-main")).not.toHaveClass(
      "app-main--thread-detail-pending"
    );
  });

  it("keeps a newly created Codex thread selected when thread/list lags behind creation", async () => {
    const materializeDirectoryLaunchpad = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-new",
      executionMode: "default" as const,
      workMode: "local" as const,
    }));
    const agentEventListeners = new Set<
      (event: {
        backend: AppServerBackendKind;
        notification: {
          method: string;
          params: Record<string, unknown>;
        };
      }) => void
    >();
    let navigationSnapshot: NavigationSnapshot = {
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-existing"],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
      threads: [
        {
          id: "thread-existing",
          title: "Existing Codex thread",
          titleSource: "explicit" as const,
          summary: "Already in the list",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const
          },
          updatedAt: Date.now()
        }
      ]
    };
    const startTurn = vi.fn(
      async ({
        backend,
        threadId
      }: {
        backend: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend,
        threadId,
        turnId: "turn-1"
      })
    );

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        ping: () => "pong",
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: true,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: false,
                transcriptPagination: true,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: true
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
                {
                  mode: "full-access",
                  label: "Full Access",
                  available: true,
                },
              ],
            }
          ]
        }),
        getNavigationSnapshot: async () => navigationSnapshot,
        markThreadSeen: async ({
          backend,
          threadId
        }: {
          backend: AppServerBackendKind;
          threadId: string;
        }) => ({
          backend,
          threadId,
          seenAt: Date.now()
        }),
        onAgentEvent: (
          listener: (event: {
            backend: AppServerBackendKind;
            notification: {
              method: string;
              params: Record<string, unknown>;
            };
          }) => void
        ) => {
          agentEventListeners.add(listener);
          return () => {
            agentEventListeners.delete(listener);
          };
        },
        onWindowFocus: () => () => undefined,
        readThread: async ({
          backend,
          threadId
        }: {
          backend: AppServerBackendKind;
          threadId: string;
        }) => ({
          backend,
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [],
            messages: [],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false
            }
          }
        }),
        ensureDirectoryLaunchpad: async () => ({
          launchpad: {
            directoryKey: "workspace:new-thread",
            directoryKind: "workspace" as const,
            directoryLabel: "Workspaces",
            backend: "codex" as const,
            executionMode: "default" as const,
            prompt: "",
            workMode: "local" as const,
            createdAt: 1,
            updatedAt: 1,
          },
          defaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        updateDirectoryLaunchpad: async ({
          directoryKey,
          patch,
        }: {
          directoryKey: string;
          patch: Record<string, unknown>;
        }) => ({
          launchpad: {
            directoryKey,
            directoryKind: "workspace" as const,
            directoryLabel: "Workspaces",
            backend: "codex" as const,
            executionMode: "default" as const,
            prompt: typeof patch.prompt === "string" ? patch.prompt : "",
            workMode: "local" as const,
            createdAt: 1,
            updatedAt: 2,
          },
          defaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        materializeDirectoryLaunchpad,
        startTurn,
        platform: "darwin",
        versions: {
          electron: "41.2.1"
        }
      }
    });

    render(<App />);

    await screen.findByRole("heading", {
      level: 2,
      name: "Existing Codex thread"
    });

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    expect(
      await screen.findByRole("heading", { level: 2, name: "New thread" })
    ).toBeInTheDocument();

    pasteComposerText(
      await screen.findByRole("textbox", { name: "New thread" }),
      "hello new codex thread",
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start thread" })).toBeEnabled();
    });
    await clickButton("Start thread");

    await waitFor(() => {
      expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith({
        directoryKey: "workspace:new-thread",
        launchpad: expect.objectContaining({
          directoryKey: "workspace:new-thread",
        }),
        input: [{ type: "text", text: "hello new codex thread" }]
      });
    });

    pasteComposerText(
      screen.getByLabelText("Reply"),
      "follow up on the new codex thread",
    );
    await clickButton("Send");

    expect(startTurn).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-new",
      input: [{ type: "text", text: "follow up on the new codex thread" }],
      executionMode: "default",
      collaborationMode: undefined,
      model: undefined,
      reasoningEffort: undefined,
      serviceTier: undefined,
      fastMode: undefined
    });

    navigationSnapshot = {
      backend: "all",
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-new"],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
      threads: [
        {
          id: "thread-new",
          title: "hello new codex thread",
          titleSource: "derived",
          summary: undefined,
          source: "codex",
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread"
          },
          updatedAt: Date.now()
        },
        ...navigationSnapshot.threads,
      ]
    };

    await act(async () => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-new",
              turnId: "turn-1",
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 2, name: "hello new codex thread" })
      ).toBeInTheDocument();
    });
  });

  it("applies explicit thread names from thread/name/updated notifications", async () => {
    const materializeDirectoryLaunchpad = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-new",
      executionMode: "default" as const,
      workMode: "local" as const,
      turnId: "turn-1"
    }));
    const agentEventListeners = new Set<
      (event: {
        backend: AppServerBackendKind;
        notification: {
          method: string;
          params: Record<string, unknown>;
        };
      }) => void
    >();
    let navigationSnapshot: NavigationSnapshot = {
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-existing"],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
      threads: [
        {
          id: "thread-existing",
          title: "Existing Codex thread",
          titleSource: "explicit" as const,
          summary: "Already in the list",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const
          },
          updatedAt: Date.now()
        }
      ]
    };
    const startTurn = vi.fn(
      async ({
        backend,
        threadId
      }: {
        backend: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend,
        threadId,
        turnId: "turn-1"
      })
    );

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        ping: () => "pong",
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: true,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: false,
                transcriptPagination: true,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: true
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true
                },
                {
                  mode: "full-access",
                  label: "Full Access",
                  available: true
                }
              ]
            }
          ]
        }),
        getNavigationSnapshot: async () => navigationSnapshot,
        markThreadSeen: async ({
          backend,
          threadId
        }: {
          backend: AppServerBackendKind;
          threadId: string;
        }) => ({
          backend,
          threadId,
          seenAt: Date.now()
        }),
        onAgentEvent: (
          listener: (event: {
            backend: AppServerBackendKind;
            notification: {
              method: string;
              params: Record<string, unknown>;
            };
          }) => void
        ) => {
          agentEventListeners.add(listener);
          return () => {
            agentEventListeners.delete(listener);
          };
        },
        onWindowFocus: () => () => undefined,
        readThread: async ({
          backend,
          threadId
        }: {
          backend: AppServerBackendKind;
          threadId: string;
        }) => ({
          backend,
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [],
            messages: [],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false
            }
          }
        }),
        ensureDirectoryLaunchpad: async () => ({
          launchpad: {
            directoryKey: "workspace:new-thread",
            directoryKind: "workspace" as const,
            directoryLabel: "Workspaces",
            backend: "codex" as const,
            executionMode: "default" as const,
            prompt: "",
            workMode: "local" as const,
            createdAt: 1,
            updatedAt: 1,
          },
          defaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        updateDirectoryLaunchpad: async ({
          directoryKey,
          patch,
        }: {
          directoryKey: string;
          patch: Record<string, unknown>;
        }) => ({
          launchpad: {
            directoryKey,
            directoryKind: "workspace" as const,
            directoryLabel: "Workspaces",
            backend: "codex" as const,
            executionMode: "default" as const,
            prompt: typeof patch.prompt === "string" ? patch.prompt : "",
            workMode: "local" as const,
            createdAt: 1,
            updatedAt: 2,
          },
          defaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        materializeDirectoryLaunchpad,
        startTurn,
        platform: "darwin",
        versions: {
          electron: "41.2.1"
        }
      }
    });

    render(<App />);

    await screen.findByRole("heading", {
      level: 2,
      name: "Existing Codex thread"
    });

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));

    pasteComposerText(
      await screen.findByRole("textbox", { name: "New thread" }),
      "Name this thread something funny and spunky. Something about potatoes.",
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start thread" })).toBeEnabled();
    });
    await clickButton("Start thread");

    await waitFor(() => {
      expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith({
        directoryKey: "workspace:new-thread",
        launchpad: expect.objectContaining({
          directoryKey: "workspace:new-thread",
        }),
        input: [
          {
            type: "text",
            text: "Name this thread something funny and spunky. Something about potatoes."
          }
        ]
      });
    });

    navigationSnapshot = {
      backend: "all",
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-new"],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
      threads: [
        {
          id: "thread-new",
          title: "Name this thread something funny and spunky. Something about potatoes.",
          titleSource: "derived",
          summary: undefined,
          source: "codex",
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread"
          },
          updatedAt: Date.now()
        }
      ]
    };

    await act(async () => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-new",
              turnId: "turn-1",
            },
          },
        });
      }
    });

    await screen.findByRole("heading", {
      level: 2,
      name: "Name this thread something funny and spunky. Something about potatoes."
    });

    await act(async () => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/name/updated",
            params: {
              threadId: "thread-new",
              threadName: "Spud up the thread",
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 2, name: "Spud up the thread" })
      ).toBeInTheDocument();
    });
  });

  it("adds a remote transcript link to this window while its pop-out opens the viewer", async () => {
    const remoteTarget = {
      scope: "remote" as const,
      instanceId: "studio-mac",
    };
    const localThread = {
      id: "thread-local",
      title: "Local planning thread",
      titleSource: "explicit" as const,
      source: "codex" as const,
      linkedDirectories: [],
      inbox: { inInbox: true, reason: "new-thread" as const },
      updatedAt: 2_000,
    };
    const remoteThread = {
      id: "thread-remote",
      title: "M4 Mac Mini runner-host conversion preflight",
      titleSource: "explicit" as const,
      source: "codex" as const,
      linkedDirectories: [],
      inbox: { inInbox: true, reason: "new-thread" as const },
      updatedAt: 1_000,
      federation: {
        ref: {
          backend: "codex" as const,
          target: remoteTarget,
          threadId: "thread-remote",
        },
        instanceLabel: "Studio Mac",
        peerStatus: "connected" as const,
      },
    };
    let remotePinned = false;
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: remotePinned
        ? ["codex:thread-local", "codex:thread-remote"]
        : ["codex:thread-local"],
      threads: remotePinned ? [localThread, remoteThread] : [localThread],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const addRemoteThreadPin = vi.fn(async (request: {
      ref: typeof remoteThread.federation.ref;
    }) => {
      remotePinned = true;
      return {
        pin: {
          ref: request.ref,
          addedAt: Date.now(),
          instanceLabel: "Studio Mac",
        },
      };
    });
    const openFederationWindow = vi.fn(async () => ({ windowId: 2 }));

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        addRemoteThreadPin,
        getNavigationSnapshot,
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read"],
              capabilities: {
                listThreads: true,
                createThread: false,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: false,
                interruptTurn: false,
                steerTurn: false,
                transcriptPagination: false,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: true,
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
              ],
            },
          ],
        }),
        listSkills: async () => ({
          backend: "codex" as const,
          fetchedAt: Date.now(),
          data: [],
        }),
        markThreadSeen: async (request: {
          backend: AppServerBackendKind;
          threadId: string;
        }) => ({ ...request, seenAt: Date.now() }),
        onAgentEvent: () => () => undefined,
        onWindowFocus: () => () => undefined,
        openFederationWindow,
        platform: "darwin",
        readThread: async (request: {
          backend: AppServerBackendKind;
          threadId: string;
        }) => ({
          ...request,
          fetchedAt: Date.now(),
          replay: {
            entries: request.threadId === "thread-local"
              ? [
                  {
                    type: "message" as const,
                    id: "message-link",
                    role: "assistant" as const,
                    text:
                      "Open [runner preflight](pwragent://thread/thread-remote"
                      + "?backend=codex&instanceId=studio-mac"
                      + "&messageId=remote-message-7)",
                  },
                ]
              : [],
            messages: request.threadId === "thread-local"
              ? [
                  {
                    id: "message-link",
                    role: "assistant" as const,
                    text:
                      "Open [runner preflight](pwragent://thread/thread-remote"
                      + "?backend=codex&instanceId=studio-mac"
                      + "&messageId=remote-message-7)",
                  },
                ]
              : [],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        }),
        versions: { electron: "41.2.1" },
      },
    });

    render(<App />);
    await screen.findByRole("heading", { level: 2, name: localThread.title });

    fireEvent.click(screen.getByRole("button", {
      name: "Open remote viewer for studio-mac",
    }));
    expect(openFederationWindow).toHaveBeenCalledWith({
      target: remoteTarget,
      initialThread: {
        backend: "codex",
        messageId: "remote-message-7",
        target: remoteTarget,
        threadId: "thread-remote",
      },
    });
    expect(addRemoteThreadPin).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", {
      name: "Open thread runner preflight",
    }));

    await waitFor(() => expect(addRemoteThreadPin).toHaveBeenCalledWith({
      ref: remoteThread.federation.ref,
      instanceLabel: undefined,
    }));
    expect(openFederationWindow).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("heading", {
      level: 2,
      name: remoteThread.title,
    })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Local planning thread/i }));
    await screen.findByRole("heading", { level: 2, name: localThread.title });
    (window as typeof window & {
      __pwragentFederationTarget?: unknown;
    }).__pwragentFederationTarget = {
      scope: "remote",
      instanceId: "field-mac",
    };
    fireEvent.click(screen.getByRole("button", {
      name: "Open thread M4 Mac Mini runner-host conversion preflight",
    }));

    expect(openFederationWindow).toHaveBeenLastCalledWith({
      target: remoteTarget,
      initialThread: {
        backend: "codex",
        messageId: "remote-message-7",
        target: remoteTarget,
        threadId: "thread-remote",
      },
    });
    expect(openFederationWindow).toHaveBeenCalledTimes(2);
    expect(addRemoteThreadPin).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", {
      level: 2,
      name: localThread.title,
    })).toBeInTheDocument();
  });

  it("reuses cached thread history when reselecting an unchanged thread", async () => {
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend,
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [
            {
              type: "message" as const,
              id: `${threadId}-message-1`,
              role: "assistant" as const,
              text: `Loaded ${threadId}`,
            },
          ],
          messages: [
            {
              id: `${threadId}-message-1`,
              role: "assistant" as const,
              text: `Loaded ${threadId}`,
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        ping: () => "pong",
        listSkills: async () => ({
          backend: "codex" as const,
          fetchedAt: Date.now(),
          data: [],
        }),
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: false,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: false,
                transcriptPagination: true,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: true,
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
                {
                  mode: "full-access",
                  label: "Full Access",
                  available: true,
                },
              ],
            },
          ],
        }),
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: ["codex:thread-1"],
          threads: [
            {
              id: "thread-1",
              title: "First cached thread",
              titleSource: "explicit" as const,
              summary: "Cached first thread",
              source: "codex" as const,
              linkedDirectories: [],
              inbox: {
                inInbox: true,
                reason: "new-thread" as const,
              },
              updatedAt: 1_000,
            },
            {
              id: "thread-2",
              title: "Second cached thread",
              titleSource: "explicit" as const,
              summary: "Cached second thread",
              source: "codex" as const,
              linkedDirectories: [],
              inbox: {
                inInbox: false,
              },
              updatedAt: 2_000,
            },
          ],
        }),
        markThreadSeen: async ({
          backend,
          threadId,
        }: {
          backend: AppServerBackendKind;
          threadId: string;
        }) => ({
          backend,
          threadId,
          seenAt: Date.now(),
        }),
        onAgentEvent: () => () => undefined,
        onWindowFocus: () => () => undefined,
        platform: "darwin",
        readThread,
        versions: {
          electron: "41.2.1",
        },
      },
    });

    render(<App />);

    await screen.findByRole("heading", {
      level: 2,
      name: "First cached thread",
    });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(1);
    });
    expect(readThread).toHaveBeenNthCalledWith(1, {
      backend: "codex",
      limit: 5,
      threadId: "thread-1",
    });

    fireEvent.click(screen.getByRole("button", { name: /Second cached thread/i }));

    await screen.findByRole("heading", {
      level: 2,
      name: "Second cached thread",
    });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    expect(readThread).toHaveBeenNthCalledWith(2, {
      backend: "codex",
      limit: 5,
      threadId: "thread-2",
    });

    fireEvent.click(screen.getByRole("button", { name: /First cached thread/i }));

    await screen.findByRole("heading", {
      level: 2,
      name: "First cached thread",
    });

    expect(readThread).toHaveBeenCalledTimes(2);
  });

  it("walks back and forward across threads and search from the title bar", async () => {
    const searchThreads = vi.fn(async () => ({
      backend: "all" as const,
      contentMode: "available" as const,
      fetchedAt: Date.now(),
      filters: { backend: "all" as const, includeArchived: false },
      query: "history",
      results: [
        {
          backend: "codex" as const,
          confidence: "high" as const,
          identityKey: "codex:thread-1",
          linkedDirectories: [],
          matchReasons: [{ kind: "exact_title" as const }],
          score: 90,
          snippets: [
            {
              scope: "provider_content" as const,
              text: "Opened from search.",
            },
          ],
          source: "codex" as const,
          threadId: "thread-1",
          title: "First cached thread",
        },
      ],
      searchedScopes: ["metadata" as const],
      semanticMode: "disabled" as const,
      unavailableScopes: [],
    }));

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        ping: () => "pong",
        listSkills: async () => ({
          backend: "codex" as const,
          fetchedAt: Date.now(),
          data: [],
        }),
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: false,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: false,
                transcriptPagination: true,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: true,
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
              ],
            },
          ],
        }),
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: ["codex:thread-1"],
          threads: [
            {
              id: "thread-1",
              title: "First cached thread",
              titleSource: "explicit" as const,
              summary: "Cached first thread",
              source: "codex" as const,
              linkedDirectories: [],
              inbox: {
                inInbox: true,
                reason: "new-thread" as const,
              },
              updatedAt: 1_000,
            },
            {
              id: "thread-2",
              title: "Second cached thread",
              titleSource: "explicit" as const,
              summary: "Cached second thread",
              source: "codex" as const,
              linkedDirectories: [],
              inbox: {
                inInbox: false,
              },
              updatedAt: 2_000,
            },
          ],
        }),
        markThreadSeen: async ({
          backend,
          threadId,
        }: {
          backend: AppServerBackendKind;
          threadId: string;
        }) => ({
          backend,
          threadId,
          seenAt: Date.now(),
        }),
        onAgentEvent: () => () => undefined,
        onWindowFocus: () => () => undefined,
        platform: "darwin",
        readThread: async ({
          backend,
          threadId,
        }: {
          backend: AppServerBackendKind;
          threadId: string;
        }) => ({
          backend,
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [],
            messages: [],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        }),
        searchThreads,
        versions: {
          electron: "41.2.1",
        },
      },
    });

    render(<App />);

    await screen.findByRole("heading", {
      level: 2,
      name: "First cached thread",
    });

    // Nowhere to go yet — the auto-selected first thread is the only entry.
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled();

    await clickButton(/Second cached thread/i);
    await screen.findByRole("heading", {
      level: 2,
      name: "Second cached thread",
    });
    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();

    // Search, then open the result (thread 1).
    await clickButton("Search threads");
    fireEvent.change(screen.getByRole("textbox", { name: "Search threads" }), {
      target: { value: "history" },
    });
    await clickButton("Search");
    await screen.findByText("Opened from search.");
    await clickButton(/Opened from search/);
    await screen.findByRole("heading", {
      level: 2,
      name: "First cached thread",
    });

    // Back lands on search with the results still populated — no re-query.
    await clickButton("Back");
    await screen.findByRole("heading", { level: 2, name: "Search" });
    expect(screen.getByText("Opened from search.")).toBeInTheDocument();
    expect(searchThreads).toHaveBeenCalledTimes(1);

    // Back again: the thread we were reading before opening search.
    await clickButton("Back");
    await screen.findByRole("heading", {
      level: 2,
      name: "Second cached thread",
    });

    // Back to the start, where the affordance bottoms out.
    await clickButton("Back");
    await screen.findByRole("heading", {
      level: 2,
      name: "First cached thread",
    });
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Forward" })).toBeEnabled();

    await clickButton("Forward");
    await screen.findByRole("heading", {
      level: 2,
      name: "Second cached thread",
    });

    // The window-level chord (⌘[) and the mouse thumb buttons drive the
    // same history.
    await act(async () => {
      fireEvent.keyDown(window, {
        metaKey: true,
        code: "BracketLeft",
        key: "[",
      });
      await Promise.resolve();
    });
    await screen.findByRole("heading", {
      level: 2,
      name: "First cached thread",
    });

    await act(async () => {
      fireEvent.mouseUp(window, { button: 4 });
      await Promise.resolve();
    });
    await screen.findByRole("heading", {
      level: 2,
      name: "Second cached thread",
    });
  });

  it("restores an unsubmitted project launchpad from thread history", async () => {
    const directoryKey = "directory:/Users/fixture-user/pwrdrvr/PwrAgent";
    let launchpad = {
      directoryKey,
      directoryKind: "directory" as const,
      directoryLabel: "PwrAgent",
      directoryPath: "/Users/fixture-user/pwrdrvr/PwrAgent",
      backend: "codex" as const,
      executionMode: "full-access" as const,
      prompt: "",
      workMode: "worktree" as const,
      branchName: "feature/history-launchpad",
      createdAt: 1,
      updatedAt: 1,
    };
    const ensureDirectoryLaunchpad = vi.fn(
      async ({ directoryKey: ensuredDirectoryKey }: { directoryKey: string }) => {
        launchpad = {
          ...launchpad,
          directoryKey: ensuredDirectoryKey,
        };
        return {
          launchpad,
          defaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        };
      },
    );
    const updateDirectoryLaunchpad = vi.fn(
      async ({
        directoryKey: updatedDirectoryKey,
        patch,
      }: {
        directoryKey: string;
        patch: Record<string, unknown>;
      }) => {
        launchpad = {
          ...launchpad,
          directoryKey: updatedDirectoryKey,
          ...patch,
          updatedAt: launchpad.updatedAt + 1,
        };
        return {
          launchpad,
          defaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        };
      },
    );

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        ping: () => "pong",
        listSkills: async () => ({
          backend: "codex" as const,
          fetchedAt: Date.now(),
          data: [],
        }),
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: true,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: false,
                transcriptPagination: true,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: true,
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
                {
                  mode: "full-access",
                  label: "Full Access",
                  available: true,
                },
              ],
            },
          ],
        }),
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: ["codex:thread-1", "codex:thread-2"],
          threads: [
            {
              id: "thread-1",
              title: "First project thread",
              titleSource: "explicit" as const,
              source: "codex" as const,
              linkedDirectories: [
                {
                  id: "/Users/fixture-user/pwrdrvr/PwrAgent",
                  label: "PwrAgent",
                  path: "/Users/fixture-user/pwrdrvr/PwrAgent",
                  kind: "local" as const,
                },
              ],
              inbox: {
                inInbox: true,
                reason: "new-thread" as const,
              },
              updatedAt: 1_000,
            },
            {
              id: "thread-2",
              title: "Second project thread",
              titleSource: "explicit" as const,
              source: "codex" as const,
              linkedDirectories: [
                {
                  id: "/Users/fixture-user/pwrdrvr/PwrAgent",
                  label: "PwrAgent",
                  path: "/Users/fixture-user/pwrdrvr/PwrAgent",
                  kind: "local" as const,
                },
              ],
              inbox: {
                inInbox: true,
                reason: "new-thread" as const,
              },
              updatedAt: 900,
            },
          ],
          directories: [
            {
              key: directoryKey,
              kind: "directory" as const,
              label: "PwrAgent",
              path: "/Users/fixture-user/pwrdrvr/PwrAgent",
              threadKeys: ["codex:thread-1", "codex:thread-2"],
              needsAttentionCount: 2,
            },
          ],
          launchpadDefaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        markThreadSeen: async ({
          backend,
          threadId,
        }: {
          backend: "codex";
          threadId: string;
        }) => ({
          backend,
          threadId,
          seenAt: Date.now(),
        }),
        onAgentEvent: () => () => undefined,
        onWindowFocus: () => () => undefined,
        readThread: async ({
          backend,
          threadId,
        }: {
          backend: "codex";
          threadId: string;
        }) => ({
          backend,
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [],
            messages: [],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        }),
        ensureDirectoryLaunchpad,
        updateDirectoryLaunchpad,
        platform: "darwin",
        versions: {
          electron: "41.2.1",
        },
      },
    });

    render(<App />);

    await screen.findByRole("heading", {
      level: 2,
      name: "First project thread",
    });
    fireEvent.click(
      screen.getByRole("tab", { name: /^Directories/ }),
    );
    await clickButton("Open new thread launchpad for PwrAgent");
    await screen.findByRole("heading", { level: 2, name: "New thread" });
    expect(
      screen.getByRole("button", { name: "First project thread" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: "Second project thread" }),
    ).toHaveAttribute("aria-pressed", "false");

    const composer = screen.getByRole("textbox", { name: "New thread" });
    pasteComposerText(composer, "Keep this configured project draft.");
    await waitFor(() => {
      expect(getComposerValueHost(composer)).toHaveAttribute(
        "data-value",
        "Keep this configured project draft.",
      );
    });

    await clickButton(/Second project thread/i);
    await screen.findByRole("heading", {
      level: 2,
      name: "Second project thread",
    });
    await clickButton("Back");

    await screen.findByRole("heading", { level: 2, name: "New thread" });
    expect(
      getComposerValueHost(screen.getByRole("textbox", { name: "New thread" })),
    ).toHaveAttribute("data-value", "Keep this configured project draft.");
    expect(screen.getAllByText("Full Access").length).toBeGreaterThan(0);
    expect(ensureDirectoryLaunchpad).toHaveBeenCalledTimes(1);

    await clickButton("Cancel");
    await screen.findByRole("heading", {
      level: 2,
      name: "First project thread",
    });
    expect(
      screen.getByRole("button", { name: "First project thread" }),
    ).toHaveAttribute("aria-pressed", "true");

    // Opening a sub-thread composer from an unselected row must remember that
    // row as its source. Cancel returns there directly instead of consuming
    // history and restoring the unrelated thread that was previously open.
    fireEvent.contextMenu(
      screen.getByRole("button", { name: "Second project thread" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Sub-thread in Local" }),
    );
    await screen.findByRole("heading", { level: 2, name: "New thread" });
    expect(
      screen.getByRole("button", { name: "First project thread" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: "Second project thread" }),
    ).toHaveAttribute("aria-pressed", "false");

    await clickButton("Cancel");
    await screen.findByRole("heading", {
      level: 2,
      name: "Second project thread",
    });
    expect(
      screen.getByRole("button", { name: "Second project thread" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("renames the selected thread from the sidebar actions menu", async () => {
    let threadTitle = "Build Codex client";
    const renameThread = vi.fn(
      async ({ name }: { backend: "codex"; threadId: string; name: string }) => {
        threadTitle = name;
        return {
          backend: "codex" as const,
          threadId: "thread-1",
          renamedAt: Date.now(),
        };
      }
    );
    const readThread = vi.fn(async () => ({
      backend: "codex" as const,
      fetchedAt: Date.now(),
      threadId: "thread-1",
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    }));

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        copyText: async () => undefined,
        ping: () => "pong",
        listSkills: async () => ({
          backend: "codex" as const,
          fetchedAt: Date.now(),
          data: [],
        }),
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex" as const,
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read", "thread/name/set"],
              capabilities: {
                listThreads: true,
                createThread: false,
                resumeThread: true,
                renameThread: true,
                readThread: true,
                startTurn: true,
                interruptTurn: false,
                steerTurn: false,
                transcriptPagination: false,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: true,
              },
              executionModes: [
                {
                  mode: "default" as const,
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
              ],
            },
          ],
        }),
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: ["codex:thread-1"],
          threads: [
            {
              id: "thread-1",
              title: threadTitle,
              titleSource: "explicit" as const,
              summary: "Wire the app-server transport and list threads",
              source: "codex" as const,
              executionMode: "default" as const,
              linkedDirectories: [],
              inbox: {
                inInbox: true,
                reason: "new-thread" as const,
              },
              updatedAt: 2_000,
            },
          ],
          directories: [],
          launchpadDefaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        markThreadSeen: async ({
          backend,
          threadId,
        }: {
          backend: AppServerBackendKind;
          threadId: string;
        }) => ({
          backend,
          threadId,
          seenAt: Date.now(),
        }),
        onAgentEvent: () => () => undefined,
        onWindowFocus: () => () => undefined,
        platform: "darwin",
        readThread,
        renameThread,
      },
    });

    render(<App />);

    await screen.findByRole("heading", {
      level: 2,
      name: "Build Codex client",
    });

    const browseSection = screen.getByRole("region", { name: "Thread browser" });
    fireEvent.click(
      within(browseSection).getByRole("button", { name: "Open thread actions" })
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename Thread" }));

    const dialog = screen.getByRole("dialog", { name: "Rename Thread" });
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Renamed Codex client" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename Thread" }));

    expect(renameThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      name: "Renamed Codex client",
    });
    await screen.findByRole("heading", {
      level: 2,
      name: "Renamed Codex client",
    });
  });
});
