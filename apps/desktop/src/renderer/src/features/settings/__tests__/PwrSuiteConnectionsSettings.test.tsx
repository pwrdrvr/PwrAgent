import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PwrGitConnectionStatus } from "@pwragent/shared";
import { PwrSuiteConnectionsSettings } from "../PwrSuiteConnectionsSettings";

afterEach(cleanup);
const status = (configured = false): PwrGitConnectionStatus => ({
  connectionId: "pwrgit", displayName: "PwrGit", availability: "running", configured,
});

describe("PwrSuite connection ownership", () => {
  it("shows PwrAgent authorization separately and refreshes after connecting", async () => {
    const connectPwrGit = vi.fn(async () => ({ status: status(true), outcome: "connected" as const }));
    render(<PwrSuiteConnectionsSettings desktopApi={{
      readPwrGitConnectionStatus: async () => status(), connectPwrGit,
    }} />);
    expect(await screen.findByText("Not authorized in PwrAgent")).toBeVisible();
    expect(screen.getByText(/Connections registered directly with an agent are separate/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Connect to PwrGit" }));
    expect(await screen.findByText("Authorization saved in PwrAgent")).toBeVisible();
    expect(connectPwrGit).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Reauthorize PwrGit" })).toBeEnabled();
    expect(screen.getByText(/Saved authorization does not verify/)).toBeVisible();
  });

  it("keeps saved authorization visible when the endpoint is unavailable and allows retry", async () => {
    const read = vi.fn(async () => ({ ...status(true), availability: "installed" as const }));
    render(<PwrSuiteConnectionsSettings desktopApi={{ readPwrGitConnectionStatus: read }} />);
    expect(await screen.findByText("Authorization saved in PwrAgent")).toBeVisible();
    expect(screen.getByText("Local MCP endpoint unavailable.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open PwrGit" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh PwrGit connection" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it("reports failed status reads instead of claiming the connection is absent", async () => {
    render(<PwrSuiteConnectionsSettings desktopApi={{
      readPwrGitConnectionStatus: async () => { throw new Error("Secret store unavailable"); },
    }} />);
    expect(await screen.findByText("Secret store unavailable")).toBeVisible();
    expect(screen.queryByText("Not authorized in PwrAgent")).toBeNull();
  });
});
