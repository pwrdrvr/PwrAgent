import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary } from "@pwragent/shared";
import { ClaudeSettings } from "../ClaudeSettings";

afterEach(cleanup);

describe("Claude settings", () => {
  it("offers local installation and CLI login instructions without an OAuth action", async () => {
    const onCheck = vi.fn().mockResolvedValue(undefined);
    render(<ClaudeSettings onCheck={onCheck} />);
    expect(screen.getByText("Not found")).toBeInTheDocument();
    expect(screen.getAllByText(/claude auth login/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /^sign in/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check installation and sign-in" }));
    await waitFor(() => expect(onCheck).toHaveBeenCalledOnce());
  });

  it("shows the installed executable and CLI sign-in result", () => {
    render(<ClaudeSettings onCheck={async () => {}} backend={{
      kind: "claude",
      claude: { executable: "/Users/example/.local/bin/claude", authStatus: "signed-in" },
    } as BackendSummary} />);
    expect(screen.getByText("/Users/example/.local/bin/claude")).toBeInTheDocument();
    expect(screen.getByText("CLI reports signed in; authentication method unavailable")).toBeInTheDocument();
    expect(screen.getByText(/does not verify available credits/)).toBeInTheDocument();
  });

  it("distinguishes API billing from Claude account sign-in", () => {
    render(<ClaudeSettings onCheck={async () => {}} backend={{
      kind: "claude",
      claude: { executable: "/fixture/claude", authStatus: "signed-in", authMethod: "api-key",
        loginCommand: "claude auth login" },
    } as BackendSummary} />);
    expect(screen.getByText("API key configured in the CLI")).toBeInTheDocument();
    expect(screen.getByText(/API billing applies/)).toBeInTheDocument();
    expect(screen.getByText("claude auth login --claudeai")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sign in/i })).not.toBeInTheDocument();
  });

  it("identifies Claude account sign-in without claiming remaining usage", () => {
    render(<ClaudeSettings onCheck={async () => {}} backend={{
      kind: "claude",
      claude: { executable: "/fixture/claude", authStatus: "signed-in", authMethod: "claude-account" },
    } as BackendSummary} />);
    expect(screen.getByText("Signed in with a Claude account")).toBeInTheDocument();
    expect(screen.getByText(/does not verify available credits or remaining usage/)).toBeInTheDocument();
    expect(screen.queryByText(/API billing applies/)).not.toBeInTheDocument();
  });

  it("identifies the bundled runtime and exposes its terminal login command", () => {
    render(<ClaudeSettings onCheck={async () => {}} backend={{
      kind: "claude",
      claude: { executable: "/fixture/PwrAgent/claude", source: "bundled", version: "2.1.296",
        authStatus: "sign-in-required", loginCommand: "'/fixture/PwrAgent/claude' auth login" },
    } as BackendSummary} />);
    expect(screen.getByText("Bundled with PwrAgent · 2.1.296")).toBeInTheDocument();
    expect(screen.getByText("'/fixture/PwrAgent/claude' auth login")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^sign in/i })).not.toBeInTheDocument();
  });

  it("reports a failed check and permits another attempt", async () => {
    render(<ClaudeSettings onCheck={async () => { throw new Error("Fixture failure"); }} />);
    fireEvent.click(screen.getByRole("button", { name: "Check installation and sign-in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Fixture failure");
    expect(screen.getByRole("button", { name: "Check installation and sign-in" })).toBeEnabled();
  });
});
