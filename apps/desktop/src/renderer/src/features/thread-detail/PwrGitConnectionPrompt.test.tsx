import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  PWRGIT_MCP_CONNECTION_ID,
  PWRSNAP_MCP_CONNECTION_ID,
  type PwrGitConnectionStatus,
} from "@pwragent/shared";
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
  it("offers the download when PwrGit is not installed", async () => {
    const openPwrGitDownload = vi.fn(async () => ({ opened: true }));
    render(
      <PwrGitConnectionPrompt
        backend="codex"
        desktopApi={{
          readPwrGitConnectionStatus: async () =>
            status({ availability: "not_installed" }),
          openPwrGitDownload,
        }}
        enabled={false}
        onEnabledChange={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Get PwrGit" }));
    expect(openPwrGitDownload).toHaveBeenCalledOnce();
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

    fireEvent.click(await screen.findByRole("button", { name: "Open PwrGit" }));
    expect(openPwrGit).toHaveBeenCalledOnce();
  });

  it("names the switch to turn on when agent access is off", async () => {
    render(
      <PwrGitConnectionPrompt
        backend="codex"
        desktopApi={{
          readPwrGitConnectionStatus: async () =>
            status({
              agentAccessDisabled: true,
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
});
