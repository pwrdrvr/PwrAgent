import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexUserUpdateState } from "../../../../../shared/codex-user-update";
import { CodexUpdatePill } from "../CodexUpdatePill";

const OFFER: CodexUserUpdateState = {
  offer: {
    installedVersion: "0.172.0",
    latestVersion: "0.173.0",
    installer: "homebrew",
    upgradeCommand: "brew upgrade --cask codex",
    canRunUpdate: true,
  },
};

function setup(initial: CodexUserUpdateState) {
  let push: ((state: CodexUserUpdateState) => void) | undefined;
  const api = {
    copyText: vi.fn(async () => undefined),
    readCodexUserUpdate: vi.fn(async () => initial),
    startCodexUserUpdate: vi.fn(async (): Promise<CodexUserUpdateState> => ({
      ...initial,
      run: {
        id: 1,
        phase: "updating",
        installer: "homebrew",
        fromVersion: "0.172.0",
        targetVersion: "0.173.0",
        startedAt: 1,
        updatedAt: 1,
      },
    })),
    onCodexUserUpdate: vi.fn((callback: (state: CodexUserUpdateState) => void) => {
      push = callback;
      return () => undefined;
    }),
  };
  render(<CodexUpdatePill desktopApi={api} />);
  return { api, push: (state: CodexUserUpdateState) => act(() => push?.(state)) };
}

afterEach(cleanup);

describe("CodexUpdatePill", () => {
  it("runs the update from the sidebar and shows its progress", async () => {
    const { api } = setup(OFFER);
    expect(await screen.findByText("Codex 0.173.0 available")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(await screen.findByText("Updating Codex")).toBeInTheDocument();
    expect(api.startCodexUserUpdate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Dismiss Codex update" })).not.toBeInTheDocument();
    expect(screen.getByTestId("codex-update-pill")).toHaveAttribute("aria-busy", "true");
  });

  it("stays dismissed for the same release", async () => {
    const { push } = setup(OFFER);
    await screen.findByText("Codex 0.173.0 available");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Codex update" }));
    expect(screen.queryByTestId("codex-update-pill")).not.toBeInTheDocument();
    push({ ...OFFER });
    expect(screen.queryByTestId("codex-update-pill")).not.toBeInTheDocument();
  });

  it("shows a start failure in place", async () => {
    const { api } = setup(OFFER);
    api.startCodexUserUpdate.mockRejectedValueOnce(new Error("PwrAgent could not find the tool that installed this Codex."));
    await screen.findByText("Codex 0.173.0 available");
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(await screen.findByText("PwrAgent could not find the tool that installed this Codex.")).toBeInTheDocument();
  });
});
