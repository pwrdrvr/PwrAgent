import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpAgentSettingsEntry } from "@pwragent/shared/contracts/backend";
import type { AntigravitySetupRequest, AntigravitySetupResult } from "../../../../../shared/antigravity-setup";
import type { DesktopApi } from "../../../lib/desktop-api";
import { AntigravitySetup } from "../AntigravitySetup";

const command = `/Users/contrived/.pwragent/agents/antigravity/versions/1.5.15-${"a".repeat(128)}/agy`;

function entry(overrides: Partial<AcpAgentSettingsEntry> = {}): AcpAgentSettingsEntry {
  return {
    backendId: "acp:antigravity",
    registryId: "antigravity",
    name: "Antigravity",
    authors: [],
    distributionKind: "local",
    distributionSource: "antigravity",
    installable: false,
    installed: true,
    installStatus: "installed",
    authStatus: "not-required",
    verificationStatus: "not-applicable",
    enabled: true,
    activeCommand: command,
    version: "1.5.15",
    ...overrides,
  };
}

function setupApi(latestVersion = "1.5.16") {
  let installed = "1.5.15";
  const antigravitySetup = vi.fn(async (request: AntigravitySetupRequest): Promise<AntigravitySetupResult> => {
    const runtime = { status: "installed" as const, runtime: { command, version: installed } };
    switch (request.action) {
      case "read":
        return { ok: true, runtime };
      case "check-update":
        return { ok: true, runtime, release: { latestVersion, checkedAt: Date.now() } };
      case "install":
        installed = latestVersion;
        return { ok: true, runtime: { status: "installed", runtime: { command, version: installed } } };
      default:
        return { ok: true };
    }
  });
  return { antigravitySetup } as unknown as DesktopApi & { antigravitySetup: typeof antigravitySetup };
}

describe("Antigravity Runtime row", () => {
  afterEach(cleanup);
  it("checks Google when the page opens and offers the newer release as the primary action", async () => {
    const desktopApi = setupApi();
    const onChanged = vi.fn();
    render(<AntigravitySetup desktopApi={desktopApi} entry={entry()} onChanged={onChanged}>{null}</AntigravitySetup>);
    const update = await screen.findByRole("button", { name: "Update to 1.5.16" });
    expect(desktopApi.antigravitySetup).toHaveBeenCalledWith({ action: "check-update", force: false });
    expect(screen.getByText(/in use · 1\.5\.16 available from Google · checked just now/)).toBeInTheDocument();
    // Nothing newer would make Reinstall a guess; it waits until there is no update.
    expect(screen.queryByRole("button", { name: "Reinstall" })).not.toBeInTheDocument();

    fireEvent.click(update);
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(await screen.findByText(/in use · up to date/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reinstall" })).toBeInTheDocument();
  });

  it("forces a fresh check from Check for updates", async () => {
    const desktopApi = setupApi("1.5.15");
    render(<AntigravitySetup desktopApi={desktopApi} entry={entry()} onChanged={vi.fn()}>{null}</AntigravitySetup>);
    fireEvent.click(await screen.findByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(desktopApi.antigravitySetup).toHaveBeenCalledWith({ action: "check-update", force: true }));
  });

  it("says when another Antigravity install runs new threads", async () => {
    const desktopApi = setupApi("1.5.15");
    render(
      <AntigravitySetup desktopApi={desktopApi} entry={entry({ activeCommand: "/Users/contrived/.local/bin/agy" })} onChanged={vi.fn()}>
        {null}
      </AntigravitySetup>,
    );
    expect(await screen.findByText(/not in use, another Antigravity install is active · up to date/)).toBeInTheDocument();
  });
});
