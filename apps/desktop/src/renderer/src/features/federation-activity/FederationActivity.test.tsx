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

});
