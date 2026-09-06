import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FederationActivityTotals, ReadFederationActivityResponse } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { FederationStatusControl } from "./FederationStatusControl";
import { FederationActivityScreen } from "./FederationActivityWindow";

const totals = (): FederationActivityTotals => ({
  sent: { requests: 12, responses: 3, notifications: 9, other: 0, dataBytes: 2_000, wireBytes: 800 },
  received: { requests: 3, responses: 12, notifications: 4, other: 1, dataBytes: 4_000, wireBytes: 1_600 },
});
function fixture(): ReadFederationActivityResponse {
  const series = {
    sizes: {
      sent: { requests: { count: 0 }, responses: { count: 0 } },
      received: { requests: { count: 0 }, responses: { count: 0 } },
    },
    lifetime: totals(), windows: { "1m": totals(), "5m": totals(), "10m": totals(), "1h": totals() },
    history: Array.from({ length: 360 }, (_, index) => ({ at: index * 10_000, totals: totals() })),
  };
  return {
    activity: { since: 0, at: 3_600_000, bucketMs: 1_000, physical: series,
      peers: [{ peerId: "gateway", series }], logical: [{ peerId: "remote", series }] },
    configuredMode: "gateway", running: true,
    health: { enabled: true, role: "gateway", status: "connected", peers: [] },
  };
}
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Federation activity surfaces", () => {
  it("opens on hover without navigating, preserves pointer grace, and clicking still opens Star Map", async () => {
    const onOpen = vi.fn();
    const readFederationActivity = vi.fn(async () => fixture());
    const { container } = render(<FederationStatusControl desktopApi={{ readFederationActivity }} onOpen={onOpen} />);
    expect(readFederationActivity).not.toHaveBeenCalled();
    const root = container.firstElementChild!;
    fireEvent.pointerEnter(root);
    await screen.findByText("Running · connected");
    expect(onOpen).not.toHaveBeenCalled();
    vi.useFakeTimers();
    fireEvent.pointerLeave(root);
    act(() => vi.advanceTimersByTime(100));
    fireEvent.pointerEnter(screen.getByRole("dialog"));
    act(() => vi.advanceTimersByTime(200));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Star Map" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps keyboard focus inside the interactive panel, opens Activity, and dismisses with Escape", async () => {
    const openFederationActivity = vi.fn(async () => {});
    render(<FederationStatusControl desktopApi={{ readFederationActivity: async () => fixture(), openFederationActivity }} onOpen={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Open Star Map" });
    act(() => trigger.focus());
    await screen.findByText("Running · connected");
    const action = screen.getByRole("button", { name: "Open Federation Activity" });
    act(() => action.focus());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(action, { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.pointerEnter(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Open Federation Activity" }));
    await waitFor(() => expect(openFederationActivity).toHaveBeenCalledTimes(1));
  });

  it("shows configured-on separately from a lease-denied runtime and applies toggle results", async () => {
    const denied = fixture();
    denied.running = false;
    denied.health.enabled = false;
    denied.health.leaseHolder = { instanceId: "other-app", processId: 123, cwdHint: "/fixture/other" };
    denied.health.unavailableReason = "This profile is already served by another app.";
    const off = { ...fixture(), configuredMode: "disabled" as const, running: false };
    const setFederationEnabled = vi.fn(async () => off);
    render(<FederationStatusControl desktopApi={{ readFederationActivity: async () => denied, setFederationEnabled }} onOpen={vi.fn()} />);
    fireEvent.focus(screen.getByRole("button", { name: "Open Star Map" }));
    await screen.findByText("Not running · lease held by another instance");
    expect(screen.getByText("Configured on · gateway")).toBeInTheDocument();
    expect(screen.getByText(/Holder: other-app · PID 123/)).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: "Federation enabled" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    await screen.findByText("Configured off");
    expect(setFederationEnabled).toHaveBeenCalledWith(false);
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("labels chart axes with numeric rates and units, exposes periods and per-peer attribution, and confirms topmost", async () => {
    const readFederationActivity = vi.fn(async () => fixture());
    const setFederationActivityTopmost = vi.fn(async (enabled: boolean) => enabled);
    const api: DesktopApi = { readFederationActivity, setFederationActivityTopmost };
    render(<FederationActivityScreen desktopApi={api} />);
    await screen.findByText("Running · connected");
    expect(screen.getByText("0.2")).toBeInTheDocument();
    expect(screen.getByText("2.4")).toBeInTheDocument();
    for (const name of ["Sent traffic", "Received traffic"]) {
      const table = within(screen.getByRole("table", { name }));
      for (const column of ["Last 1m", "Last 10m", "Last 1h", "Total"]) {
        expect(table.getByRole("columnheader", { name: column })).toBeInTheDocument();
      }
    }
    for (const period of ["1m", "10m", "1h"]) {
      fireEvent.change(screen.getByLabelText("Chart window"), { target: { value: period } });
      expect(screen.getByLabelText("Chart window")).toHaveValue(period);
    }
    fireEvent.change(screen.getByLabelText("Attribution"), { target: { value: "logical" } });
    await waitFor(() => expect(readFederationActivity).toHaveBeenLastCalledWith({
      historyPeerId: "remote", historyView: "logical", includeHistory: undefined,
    }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Always on top" }));
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
    expect(setFederationActivityTopmost).toHaveBeenCalledWith(true);
  });

  it("keeps the switch state and reports errors if a configuration change fails", async () => {
    render(<FederationStatusControl desktopApi={{
      readFederationActivity: async () => fixture(),
      setFederationEnabled: async () => { throw new Error("Config is read-only"); },
    }} onOpen={vi.fn()} />);
    fireEvent.focus(screen.getByRole("button", { name: "Open Star Map" }));
    await screen.findByText("Running · connected");
    fireEvent.click(screen.getByRole("switch"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Config is read-only");
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });
  it("shows recent bursts beside lifetime totals regardless of chart range", async () => {
    const snapshot = fixture();
    const series = snapshot.activity.physical;
    series.windows["1m"].received.wireBytes = 50_000_000;
    series.windows["10m"].received.wireBytes = 1_000_000_000;
    series.windows["1h"].received.wireBytes = 2_000_000_000;
    series.lifetime.received.wireBytes = 50_000_000_000;
    render(<FederationActivityScreen desktopApi={{ readFederationActivity: async () => snapshot }} />);
    const table = within(await screen.findByRole("table", { name: "Received traffic" }));
    const row = table.getByRole("row", { name: /Wire · encoded/ });
    expect(within(row).getAllByRole("cell").map((cell) => cell.textContent?.trim()))
      .toEqual(["50 MB", "1 GB", "2 GB", "50 GB"]);
    fireEvent.change(screen.getByLabelText("Chart window"), { target: { value: "1h" } });
    expect(within(row).getAllByRole("cell").map((cell) => cell.textContent?.trim()))
      .toEqual(["50 MB", "1 GB", "2 GB", "50 GB"]);
    expect(within(row).getByText("50 MB")).toHaveAttribute("title", "50,000,000 bytes");
  });

  it("shows lifetime request/response size statistics without time-bucket columns", async () => {
    const snapshot = fixture();
    snapshot.activity.physical.sizes.received.responses = {
      count: 5, averageBytes: 10_000_800, p50Bytes: 1_000, minBytes: 1_000, maxBytes: 50_000_000,
    };
    render(<FederationActivityScreen desktopApi={{ readFederationActivity: async () => snapshot }} />);
    const table = within(await screen.findByRole("table", { name: "Lifetime request/response sizes · uncompressed" }));
    expect(table.getAllByRole("columnheader").map((cell) => cell.textContent))
      .toEqual(["Traffic", "Samples", "Avg", "p50 ≈", "Min", "Max"]);
    expect(within(table.getByRole("row", { name: /Received responses/ })).getAllByRole("cell").map((cell) => cell.textContent))
      .toEqual(["5", "10 MB", "1 KB", "1 KB", "50 MB"]);
    expect(within(table.getByRole("row", { name: /Sent requests/ })).getAllByRole("cell").map((cell) => cell.textContent))
      .toEqual(["0", "—", "—", "—", "—"]);
    fireEvent.change(screen.getByLabelText("Chart window"), { target: { value: "10m" } });
    expect(table.getByText("50 MB")).toBeInTheDocument();
  });

});


describe("Activity report controls", () => {
  it("uses the standard switch and copies the selected peer with recent totals and sizes", async () => {
    const data = fixture();
    data.activity.peers[0].series = structuredClone(data.activity.physical);
    data.activity.peers[0].series.lifetime.sent.requests = 987;
    const copyText = vi.fn(async (_text: string) => {});
    render(<FederationActivityScreen desktopApi={{ readFederationActivity: async () => data, copyText }} />);
    await screen.findByText("Running · connected");
    expect(screen.getByRole("switch")).toHaveClass("settings-switch", "is-on");
    expect(screen.getByRole("switch").querySelector(".settings-switch__thumb")).not.toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Peer" }), { target: { value: "gateway" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy Federation activity" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledTimes(1));
    const text = copyText.mock.calls[0][0];
    expect(text).toContain("Physical connections: gateway");
    expect(text).toContain("Requests\t12\t12\t12\t987");
    expect(text).toContain("2 KB (2000 bytes)");
    expect(text).toContain("Samples\tAvg\tp50 (approx.)\tMin\tMax");
    expect(text).toContain("Since: 1970-01-01T00:00:00.000Z");
    expect(text).toContain("excludes WebSocket framing");
    await screen.findByText("Federation activity copied");
  });

  it("resets immediately and ignores a read that started before reset", async () => {
    const data = fixture();
    const cleared = fixture();
    cleared.activity.since = 12345;
    cleared.activity.physical.lifetime.sent.requests = 0;
    let finishRead!: (value: ReadFederationActivityResponse) => void;
    const readFederationActivity = vi.fn().mockResolvedValueOnce(data)
      .mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
    const resetFederationActivity = vi.fn(async () => cleared);
    render(<FederationActivityScreen desktopApi={{ readFederationActivity, resetFederationActivity }} />);
    await screen.findByText("Running · connected");
    fireEvent.change(screen.getByRole("combobox", { name: "Peer" }), { target: { value: "gateway" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(resetFederationActivity).toHaveBeenCalledOnce());
    await act(async () => finishRead(data));
    fireEvent.change(screen.getByRole("combobox", { name: "Peer" }), { target: { value: "" } });
    const row = within(screen.getByRole("table", { name: "Sent traffic" })).getByRole("row", { name: /^Requests / });
    expect(within(row).getAllByRole("cell").at(-1)).toHaveTextContent("0");
  });

  it("reports reset failures and leaves existing totals intact", async () => {
    render(<FederationActivityScreen desktopApi={{ readFederationActivity: async () => fixture(),
      resetFederationActivity: async () => { throw new Error("Reset failed"); } }} />);
    await screen.findByText("Running · connected");
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Reset failed");
    expect(screen.getByRole("table", { name: "Sent traffic" })).toHaveTextContent("12");
  });
});
