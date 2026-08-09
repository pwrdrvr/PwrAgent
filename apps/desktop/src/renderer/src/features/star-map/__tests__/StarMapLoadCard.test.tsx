import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FederationLoadStatus } from "@pwragent/shared";
import { StarMapLoadCard } from "../StarMapLoadCard";

type CardProps = Parameters<typeof StarMapLoadCard>[0];

function buildLoad(
  overrides: Partial<FederationLoadStatus> = {},
): FederationLoadStatus {
  return {
    loadAvg1: 2.5,
    loadAvg5: 1.75,
    loadAvg15: 1.5,
    cpuCount: 16,
    availableMemoryBytes: 5_452_595,
    diskFreeBytes: 214_748_364_800,
    sampledAt: Date.now(),
    ...overrides,
  };
}

function renderCard(overrides: Partial<CardProps> = {}): CardProps {
  const props: CardProps = {
    instanceId: "pwr_studio",
    instanceLabel: "Studio Mac",
    load: buildLoad(),
    baseSlot: { dx: 0, dy: 100 },
    width: 220,
    stackIndex: 0,
    onDismiss: vi.fn(),
    ...overrides,
  };
  render(<StarMapLoadCard {...props} />);
  return props;
}

function metric(label: string): string {
  const term = [...document.querySelectorAll(".star-map-load-card__metrics dt")]
    .find((node) => node.textContent === label);
  const value = term?.parentElement?.querySelector("dd");
  if (!value) throw new Error(`No metric labelled ${label}`);
  return value.textContent ?? "";
}

describe("StarMapLoadCard", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders CPU against the core count, not as a bare load average", () => {
    // A load average is a queue length: 2.5 is idle on 16 cores and badly
    // oversubscribed on 2, so the bare number is unreadable on its own.
    renderCard({ load: buildLoad({ loadAvg1: 2.5, cpuCount: 16 }) });

    expect(metric("CPU")).toBe("16%");
    expect(metric("Free RAM")).toBe("5.2 MB");
    expect(metric("Free disk")).toBe("200 GB");
  });

  it("lets CPU exceed 100% when work is queueing", () => {
    renderCard({ load: buildLoad({ loadAvg1: 12, cpuCount: 8 }) });

    expect(metric("CPU")).toBe("150%");
  });

  it("falls back to the raw average when the core count is unknown", () => {
    renderCard({ load: buildLoad({ loadAvg1: 2.5, cpuCount: undefined }) });

    expect(metric("CPU")).toBe("2.50");
  });

  it("reads three zero load averages as not reported, not as idle", () => {
    // Node reports 0 for every average on Windows; printing "0%" there
    // would claim an idle machine we have no reading for.
    renderCard({
      load: buildLoad({ loadAvg1: 0, loadAvg5: 0, loadAvg15: 0 }),
    });

    expect(metric("CPU")).toBe("—");
  });

  it("shows a dash when the disk read failed", () => {
    renderCard({ load: buildLoad({ diskFreeBytes: undefined }) });

    expect(metric("Free disk")).toBe("—");
  });

  it("announces a reading nobody has refreshed instead of showing it as fresh", () => {
    const { container } = render(
      <StarMapLoadCard
        instanceId="pwr_slow"
        instanceLabel="Slow Mini"
        load={buildLoad({ sampledAt: Date.now() - 90_000 })}
        baseSlot={{ dx: 0, dy: 100 }}
        width={220}
        stackIndex={0}
        onDismiss={vi.fn()}
      />,
    );

    expect(
      container.querySelector(".star-map-load-shell--stale"),
    ).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Not responding");
    expect(screen.getByRole("status").textContent).toContain("2m ago");
  });

  it("stays quiet about its age while the reading is fresh", () => {
    renderCard();

    // A ticking "4s ago" in a mission-control view is noise; only the
    // failure is worth words.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("explains identical numbers on two profiles of one machine", () => {
    renderCard({ sharedWith: "dev" });

    expect(document.body.textContent).toContain("Same machine as dev");
  });

  it("reads as pending before the first sample lands", () => {
    renderCard({ load: undefined });

    expect(document.body.textContent).toContain("Reading…");
    expect(
      document.querySelectorAll(".star-map-load-card__metrics").length,
    ).toBe(0);
  });

  it("dismisses through a named control", () => {
    const onDismiss = vi.fn();
    renderCard({ onDismiss });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove load card for Studio Mac",
      }),
    );

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("layers the synced drag offset on top of its default slot", () => {
    const { container } = render(
      <StarMapLoadCard
        instanceId="pwr_studio"
        instanceLabel="Studio Mac"
        load={buildLoad()}
        baseSlot={{ dx: 0, dy: 100 }}
        offset={{ dx: -40, dy: 25 }}
        width={220}
        stackIndex={0}
        onDismiss={vi.fn()}
      />,
    );

    const shell = container.querySelector<HTMLElement>(".star-map-load-shell");
    expect(shell?.style.left).toBe("-40px");
    expect(shell?.style.top).toBe("125px");
  });
});
