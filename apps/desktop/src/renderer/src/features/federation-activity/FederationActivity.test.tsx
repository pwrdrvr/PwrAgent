import { FederationCaptureTag } from "./FederationTrafficCapture";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FederationActivityTotals, ReadFederationActivityResponse } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { FederationConnections } from "./FederationConnections";
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
    history: Array.from({ length: 3600 }, (_, index) => ({ at: index * 1_000, totals: totals() })),
  };
  return {
    activity: { since: 0, at: 3_600_000, bucketMs: 1_000, physical: series,
      peers: [{ peerId: "gateway", series }], logical: [{ peerId: "remote", series }] },
    configuredMode: "gateway", running: true,
    health: { enabled: true, role: "gateway", status: "connected", peers: [] },
  };
}
afterEach(() => { cleanup(); vi.useRealTimers(); });
/** Presses one button of a labelled group: a segmented control or the peer chips. */
const choose = (group: string, name: string | RegExp) =>
  fireEvent.click(within(screen.getByRole("group", { name: group })).getByRole("button", { name }));
const activityAction = async (name: string, role: "menuitem" | "menuitemcheckbox" = "menuitem") => {
  fireEvent.click(screen.getByRole("button", { name: "More Federation Activity actions" }));
  fireEvent.click(await screen.findByRole(role, { name }));
};

describe("Federation activity surfaces", () => {
  it("shows the viewer instance ID only in a tooltip and copies it", async () => {
    const snapshot = fixture();
    snapshot.health.instanceId = "pwr_viewer";
    const copyText = vi.fn(async () => {});
    render(<FederationStatusControl
      desktopApi={{ readFederationActivity: async () => snapshot, copyText }}
      onOpen={vi.fn()}
    />);
    fireEvent.focus(screen.getByRole("button", { name: "Open Star Map" }));
    const copy = await screen.findByRole("button", { name: "Copy Federation instance ID" });
    expect(screen.queryByText(/pwr_viewer/)).not.toBeInTheDocument();
    fireEvent.focus(copy);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Instance ID: pwr_viewer");
    fireEvent.click(copy);
    await waitFor(() => expect(copyText).toHaveBeenCalledWith("pwr_viewer"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Copied instance ID");
    fireEvent.blur(copy);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it.each(["popup", "activity"])("starts and stops detailed capture in the %s", async (surface) => {
    const snapshot = fixture();
    const setFederationTrafficCapture = vi.fn(async (enabled: boolean) => {
      snapshot.detailedLoggingUntil = enabled ? Date.now() + 60_000 : undefined;
      return structuredClone(snapshot);
    });
    const desktopApi = { readFederationActivity: async () => structuredClone(snapshot), setFederationTrafficCapture };
    render(surface === "popup"
      ? <FederationStatusControl desktopApi={desktopApi} onOpen={vi.fn()} />
      : <FederationActivityScreen desktopApi={desktopApi} />);
    if (surface === "popup") fireEvent.focus(screen.getByRole("button", { name: "Open Star Map" }));
    fireEvent.click(await screen.findByRole("button",
      { name: surface === "popup" ? "More Federation actions" : "More Federation Activity actions" }));
    const checkbox = await screen.findByRole("menuitemcheckbox", { name: "Capture previous + next 60 seconds" });
    await waitFor(() => expect(checkbox).toBeEnabled());
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());
    expect(setFederationTrafficCapture).toHaveBeenLastCalledWith(true);
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).not.toBeChecked());
    expect(setFederationTrafficCapture).toHaveBeenLastCalledWith(false);
  });

  it("counts a capture down in the REC tag and drops the tag when it expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    render(<FederationCaptureTag until={61_000} />);
    expect(screen.getByText("REC · 60s")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(59_000); });
    expect(screen.getByText("REC · 1s")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.queryByText(/^REC/)).not.toBeInTheDocument();
  });

  it("does not present stopped or lease-denied connections as active", () => {
    const health = fixture().health;
    health.role = "dual";
    health.activeConnections = [{ peerId: "gateway", direction: "outgoing", endpoint: "ssh://gateway.example.test" }];
    const { rerender } = render(<FederationConnections health={health} />);
    expect(screen.getByText("ssh://gateway.example.test")).toBeInTheDocument();
    rerender(<FederationConnections health={{ ...health, enabled: false }} />);
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    rerender(<FederationConnections health={{ ...health, leaseHolder: { instanceId: "other" } }} />);
    expect(screen.queryByText("ssh://gateway.example.test")).not.toBeInTheDocument();
    rerender(<FederationConnections health={{ ...health, role: "gateway" }} />);
    expect(screen.getByText("ssh://gateway.example.test")).toBeInTheDocument();
  });

  it.each(["gateway", "dual"] as const)("lists physical connections for a %s without relayed peers or advertised endpoints", (role) => {
    const health = fixture().health;
    health.role = role;
    health.peers = [
      { id: "client", label: "Laptop", role: "client", status: "connected", capabilities: [], endpoint: "ws://old.example.test" },
      { id: "relayed", label: "Relayed workstation", role: "client", status: "connected", capabilities: [] },
    ];
    health.activeConnections = [
      { peerId: "client", direction: "incoming", remoteAddress: "192.168.1.20:54321", localAddress: "192.168.1.10:47830" },
      { peerId: "second", direction: "incoming", remoteAddress: "[fd00::2]:54322", localAddress: "[fd00::1]:47830" },
      ...(role === "dual" ? [{ peerId: "upstream", direction: "outgoing" as const, endpoint: "ssh://upstream.example.test" }] : []),
    ];
    const { rerender } = render(<FederationConnections health={health} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(role === "dual" ? 3 : 2);
    expect(screen.getByText("Laptop")).toBeInTheDocument();
    expect(screen.getByText("192.168.1.20:54321")).toBeInTheDocument();
    expect(screen.getByText("[fd00::1]:47830")).toBeInTheDocument();
    expect(screen.queryByText("Relayed workstation")).not.toBeInTheDocument();
    expect(screen.queryByText("ws://old.example.test")).not.toBeInTheDocument();
    rerender(<FederationConnections health={{ ...health, activeConnections: [] }} />);
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
  });

  it("says a tunnelled peer came through Cloudflare, not from this computer", () => {
    const health = fixture().health;
    health.role = "gateway";
    health.peers = [{ id: "client", label: "Travel laptop", role: "client", status: "connected", capabilities: [] }];
    health.activeConnections = [{ peerId: "client", direction: "incoming", remoteAddress: "127.0.0.1:61876",
      localAddress: "127.0.0.1:47831", via: "cloudflare-tunnel", reportedClientAddress: "203.0.113.7" }];
    render(<FederationConnections health={health} />);
    // The remote socket is this computer's own cloudflared, which read as a local peer.
    expect(screen.getByText(/Incoming · via Cloudflare Tunnel/)).toBeInTheDocument();
    expect(screen.getByText("203.0.113.7")).toBeInTheDocument();
    expect(screen.queryByText("127.0.0.1:61876")).not.toBeInTheDocument();
    expect(screen.queryByText(/incoming tunnels or proxies may appear as the remote/)).not.toBeInTheDocument();
  });

  it("folds the Activity window's connection list behind a count so it cannot push the charts down", () => {
    const health = fixture().health;
    health.role = "gateway";
    health.peers = [{ id: "client", label: "Laptop", role: "client", status: "connected", capabilities: [] }];
    health.activeConnections = [
      { peerId: "client", direction: "incoming", remoteAddress: "192.168.1.20:54321", localAddress: "192.168.1.10:47830" },
    ];
    const { container, rerender } = render(<FederationConnections health={health} collapsible />);
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(details?.querySelector("summary")).toHaveTextContent("Active connections · 1");
    expect(screen.getByText("192.168.1.20:54321")).toBeInTheDocument();
    rerender(<FederationConnections health={{ ...health, activeConnections: [] }} collapsible />);
    expect(container.querySelector("summary")).toHaveTextContent("Active connections · Not connected");
    expect(screen.getAllByText("Not connected")).toHaveLength(1);
  });

  it.each(["popup", "activity"])("shows the actual gateway and follows reconnects in the %s", async (surface) => {
    const snapshot = fixture();
    snapshot.configuredMode = "client";
    snapshot.health.role = "client";
    snapshot.health.gatewayEndpoints = [
      { url: "ws://192.168.1.20:47830", state: "idle" },
      { url: "ws://gateway.example.ts.net:47830", state: "active" },
    ];
    snapshot.health.activeConnections = [{ peerId: "gateway", direction: "outgoing", endpoint: snapshot.health.gatewayEndpoints[1].url }];
    const desktopApi = { readFederationActivity: async () => structuredClone(snapshot) };
    render(surface === "popup"
      ? <FederationStatusControl desktopApi={desktopApi} onOpen={vi.fn()} />
      : <FederationActivityScreen desktopApi={desktopApi} />);
    if (surface === "popup") fireEvent.focus(screen.getByRole("button", { name: "Open Star Map" }));
    await screen.findByText("ws://gateway.example.ts.net:47830");
    expect(screen.queryByText("ws://192.168.1.20:47830")).not.toBeInTheDocument();
    snapshot.health.activeConnections = [];
    snapshot.health.gatewayEndpoints[1].state = "idle";
    snapshot.health.status = "connecting";
    await screen.findByText("Not connected", {}, { timeout: 3_000 });
    expect(screen.queryByText("ws://gateway.example.ts.net:47830")).not.toBeInTheDocument();
    snapshot.health.activeConnections = [{ peerId: "gateway", direction: "outgoing", endpoint: snapshot.health.gatewayEndpoints[0].url }];
    snapshot.health.gatewayEndpoints[0].state = "active";
    snapshot.health.status = "connected";
    await screen.findByText("ws://192.168.1.20:47830", {}, { timeout: 3_000 });
  });

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
    const setFederationEnabled = vi.fn(async () => denied);
    render(<FederationStatusControl desktopApi={{ readFederationActivity: async () => denied, setFederationEnabled }} onOpen={vi.fn()} />);
    fireEvent.focus(screen.getByRole("button", { name: "Open Star Map" }));
    await screen.findByText("Not running · lease held by another instance");
    expect(screen.getByText("Configured on · gateway")).toBeInTheDocument();
    expect(screen.getByText(/runs in another PwrAgent window \(PID 123, \/fixture\/other\)/)).toBeInTheDocument();
    const toggle = screen.getByRole("switch", { name: "Federation enabled" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    await waitFor(() => expect(setFederationEnabled).toHaveBeenCalledWith(true));
    expect(screen.getByText("Configured on · gateway")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it.each(["popup", "activity"])("turns off only the runtime in the %s while preserving configured-on", async (surface) => {
    const off = { ...fixture(), running: false, health: { ...fixture().health, enabled: false } };
    const setFederationEnabled = vi.fn(async () => off);
    const desktopApi = { readFederationActivity: async () => fixture(), setFederationEnabled };
    render(surface === "popup"
      ? <FederationStatusControl desktopApi={desktopApi} onOpen={vi.fn()} />
      : <FederationActivityScreen desktopApi={desktopApi} />);
    if (surface === "popup") fireEvent.focus(screen.getByRole("button", { name: "Open Star Map" }));
    await screen.findByText("Running · connected");
    fireEvent.click(screen.getByRole("switch", { name: "Federation enabled" }));
    await screen.findByText("Stopped");
    expect(setFederationEnabled).toHaveBeenCalledWith(false);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Configured on · gateway")).toBeInTheDocument();
  });

  it("sends a stop while a client connection attempt is running", async () => {
    const connecting = fixture();
    connecting.health.status = "connecting";
    const setFederationEnabled = vi.fn(async () => ({ ...connecting, running: false }));
    render(<FederationActivityScreen desktopApi={{ readFederationActivity: async () => connecting, setFederationEnabled }} />);
    await screen.findByText("Running · connecting");
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(setFederationEnabled).toHaveBeenCalledWith(false));
  });

  it("labels chart axes with amounts and units, exposes periods and per-peer attribution, and confirms topmost", async () => {
    const readFederationActivity = vi.fn(async () => fixture());
    const setFederationActivityTopmost = vi.fn(async (enabled: boolean) => enabled);
    const api: DesktopApi = { readFederationActivity, setFederationActivityTopmost };
    render(<FederationActivityScreen desktopApi={api} />);
    await screen.findByText("Running · connected");
    // Mirrored axes: the peak above, zero on the axis, the same peak below.
    const axes = [...document.querySelectorAll(".federation-activity__chart-axis")]
      .map((axis) => [...axis.querySelectorAll("text")].map((text) => text.textContent));
    expect(axes).toEqual([["KB", "1.6", "0", "1.6"], ["envelopes", "24", "0", "24"]]);
    const minute = document.querySelector<HTMLElement>(".federation-activity__minute")!;
    expect(within(minute).getAllByRole("definition").map((value) => value.textContent))
      .toEqual(["1 KB", "2 KB", "15", "15"]);
    for (const name of ["Sent traffic", "Received traffic"]) {
      const table = within(screen.getByRole("table", { name }));
      for (const column of ["Last 1m", "Last 10m", "Last 1h", "Total"]) {
        expect(table.getByRole("columnheader", { name: column })).toBeInTheDocument();
      }
    }
    for (const period of ["1m", "10m", "1h"]) {
      choose("Chart window", period);
      expect(screen.getByRole("button", { name: period })).toHaveAttribute("aria-pressed", "true");
    }
    choose("Attribution", "Endpoints");
    await waitFor(() => expect(readFederationActivity).toHaveBeenLastCalledWith({
      historyPeerId: "remote", historyView: "logical", includeHistory: undefined,
    }));
    // Endpoints has no aggregate, so the filter offers no All chip there.
    expect(within(screen.getByRole("group", { name: "Peer" })).getAllByRole("button").map((chip) => chip.textContent))
      .toEqual(["remote"]);
    expect(screen.getByRole("button", { name: "remote" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Always on top" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Always on top" })).toHaveAttribute("aria-pressed", "true"));
    expect(setFederationActivityTopmost).toHaveBeenCalledWith(true);
  });

  it("keeps numeric axes outside scrolling history in longer windows", async () => {
    render(<FederationActivityScreen desktopApi={{ readFederationActivity: async () => fixture() }} />);
    await screen.findByRole("img", { name: /Wire byte amounts/ });
    for (const period of ["10m", "1h"]) {
      choose("Chart window", period);
      for (const plot of screen.getAllByRole("img")) {
        const scroller = plot.parentElement!;
        const axis = scroller.parentElement!.querySelector(".federation-activity__chart-axis")!;
        expect(axis).toHaveTextContent("0");
        expect(axis.querySelectorAll("text")).toHaveLength(4);
        expect(scroller).not.toContainElement(axis as HTMLElement);
      }
    }
  });

  it("shows exact one-second amounts on hover and keyboard focus", async () => {
    let resolveActivity!: (snapshot: ReadFederationActivityResponse) => void;
    const activity = new Promise<ReadFederationActivityResponse>((resolve) => { resolveActivity = resolve; });
    render(<FederationActivityScreen desktopApi={{ readFederationActivity: () => activity }} />);
    expect(screen.queryByRole("img", { name: /Wire byte amounts/ })).not.toBeInTheDocument();
    // Flush the async mount and its initial selection-reset effect before focusing.
    // Finding the SVG alone can race that effect on a busy runner.
    await act(async () => { resolveActivity(fixture()); });
    const chart = screen.getByRole("img", { name: /Wire byte amounts/ });
    fireEvent.focus(chart);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Sent wire: 800 bytes");
    expect(screen.getByRole("tooltip")).toHaveTextContent("In progress");
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("In progress");
    fireEvent.keyDown(chart, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    vi.spyOn(chart, "getBoundingClientRect").mockReturnValue({ left: 0, width: 640 } as DOMRect);
    fireEvent.pointerMove(chart, { clientX: 100 });
    expect(screen.getByRole("tooltip")).toHaveTextContent("Received wire: 1,600 bytes");
    fireEvent.pointerLeave(chart);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("keeps the switch state and reports errors if a runtime toggle fails", async () => {
    render(<FederationStatusControl desktopApi={{
      readFederationActivity: async () => fixture(),
      setFederationEnabled: async () => { throw new Error("Startup failed"); },
    }} onOpen={vi.fn()} />);
    fireEvent.focus(screen.getByRole("button", { name: "Open Star Map" }));
    await screen.findByText("Running · connected");
    fireEvent.click(screen.getByRole("switch"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Startup failed");
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
    choose("Chart window", "1h");
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
    choose("Chart window", "10m");
    expect(table.getByText("50 MB")).toBeInTheDocument();
  });

});


describe("Activity report controls", () => {
  it("uses the standard switch and copies the selected peer with recent totals and sizes", async () => {
    const data = fixture();
    data.activity.peers[0].series = structuredClone(data.activity.physical);
    data.activity.peers[0].series.lifetime.sent.requests = 987;
    data.activity.peers[0].series.sizes.sent.requests = {
      count: 33, averageBytes: 543.6363636363636, p50Bytes: 540.4903313206053,
      minBytes: 403, maxBytes: 655,
    };
    const copyText = vi.fn(async (_text: string) => {});
    render(<FederationActivityScreen desktopApi={{ readFederationActivity: async () => data, copyText }} />);
    await screen.findByText("Running · connected");
    expect(screen.getByRole("switch")).toHaveClass("settings-switch", "is-on");
    expect(screen.getByRole("switch").querySelector(".settings-switch__thumb")).not.toBeNull();
    choose("Peer", "gateway");
    const sizes = within(screen.getByRole("table", { name: "Lifetime request/response sizes · uncompressed" }));
    const requestCells = within(sizes.getByRole("row", { name: /Sent requests/ })).getAllByRole("cell");
    expect(requestCells[1]).toHaveAttribute("title", "543 bytes");
    expect(requestCells[2]).toHaveAttribute("title", "540 bytes");
    await activityAction("Copy Federation activity");
    await waitFor(() => expect(copyText).toHaveBeenCalledTimes(1));
    const text = copyText.mock.calls[0][0];
    expect(text).toContain("Physical connections: gateway");
    expect(text).toContain("Requests\t12\t12\t12\t987");
    expect(text).toContain("2 KB (2000 bytes)");
    expect(text).toContain("sent requests\t33\t1 KB (543 bytes)\t1 KB (540 bytes)\t0 KB (403 bytes)\t1 KB (655 bytes)");
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
    choose("Peer", "gateway");
    await activityAction("Reset all activity");
    await waitFor(() => expect(resetFederationActivity).toHaveBeenCalledOnce());
    await act(async () => finishRead(data));
    choose("Peer", /^All connections/);
    const row = within(screen.getByRole("table", { name: "Sent traffic" })).getByRole("row", { name: /^Requests / });
    expect(within(row).getAllByRole("cell").at(-1)).toHaveTextContent("0");
  });

  it("reports reset failures and leaves existing totals intact", async () => {
    render(<FederationActivityScreen desktopApi={{ readFederationActivity: async () => fixture(),
      resetFederationActivity: async () => { throw new Error("Reset failed"); } }} />);
    await screen.findByText("Running · connected");
    await activityAction("Reset all activity");
    expect(await screen.findByRole("alert")).toHaveTextContent("Reset failed");
    expect(screen.getByRole("table", { name: "Sent traffic" })).toHaveTextContent("12");
  });
  it("asks for one minute of history and draws it as the popover's traffic card", async () => {
    const readFederationActivity = vi.fn(async () => fixture());
    const openFederationActivity = vi.fn(async () => {});
    render(<FederationStatusControl desktopApi={{ readFederationActivity, openFederationActivity }} onOpen={vi.fn()} />);
    fireEvent.focus(screen.getByRole("button", { name: "Open Star Map" }));
    const card = await screen.findByRole("button", { name: "Open Federation Activity" });
    expect(readFederationActivity).toHaveBeenCalledWith(expect.objectContaining({ includeHistory: true, historySeconds: 60 }));
    expect(card).toHaveAccessibleDescription("↑ 1 KB sent ↓ 2 KB received");
    fireEvent.click(card);
    await waitFor(() => expect(openFederationActivity).toHaveBeenCalledTimes(1));
  });

  it("shows instances as chips that fly the Star Map to them, and the map preview opens it", async () => {
    const snapshot = fixture();
    snapshot.health.instanceId = "local";
    snapshot.health.peers = [
      { id: "laptop", label: "Laptop", role: "client", status: "connected", capabilities: [] },
      { id: "travel", label: "Travel laptop", role: "client", status: "connected", capabilities: [] },
      { id: "vm", label: "Build VM", role: "client", status: "disconnected", capabilities: [] },
    ];
    snapshot.health.activeConnections = [
      { peerId: "laptop", direction: "incoming", remoteAddress: "192.168.1.20:54321", localAddress: "192.168.1.10:47830" },
      { peerId: "travel", direction: "incoming", remoteAddress: "127.0.0.1:61876", localAddress: "127.0.0.1:47831",
        via: "cloudflare-tunnel", reportedClientAddress: "203.0.113.7" },
    ];
    const openStarMapWindow = vi.fn(async () => {});
    const onOpen = vi.fn();
    render(<FederationStatusControl desktopApi={{ readFederationActivity: async () => structuredClone(snapshot), openStarMapWindow }}
      onOpen={onOpen} />);
    fireEvent.focus(screen.getByRole("button", { name: "Open Star Map" }));
    const chips = within(await screen.findByRole("list", { name: "Federation instances" }));
    expect(chips.getAllByRole("button").map((chip) => chip.textContent))
      .toEqual(["LaptopLAN", "Travel laptopCloudflare", "Build VM"]);
    expect(screen.getByText("2 of 3 connected")).toBeInTheDocument();
    fireEvent.click(chips.getByRole("button", { name: "Open Travel laptop on the Star Map" }));
    await waitFor(() => expect(openStarMapWindow).toHaveBeenCalledWith({ instanceId: "travel" }));
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.focus(screen.getByRole("button", { name: "Open Star Map" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open the Star Map" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("opens Settings at Federation from the popover's menu and closes the popover", async () => {
    const onOpenSettings = vi.fn();
    render(<FederationStatusControl desktopApi={{ readFederationActivity: async () => fixture() }}
      onOpen={vi.fn()} onOpenSettings={onOpenSettings} />);
    fireEvent.focus(screen.getByRole("button", { name: "Open Star Map" }));
    fireEvent.click(await screen.findByRole("button", { name: "More Federation actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Federation settings…" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Federation activity" })).not.toBeInTheDocument();
  });

  it("filters the Activity window by the same instance chips, named and tagged", async () => {
    const snapshot = fixture();
    snapshot.health.instanceId = "local";
    snapshot.health.peers = [
      { id: "gateway", label: "Studio Mac", role: "gateway", status: "connected", capabilities: [] },
      { id: "vm", label: "Build VM", role: "client", status: "disconnected", capabilities: [] },
    ];
    snapshot.health.activeConnections = [
      { peerId: "gateway", direction: "incoming", remoteAddress: "127.0.0.1:61876", localAddress: "127.0.0.1:47830",
        via: "tailscale-funnel" },
    ];
    const series = snapshot.activity.peers[0].series;
    snapshot.activity.peers.push({ peerId: "Other peers (attribution limit)", series });
    const readFederationActivity = vi.fn(async () => structuredClone(snapshot));
    render(<FederationActivityScreen desktopApi={{ readFederationActivity }} />);
    const filter = within(await screen.findByRole("group", { name: "Peer" }));
    // Only peers with a series get a chip: Build VM has none in this view.
    expect(filter.getAllByRole("button").map((chip) => chip.textContent))
      .toEqual(["All connections · 2", "Studio MacTS Funnel", "Other peers (attribution limit)"]);
    expect(filter.getByRole("button", { name: /^All connections/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(filter.getByRole("button", { name: "Studio Mac" }));
    await waitFor(() => expect(readFederationActivity).toHaveBeenLastCalledWith({
      historyPeerId: "gateway", historyView: "physical", includeHistory: undefined,
    }));
    expect(filter.getByRole("button", { name: "Studio Mac" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.focus(filter.getByRole("button", { name: "Studio Mac" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Through Tailscale Funnel");
  });

});
