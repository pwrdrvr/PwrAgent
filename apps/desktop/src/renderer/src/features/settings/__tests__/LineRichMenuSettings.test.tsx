import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LineRichMenuSetupRequest, LineRichMenuSetupResponse } from "@pwragent/shared/contracts/settings";
import { LineRichMenuSettings } from "../LineRichMenuSettings";

const accountId = `U${"a".repeat(32)}`;
const details = { accountId, preview: "data:image/png;base64,", version: "v1", cleanupRequired: false };

describe("LINE rich menu settings", () => {
  it("only checks on open and installs on explicit request for the checked account", async () => {
    const setup = vi.fn(async (request: LineRichMenuSetupRequest): Promise<LineRichMenuSetupResponse> => (
      request.action === "check" ? { kind: "available", ...details }
        : { kind: "installed", revision: "v1", updateAvailable: false, ...details }
    ));
    render(<LineRichMenuSettings configured setup={setup} />);
    const install = await screen.findByRole("button", { name: "Install rich menu" });
    expect(setup.mock.calls).toEqual([[{ action: "check" }]]);
    fireEvent.click(install);
    await screen.findByText("Rich menu installed (v1).");
    expect(setup).toHaveBeenLastCalledWith({ action: "install", accountId });
  });

  it("protects a different default and focuses Keep menu before removing an unused owned menu", async () => {
    const setup = vi.fn(async (): Promise<LineRichMenuSetupResponse> => ({
      ...details, kind: "blocked", reason: "different-menu", cleanupRequired: true,
    }));
    render(<LineRichMenuSettings configured setup={setup} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete unused menu" }));
    const keep = screen.getByRole("button", { name: "Keep menu" });
    await waitFor(() => expect(document.activeElement).toBe(keep));
    expect(screen.queryByRole("button", { name: "Install rich menu" })).toBeNull();
    expect(setup).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove rich menu" }));
    await waitFor(() => expect(setup).toHaveBeenLastCalledWith({ action: "remove", accountId }));
  });

  it("keeps account changes unavailable when LINE cannot be checked", async () => {
    const setup = vi.fn(async (): Promise<LineRichMenuSetupResponse> => ({ kind: "error", reason: "request-failed" }));
    const { rerender } = render(<LineRichMenuSettings configured={false} setup={setup} />);
    expect(setup).not.toHaveBeenCalled();
    rerender(<LineRichMenuSettings configured setup={setup} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn’t verify/);
    expect(screen.queryByRole("button", { name: "Install rich menu" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove rich menu" })).toBeNull();
  });

  it("requires a fresh removal confirmation after the token is cleared and a different account is checked", async () => {
    const nextAccountId = `U${"b".repeat(32)}`;
    const installed = { ...details, kind: "installed", revision: "v1", updateAvailable: false } as const;
    const setup = vi.fn<(request: LineRichMenuSetupRequest) => Promise<LineRichMenuSetupResponse>>()
      .mockResolvedValueOnce(installed)
      .mockResolvedValue({ ...installed, accountId: nextAccountId });
    const { rerender } = render(<LineRichMenuSettings configured setup={setup} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove rich menu" }));
    expect(screen.getByRole("button", { name: "Keep menu" })).toBeTruthy();

    rerender(<LineRichMenuSettings configured={false} setup={setup} />);
    rerender(<LineRichMenuSettings configured setup={setup} />);
    await waitFor(() => expect(setup).toHaveBeenCalledTimes(2));
    await screen.findByText("Rich menu installed (v1).");

    fireEvent.click(screen.getByRole("button", { name: "Remove rich menu" }));
    expect(setup.mock.calls.map(([request]) => request)).toEqual([{ action: "check" }, { action: "check" }]);
    fireEvent.click(screen.getByRole("button", { name: "Remove rich menu" }));
    await waitFor(() => expect(setup).toHaveBeenLastCalledWith({ action: "remove", accountId: nextAccountId }));
  });
});
