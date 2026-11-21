import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BoatThreadSandbox } from "@pwragent/shared/contracts/mcp-connections";
import { formatBoatSandboxCost, ThreadBoatSandboxes } from "./ThreadBoatSandboxes";

const RUNNING: BoatThreadSandbox = { id: "bx_1", name: "dada-mama", state: "running", type: "small", dollars: 0.4219 };
const STOPPED: BoatThreadSandbox = { id: "bx_2", name: "papa-nana", state: "archived", dollars: 0.004 };

describe("ThreadBoatSandboxes", () => {
  it("shows nothing for a thread without sandboxes", async () => {
    const list = vi.fn(async () => ({ sandboxes: [] }));
    const { container } = render(
      <ThreadBoatSandboxes backend="codex" desktopApi={{ listThreadBoatSandboxes: list }} threadId="t-none" token={0} />,
    );
    await waitFor(() => expect(list).toHaveBeenCalledWith({ backend: "codex", threadId: "t-none" }));
    expect(container.textContent).toBe("");
  });

  it("lists each sandbox with its state and cost, and offers Stop only while it runs", async () => {
    render(
      <ThreadBoatSandboxes
        backend="codex"
        desktopApi={{
          listThreadBoatSandboxes: async () => ({ sandboxes: [RUNNING, STOPPED] }),
          changeThreadBoatSandbox: async () => ({ sandboxes: [] }),
        }}
        threadId="t-list"
        token={0}
      />,
    );
    expect(await screen.findByText("running · small · $0.42 so far")).toBeTruthy();
    expect(screen.getByText("archived · under $0.01 so far")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop dada-mama" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop papa-nana" })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete papa-nana" })).toBeTruthy();
  });

  it("stops at once, and deletes only after a second, explicit press", async () => {
    const change = vi.fn(async (request: { action: string }) => ({
      sandboxes: request.action === "delete" ? [] : [{ ...RUNNING, state: "archiving" }],
    }));
    render(
      <ThreadBoatSandboxes
        backend="codex"
        desktopApi={{
          listThreadBoatSandboxes: async () => ({ sandboxes: [RUNNING] }),
          changeThreadBoatSandbox: change,
        }}
        threadId="t-change"
        token={0}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Delete dada-mama" }));
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(change).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Stop dada-mama" }));
    expect(await screen.findByText("archiving · small · $0.42 so far")).toBeTruthy();
    expect(change).toHaveBeenLastCalledWith({ backend: "codex", threadId: "t-change", sandboxId: "bx_1", action: "stop" });

    fireEvent.click(screen.getByRole("button", { name: "Delete dada-mama" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete dada-mama and its disk" }));
    await waitFor(() => expect(screen.queryByText(/so far/)).toBeNull());
    expect(change).toHaveBeenLastCalledWith({ backend: "codex", threadId: "t-change", sandboxId: "bx_1", action: "delete" });
  });

  it("says why a change failed and keeps the row", async () => {
    render(
      <ThreadBoatSandboxes
        backend="codex"
        desktopApi={{
          listThreadBoatSandboxes: async () => ({ sandboxes: [RUNNING] }),
          changeThreadBoatSandbox: async () => {
            throw new Error("Boat is not reachable.");
          },
        }}
        threadId="t-fail"
        token={0}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Stop dada-mama" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Boat is not reachable.");
    expect(screen.getByText("running · small · $0.42 so far")).toBeTruthy();
  });

  it("formats a cost", () => {
    expect(formatBoatSandboxCost(undefined)).toBeUndefined();
    expect(formatBoatSandboxCost(0)).toBe("$0.00");
    expect(formatBoatSandboxCost(0.004)).toBe("under $0.01");
    expect(formatBoatSandboxCost(12.345)).toBe("$12.35");
  });
});
