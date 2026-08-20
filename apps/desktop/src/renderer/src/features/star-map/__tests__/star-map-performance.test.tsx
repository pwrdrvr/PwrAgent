import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { StarMapScreen } from "../StarMapScreen";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(
  path.resolve(testDir, "../../../styles/app.css"),
  "utf8",
);

function buildDesktopApi(): DesktopApi {
  return {
    readFederationHealth: vi.fn(async () => ({
      health: {
        enabled: false,
        role: "client" as const,
        status: "disabled" as const,
        instanceId: "pwr_local",
        localCelestialIcon: "sun" as const,
        localLabel: "Local",
        localProfileName: "default",
        peers: [],
      },
    })),
    onAgentEvent: vi.fn(() => () => undefined),
  } as unknown as DesktopApi;
}

function thread(id: string): NavigationThreadSummary {
  return {
    id,
    title: `Thread ${id}`,
    titleSource: "generated",
    linkedDirectories: [],
    source: "codex",
    inbox: { inInbox: true, reason: "updated-since-seen" },
    updatedAt: 100,
  } as unknown as NavigationThreadSummary;
}

function screen(threads: readonly NavigationThreadSummary[]) {
  return (
    <StarMapScreen
      desktopApi={buildDesktopApi()}
      localThreads={threads}
      sessionKeys={{}}
      onOpenLocalThread={() => undefined}
      onFocusLocalInstance={() => undefined}
    />
  );
}

describe("star map idle performance", () => {
  const OriginalResizeObserver = globalThis.ResizeObserver;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: OriginalResizeObserver,
    });
    window.localStorage.removeItem("pwragent.starMap.viewPreferences");
    window.localStorage.removeItem("pwragent.starMap.filterSelection");
  });

  it("has no perpetual star or link animation", () => {
    expect(css).not.toContain("star-map-twinkle");
    expect(css).not.toContain("star-map-flow");
    expect(css).not.toContain(".star-map__link-flow");
  });

  it("promotes the large canvas only while it is moving", () => {
    const canvasRule = css.match(
      /\.star-map__canvas\.is-transformed\s*\{[\s\S]*?\n\}/,
    )?.[0];
    // Pointer pan and keyboard flight both write the transform every
    // frame; neither promotion may outlive its gesture.
    const movingRule = css.match(
      /\.star-map__viewport\.is-panning \.star-map__canvas\.is-transformed,\s*\.star-map\.is-flying \.star-map__canvas\.is-transformed\s*\{[\s\S]*?\n\}/,
    )?.[0];
    expect(canvasRule).not.toContain("will-change");
    expect(movingRule).toContain("will-change: transform;");
  });

  it("brings a cloud in as scattered groups, not one flat switch-on", async () => {
    // The pure dealing is pinned in star-map-logic.test; this is the wiring
    // — that the delays reach the shells at all, and that a real cloud
    // produces more than one beat. A regression here looks like every card
    // sharing a delay, which is the "they all appear at once" complaint.
    const threads = Array.from({ length: 24 }, (_, index) =>
      thread(`t${index}`),
    );
    const { container } = render(screen(threads));
    const shells = await waitFor(() => {
      const nodes = [
        ...container.querySelectorAll<HTMLElement>(".star-map-card-shell"),
      ].filter((shell) => shell.dataset.threadKey);
      if (nodes.length === 0) throw new Error("no cards");
      return nodes;
    });
    const delays = shells.map((shell) => shell.style.animationDelay);
    expect(new Set(delays).size).toBeGreaterThan(1);
    // And the beats must not climb with the card order: a delay that rises
    // monotonically is a wipe with a direction, which is the "they all
    // appear in the same order" complaint this answers.
    // An unset delay is the empty string, and parseFloat("") is NaN —
    // which makes every comparison false and would pass this test for the
    // wrong reason. The first card's missing style means zero.
    const ms = delays.map((delay) => Number.parseFloat(delay) || 0);
    const monotonic = ms.every(
      (delay, index) => index === 0 || delay >= ms[index - 1],
    );
    expect(monotonic).toBe(false);
  });

  it("updates card layout from ResizeObserver without reading offsetHeight", async () => {
    // The expected card position is a lanes-geometry number; the default
    // lens is orbit now, so pin the layout the assertion assumes.
    window.localStorage.setItem(
      "pwragent.starMap.viewPreferences",
      JSON.stringify({ layout: "lanes" }),
    );
    const observers: Array<{
      callback: ResizeObserverCallback;
      elements: Set<Element>;
    }> = [];
    class ResizeObserverMock {
      private readonly record: (typeof observers)[number];

      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, elements: new Set() };
        observers.push(this.record);
      }

      observe = (element: Element) => this.record.elements.add(element);
      unobserve = (element: Element) => this.record.elements.delete(element);
      disconnect = () => this.record.elements.clear();
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: ResizeObserverMock,
    });

    const offsetHeight = vi.spyOn(
      HTMLElement.prototype,
      "offsetHeight",
      "get",
    );
    const { container, rerender } = render(screen([thread("a"), thread("b")]));
    await waitFor(() => {
      expect(container.querySelectorAll("[data-thread-key]")).toHaveLength(2);
    });

    const shells = [
      ...container.querySelectorAll<HTMLElement>("[data-thread-key]"),
    ];
    const cardObserver = observers.find((observer) =>
      observer.elements.has(shells[0]),
    );
    expect(cardObserver).toBeTruthy();
    act(() => {
      cardObserver?.callback(
        shells.map((element, index) => ({
          target: element,
          borderBoxSize: [{ blockSize: index === 0 ? 180 : 90 }],
          contentRect: { height: index === 0 ? 180 : 90 },
        })) as unknown as ResizeObserverEntry[],
        {} as ResizeObserver,
      );
    });

    await waitFor(() => {
      expect(shells[1].style.top).toBe("292px");
    });
    rerender(screen([thread("a"), thread("b")]));
    expect(offsetHeight).not.toHaveBeenCalled();
  });
});

