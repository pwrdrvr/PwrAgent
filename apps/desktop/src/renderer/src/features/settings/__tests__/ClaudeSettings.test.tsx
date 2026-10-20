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
    expect(screen.getByText("Signed in through the CLI")).toBeInTheDocument();
  });

  it("reports a failed check and permits another attempt", async () => {
    render(<ClaudeSettings onCheck={async () => { throw new Error("Fixture failure"); }} />);
    fireEvent.click(screen.getByRole("button", { name: "Check installation and sign-in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Fixture failure");
    expect(screen.getByRole("button", { name: "Check installation and sign-in" })).toBeEnabled();
  });
});
