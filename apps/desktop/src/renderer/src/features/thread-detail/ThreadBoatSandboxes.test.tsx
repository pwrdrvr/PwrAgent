import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { BoatThreadSandbox } from "@pwragent/shared/contracts/mcp-connections";
import { formatBoatSandboxCost, formatBoatSandboxStopsIn, ThreadBoatSandboxes } from "./ThreadBoatSandboxes";

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
    // The pressed button is gone, and focus is on the one that deletes
    // nothing: a second Enter cannot confirm.
    expect(screen.queryByRole("button", { name: "Delete dada-mama" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep" }));
    const [confirmButton, keepButton] = screen.getAllByRole("button");
    expect([confirmButton?.textContent, keepButton?.textContent]).toEqual(["Delete it", "Keep"]);
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

  it("shows the time left before auto-stop only while the sandbox runs", async () => {
    const now = Date.now();
    render(
      <ThreadBoatSandboxes
        backend="codex"
        desktopApi={{
          listThreadBoatSandboxes: async () => ({
            sandboxes: [
              // 42.5 minutes left reads as 42: never more time than there is.
              { ...RUNNING, stopsAt: now + 42.5 * 60_000 },
              // A stopped sandbox keeps Boat's last deadline; it is not shown.
              { ...STOPPED, stopsAt: now + 30 * 60_000 },
              // A passed deadline may have moved (an agent prompt is running).
              { id: "bx_3", name: "late-box", state: "running", stopsAt: now - 1_000 },
            ],
          }),
        }}
        threadId="t-ttl"
        token={0}
      />,
    );
    expect(await screen.findByText("running · small · $0.42 so far · stops in 42 min")).toBeTruthy();
    expect(screen.getByText("archived · under $0.01 so far")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
  });

  it("lists a sandbox's open tunnels under it and closes one through the thread", async () => {
    const withForwards: BoatThreadSandbox = {
      ...RUNNING,
      forwards: [{ port: 3000, url: "http://127.0.0.1:40000" }, { port: 5432, url: "http://127.0.0.1:40001" }],
    };
    const change = vi.fn(async () => ({ sandboxes: [{ ...RUNNING, forwards: [withForwards.forwards![1]!] }] }));
    render(
      <ThreadBoatSandboxes
        backend="codex"
        desktopApi={{ listThreadBoatSandboxes: async () => ({ sandboxes: [withForwards] }), changeThreadBoatSandbox: change }}
        threadId="t-forward"
        token={0}
      />,
    );
    const tunnels = await screen.findByRole("list", { name: "Port forwards into dada-mama" });
    expect(tunnels.textContent).toContain("http://127.0.0.1:40000");
    expect(tunnels.textContent).toContain("sandbox port 3000");
    fireEvent.click(screen.getByRole("button", { name: "Close the tunnel to port 3000 of dada-mama" }));
    await waitFor(() => expect(screen.queryByText("http://127.0.0.1:40000")).toBeNull());
    expect(change).toHaveBeenCalledWith({
      backend: "codex", threadId: "t-forward", sandboxId: "bx_1", action: "close_forward", port: 3000,
    });
    expect(screen.getByText("http://127.0.0.1:40001")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop dada-mama" })).toBeTruthy();
  });

  it("never states more time left than the deadline allows, nor any for a passed one", () => {
    const now = Date.UTC(2026, 10, 21, 12);
    const claimedMs = (text: string): number => {
      if (text === "stops in under a minute") return 0;
      const days = /^stops in (\d+) days$/.exec(text);
      if (days) return Number(days[1]) * 86_400_000;
      const parts = /^stops in (?:(\d+) h)? ?(?:(\d+) min)?$/.exec(text);
      if (!parts) throw new Error(`unexpected: ${text}`);
      return (Number(parts[1] ?? 0) * 60 + Number(parts[2] ?? 0)) * 60_000;
    };
    fc.assert(fc.property(fc.integer({ min: -86_400_000, max: 30 * 86_400_000 }), (left) => {
      const text = formatBoatSandboxStopsIn(now + left, now);
      if (left <= 0) return text === undefined;
      if (text === undefined) return false;
      const claimed = claimedMs(text);
      // At most what is left, and within the unit it is rounded to.
      const unit = left >= 48 * 3_600_000 ? 86_400_000 : 60_000;
      return claimed <= left && left - claimed < unit;
    }));
    expect(formatBoatSandboxStopsIn(undefined, now)).toBeUndefined();
    expect(formatBoatSandboxStopsIn(now + 90 * 60_000, now)).toBe("stops in 1 h 30 min");
    expect(formatBoatSandboxStopsIn(now + 2 * 3_600_000, now)).toBe("stops in 2 h");
  });

  it("formats a cost", () => {
    expect(formatBoatSandboxCost(undefined)).toBeUndefined();
    expect(formatBoatSandboxCost(0)).toBe("$0.00");
    expect(formatBoatSandboxCost(0.004)).toBe("under $0.01");
    expect(formatBoatSandboxCost(12.345)).toBe("$12.35");
  });
});
