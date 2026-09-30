import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  PWRGIT_MCP_CONNECTION_ID,
  PWRSNAP_MCP_CONNECTION_ID,
  type PwrGitConnectionStatus,
} from "@pwragent/shared";
import type { PwrSuiteInstallerState } from "../../../../shared/pwrsuite-installer";
import {
  PwrGitConnectionPrompt,
  pwrGitConnectionIds,
} from "./PwrGitConnectionPrompt";
import { pwrSnapConnectionIds } from "./PwrSnapConnectionPrompt";

function status(
  patch: Partial<PwrGitConnectionStatus> = {},
): PwrGitConnectionStatus {
  return {
    connectionId: PWRGIT_MCP_CONNECTION_ID,
    displayName: "PwrGit",
    availability: "running",
    configured: false,
    ...patch,
  };
}

describe("pwrGitConnectionIds", () => {
  it("adds without dropping another app's connection", () => {
    expect(
      pwrGitConnectionIds([PWRSNAP_MCP_CONNECTION_ID], true),
    ).toEqual([PWRSNAP_MCP_CONNECTION_ID, PWRGIT_MCP_CONNECTION_ID]);
  });

  it("removes only its own id", () => {
    expect(
      pwrGitConnectionIds(
        [PWRSNAP_MCP_CONNECTION_ID, PWRGIT_MCP_CONNECTION_ID],
        false,
      ),
    ).toEqual([PWRSNAP_MCP_CONNECTION_ID]);
  });

  it("does not duplicate an id that is already enabled", () => {
    expect(pwrGitConnectionIds([PWRGIT_MCP_CONNECTION_ID], true)).toEqual([
      PWRGIT_MCP_CONNECTION_ID,
    ]);
  });

  it("is symmetric with the PwrSnap toggle", () => {
    // The bug this guards: a toggle that replaced the array silently turned
    // the other card off.
    const afterPwrGit = pwrGitConnectionIds([PWRSNAP_MCP_CONNECTION_ID], true);
    const afterPwrSnapOff = pwrSnapConnectionIds(afterPwrGit, false);
    expect(afterPwrSnapOff).toEqual([PWRGIT_MCP_CONNECTION_ID]);
  });

  it("handles a thread with no connections yet", () => {
    expect(pwrGitConnectionIds(undefined, true)).toEqual([
      PWRGIT_MCP_CONNECTION_ID,
    ]);
    expect(pwrGitConnectionIds(undefined, false)).toEqual([]);
  });
});

describe("PwrGitConnectionPrompt", () => {
  it("downloads the installer for this machine and follows it to Open installer", async () => {
    let publish!: (state: PwrSuiteInstallerState) => void;
    const offer = {
      platform: "mac" as const,
      version: "0.25.0",
      assetName: "PwrGit-0.25.0-arm64.dmg",
      sizeBytes: 145_015_395,
    };
    const startPwrSuiteDownload = vi.fn(async () => ({
      app: "pwrgit" as const,
      platform: "mac" as const,
      phase: "downloading" as const,
      offer,
      receivedBytes: 0,
      totalBytes: offer.sizeBytes,
    }));
    const openPwrSuiteInstaller = vi.fn(async () => ({ opened: true }));
    render(
      <PwrGitConnectionPrompt
        backend="codex"
        desktopApi={{
          readPwrGitConnectionStatus: async () =>
            status({ availability: "not_installed" }),
          readPwrSuiteInstaller: async (app) => ({
            app,
            platform: "mac",
            phase: "idle",
            offer,
          }),
          onPwrSuiteInstaller: (callback) => {
            publish = callback;
            return () => undefined;
          },
          startPwrSuiteDownload,
          openPwrSuiteInstaller,
        }}
        enabled={false}
        onEnabledChange={vi.fn()}
      />,
    );

    const download = await screen.findByRole("button", {
      name: "Download for Mac 138 MB",
    });
    // The size is hidden while the tiles sit side by side, so the version
    // and size have to reach assistive tech through the tooltip.
    fireEvent.mouseEnter(download);
    const describedBy = download.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      "PwrGit 0.25.0 · 138 MB",
    );
    fireEvent.mouseLeave(download);
    await act(async () => {
      fireEvent.click(download);
    });
    expect(startPwrSuiteDownload).toHaveBeenCalledWith("pwrgit");

    act(() => publish({
      app: "pwrgit",
      platform: "mac",
      phase: "downloading",
      offer,
      receivedBytes: 25_270_190,
      totalBytes: offer.sizeBytes,
      bytesPerSecond: 3_355_443,
    }));
    expect(screen.getByText("Downloading PwrGit 0.25.0")).toBeTruthy();
    expect(
      screen.getByRole("progressbar", { name: "Downloading PwrGit" })
        .getAttribute("aria-valuenow"),
    ).toBe("17");
    expect(screen.getByText("24 MB of 138 MB - 3.2 MB/s")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel PwrGit download" })).toBeTruthy();

    // Another app's events are not this tile's.
    act(() => publish({ app: "pwrsnap", platform: "mac", phase: "failed", error: "x" }));
    expect(screen.getByText("Downloading PwrGit 0.25.0")).toBeTruthy();

    act(() => publish({
      app: "pwrgit",
      platform: "mac",
      phase: "ready",
      offer,
      fileName: offer.assetName,
    }));
    expect(screen.getByText("Installer in Downloads")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show in Finder" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open installer" }));
    });
    expect(openPwrSuiteInstaller).toHaveBeenCalledWith("pwrgit");
  });

  it("names a failed download in a few words and offers to try again", async () => {
    render(
      <PwrGitConnectionPrompt
        backend="codex"
        desktopApi={{
          readPwrGitConnectionStatus: async () =>
            status({ availability: "not_installed" }),
          readPwrSuiteInstaller: async (app) => ({
            app,
            platform: "windows",
            phase: "failed",
            error: "The download didn't verify",
          }),
          onPwrSuiteInstaller: () => () => undefined,
        }}
        enabled={false}
        onEnabledChange={vi.fn()}
      />,
    );

    expect((await screen.findByRole("status")).textContent).toBe(
      "The download didn't verify",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("sends a machine with no installer to the product page", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    try {
      render(
        <PwrGitConnectionPrompt
          backend="codex"
          desktopApi={{
            readPwrGitConnectionStatus: async () =>
              status({ availability: "not_installed" }),
            readPwrSuiteInstaller: async (app) => ({ app, phase: "idle" }),
            onPwrSuiteInstaller: () => () => undefined,
          }}
          enabled={false}
          onEnabledChange={vi.fn()}
        />,
      );

      fireEvent.click(await screen.findByRole("button", { name: "Get PwrGit" }));
      expect(open).toHaveBeenCalledWith(
        "https://pwrgit.com",
        "_blank",
        "noopener,noreferrer",
      );
    } finally {
      open.mockRestore();
    }
  });

  it("keeps the pitch on one line and the rest behind Info", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    try {
      render(
        <PwrGitConnectionPrompt
          backend="codex"
          desktopApi={{ readPwrGitConnectionStatus: async () => status() }}
          enabled={false}
          onEnabledChange={vi.fn()}
        />,
      );

      expect(await screen.findByText("Repo, branch and PR state for agents")).toBeTruthy();
      expect(screen.queryByText(/without the guessing/)).toBeNull();

      const info = screen.getByRole("button", { name: "About PwrGit" });
      fireEvent.click(info);
      const about = screen.getByRole("dialog", { name: "About PwrGit" });
      expect(about.textContent).toContain("Your repositories, without the guessing");
      expect(info.getAttribute("aria-expanded")).toBe("true");

      fireEvent.keyDown(about, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Visit pwrgit.com" }));
      expect(open).toHaveBeenCalledWith(
        "https://pwrgit.com",
        "_blank",
        "noopener,noreferrer",
      );
    } finally {
      open.mockRestore();
    }
  });

  it("offers to open PwrGit when it is installed but not running", async () => {
    const openPwrGit = vi.fn(async () => ({ opened: true }));
    render(
      <PwrGitConnectionPrompt
        backend="codex"
        desktopApi={{
          readPwrGitConnectionStatus: async () =>
            status({ availability: "installed" }),
          openPwrGit,
        }}
        enabled={false}
        onEnabledChange={vi.fn()}
      />,
    );

    const openButton = await screen.findByRole("button", { name: "Open PwrGit" });
    await act(async () => {
      fireEvent.click(openButton);
      await openPwrGit.mock.results[0]?.value;
    });
    expect(openPwrGit).toHaveBeenCalledOnce();
  });

  it("names the switch to turn on when agent access is off", async () => {
    render(
      <PwrGitConnectionPrompt
        backend="codex"
        desktopApi={{
          readPwrGitConnectionStatus: async () =>
            status({
              detail:
                "Turn on Settings → Agents → Local agent access in PwrGit, then connect.",
            }),
        }}
        enabled={false}
        onEnabledChange={vi.fn()}
      />,
    );

    expect(await screen.findByText(/Local agent access/i)).toBeTruthy();
  });

  it("surfaces a declined pairing instead of failing silently", async () => {
    render(
      <PwrGitConnectionPrompt
        backend="codex"
        desktopApi={{
          readPwrGitConnectionStatus: async () => status(),
          connectPwrGit: async () => ({
            status: status(),
            outcome: "declined" as const,
            detail: "The operator declined this request.",
          }),
        }}
        enabled={false}
        onEnabledChange={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Connect to PwrGit" }));
    expect(
      await screen.findByText("The operator declined this request."),
    ).toBeTruthy();
  });

  it("offers a per-thread switch once connected", async () => {
    const onEnabledChange = vi.fn(async () => undefined);
    render(
      <PwrGitConnectionPrompt
        backend="codex"
        desktopApi={{
          readPwrGitConnectionStatus: async () => status({ configured: true }),
        }}
        enabled={false}
        onEnabledChange={onEnabledChange}
      />,
    );

    fireEvent.click(await screen.findByRole("switch", { name: /Use PwrGit in this thread/i }));
    await waitFor(() => expect(onEnabledChange).toHaveBeenCalledWith(true));
  });

  it("offers to open a paired PwrGit when its HTTP endpoint is unavailable", async () => {
    render(
      <PwrGitConnectionPrompt backend="codex"
        desktopApi={{ readPwrGitConnectionStatus: async () => status({ availability: "installed", configured: true }) }}
        enabled={false} onEnabledChange={vi.fn()} />,
    );
    expect(await screen.findByRole("button", { name: "Open PwrGit" })).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("Connected · PwrGit isn’t open")).toBeTruthy();
  });

  it("never shows a failed status read, and retries until one succeeds", async () => {
    // What a dead broker owner produced on the card: Electron's IPC wrapper
    // around a refused temp socket, printed verbatim beside "Checking…".
    const refused = new Error(
      "Error invoking remote method 'mcp-connection:pwrgit-status': "
        + "Error: connect ECONNREFUSED /tmp/pwa-mcp-fixture/bridge.sock",
    );
    const readPwrGitConnectionStatus = vi.fn<() => Promise<PwrGitConnectionStatus>>()
      .mockRejectedValueOnce(refused)
      .mockRejectedValueOnce(refused)
      .mockResolvedValue(status({ availability: "not_installed" }));
    vi.useFakeTimers();
    try {
      render(
        <PwrGitConnectionPrompt
          backend="codex"
          desktopApi={{ readPwrGitConnectionStatus }}
          enabled={false}
          onEnabledChange={vi.fn()}
        />,
      );
      await act(async () => undefined);
      expect(readPwrGitConnectionStatus).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Checking…")).toBeTruthy();
      expect(screen.queryByText(/check right now/)).toBeNull();

      await act(async () => await vi.advanceTimersByTimeAsync(2_000));
      expect(readPwrGitConnectionStatus).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Can’t check right now")).toBeTruthy();

      await act(async () => await vi.advanceTimersByTimeAsync(5_000));
      expect(readPwrGitConnectionStatus).toHaveBeenCalledTimes(3);
      expect(screen.getByRole("button", { name: "Get PwrGit" })).toBeTruthy();
      expect(screen.queryByText(/check right now/)).toBeNull();
      expect(screen.queryByText(/ECONNREFUSED|remote method/)).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a read that started before Connect undo its answer", async () => {
    let answerStaleRead!: (value: PwrGitConnectionStatus) => void;
    const readPwrGitConnectionStatus = vi.fn<() => Promise<PwrGitConnectionStatus>>()
      .mockResolvedValueOnce(status())
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          answerStaleRead = resolve;
        }),
      );
    render(
      <PwrGitConnectionPrompt
        backend="codex"
        desktopApi={{
          readPwrGitConnectionStatus,
          connectPwrGit: async () => ({
            status: status({ configured: true }),
            outcome: "connected" as const,
          }),
        }}
        enabled={false}
        onEnabledChange={vi.fn()}
      />,
    );

    const connect = await screen.findByRole("button", { name: "Connect to PwrGit" });
    // The operator switches to PwrGit to approve and back: a focus re-read
    // starts while the pairing is still waiting.
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {
      fireEvent.click(connect);
    });
    await screen.findByRole("switch", { name: /Use PwrGit in this thread/i });

    await act(async () => answerStaleRead(status()));
    expect(screen.getByRole("switch", { name: /Use PwrGit in this thread/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect to PwrGit" })).toBeNull();
  });

  it("keeps the last status it read when a later read fails", async () => {
    const readPwrGitConnectionStatus = vi.fn<() => Promise<PwrGitConnectionStatus>>()
      .mockResolvedValueOnce(status({ configured: true }))
      .mockRejectedValue(new Error("connect ECONNREFUSED /tmp/bridge.sock"));
    render(
      <PwrGitConnectionPrompt
        backend="codex"
        desktopApi={{ readPwrGitConnectionStatus }}
        enabled={false}
        onEnabledChange={vi.fn()}
      />,
    );
    await screen.findByRole("switch", { name: /Use PwrGit in this thread/i });

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(readPwrGitConnectionStatus).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("switch", { name: /Use PwrGit in this thread/i })).toBeTruthy();
    expect(screen.queryByText(/ECONNREFUSED|could not check/)).toBeNull();
  });

  it("shows an action's failure without Electron's IPC wrapper", async () => {
    render(
      <PwrGitConnectionPrompt
        backend="codex"
        desktopApi={{
          readPwrGitConnectionStatus: async () => status(),
          connectPwrGit: async () => {
            throw new Error(
              "Error invoking remote method 'mcp-connection:pwrgit-connect': "
                + "Error: PwrGit declined the connection.",
            );
          },
        }}
        enabled={false}
        onEnabledChange={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Connect to PwrGit" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "PwrGit declined the connection.",
    );
  });

  it("does not repeat the status instruction as an error after a failed connect", async () => {
    const detail =
      "Turn on Settings → Agents → Local agent access in PwrGit, then connect.";
    render(
      <PwrGitConnectionPrompt
        backend="codex"
        desktopApi={{
          readPwrGitConnectionStatus: async () => status({ detail }),
          connectPwrGit: async () => ({
            status: status({ detail }),
            outcome: "needs_local_agent_access" as const,
          }),
        }}
        enabled={false}
        onEnabledChange={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Connect to PwrGit" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Connect to PwrGit" })).toBeTruthy(),
    );
    expect(screen.getAllByText(detail)).toHaveLength(1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders nothing when a remote owner does not report PwrGit available", async () => {
    const readPwrGitConnectionStatus = vi.fn(async () =>
      status({ availability: "not_installed" }),
    );
    render(
      <PwrGitConnectionPrompt
        backend="codex"
        desktopApi={{ readPwrGitConnectionStatus }}
        enabled={false}
        remoteOwnerLabel="studio"
        onEnabledChange={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(readPwrGitConnectionStatus).toHaveBeenCalledOnce(),
    );
    expect(screen.queryByLabelText(/PwrGit connection/i)).toBeNull();
    // A viewer must never get a pairing button for someone else's machine.
    expect(
      screen.queryByRole("button", { name: /Connect to PwrGit/i }),
    ).toBeNull();
  });

  it("offers only per-thread enablement on an available remote owner", async () => {
    render(
      <PwrGitConnectionPrompt
        backend="codex"
        desktopApi={{
          readPwrGitConnectionStatus: async () => status({ configured: true }),
        }}
        enabled={false}
        remoteOwnerLabel="studio"
        onEnabledChange={vi.fn()}
      />,
    );

    expect(
      await screen.findByRole("switch", {
        name: /Enable PwrGit on studio in this thread/i,
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Connect to PwrGit/i }),
    ).toBeNull();
  });

  // Every PwrSuite brand asset is full-bleed, so no card's icon carries a
  // sizing modifier — the asset fills the box the card reserves on its own.
  // The assets are measured against that box in
  // scripts/pwrsuite-brand-icons.test.mjs.
  it("leaves its icon unscaled", async () => {
    const { container } = render(
      <PwrGitConnectionPrompt
        backend="codex"
        desktopApi={{
          readPwrGitConnectionStatus: async () => status({ configured: true }),
        }}
        enabled={false}
        onEnabledChange={vi.fn()}
      />,
    );

    await screen.findByRole("switch");
    const icon = container.querySelector(".mcp-connection__icon");
    // The exact list, not the absence of one known modifier: any sizing class
    // added here would be compensating for an asset that should be re-sourced.
    expect(icon?.className).toBe("mcp-connection__icon");
  });
});
