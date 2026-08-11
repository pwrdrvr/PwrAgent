import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { StarMapScreen } from "../StarMapScreen";

/**
 * Orbit-lens project cloud chrome: the label pills, the per-cloud "+N
 * more" expand chips, and the chip hygiene inside a labeled cloud. The
 * geometry itself is pinned in star-map-clusters.test.ts; this file pins
 * what the operator actually sees and clicks.
 */

function buildDesktopApi(): DesktopApi {
  return {
    readFederationHealth: vi.fn(async () => ({
      health: {
        enabled: false,
        role: "client" as const,
        status: "disabled" as const,
        instanceId: "pwr_local",
        localCelestialIcon: "sun" as const,
        localLabel: "Harold-MBP-M5-Max",
        localProfileName: "default",
        peers: [],
      },
    })),
    onAgentEvent: vi.fn(() => () => undefined),
  };
}

function projectThread(
  id: string,
  path: string,
  label: string,
): NavigationThreadSummary {
  return {
    id,
    title: `Thread ${id}`,
    titleSource: "generated",
    linkedDirectories: [
      { id: `dir-${path}`, label, path, kind: "local" },
    ],
    source: "codex",
    inbox: { inInbox: false },
    updatedAt: 100,
  } as unknown as NavigationThreadSummary;
}

function renderOrbit(threads: NavigationThreadSummary[]) {
  window.localStorage.setItem(
    "pwragent.starMap.viewPreferences",
    JSON.stringify({ layout: "orbit" }),
  );
  return render(
    <StarMapScreen
      desktopApi={buildDesktopApi()}
      localThreads={threads}
      sessionKeys={{}}
      localInstanceLabel="Mac-Mini-M4"
      floating={false}
      onClose={() => undefined}
      onOpenLocalThread={() => undefined}
      onFocusLocalInstance={() => undefined}
    />,
  );
}

describe("star map project cloud chrome", () => {
  afterEach(() => {
    window.localStorage.removeItem("pwragent.starMap.viewPreferences");
    window.localStorage.removeItem("pwragent.starMap.filterSelection");
  });

  it("labels each project cloud with its name and total", async () => {
    renderOrbit([
      projectThread("a1", "/repo/alpha", "AlphaDir"),
      projectThread("a2", "/repo/alpha", "AlphaDir"),
      projectThread("b1", "/repo/beta", "BetaDir"),
      projectThread("b2", "/repo/beta", "BetaDir"),
    ]);
    const alphaLabel = await screen.findByRole("button", {
      name: /Select the alpha cards \(2 threads\)/,
    });
    expect(alphaLabel.textContent).toContain("alpha");
    expect(alphaLabel.textContent).toContain("2");
    expect(
      screen.getByRole("button", {
        name: /Select the beta cards \(2 threads\)/,
      }),
    ).toBeTruthy();
  });

  it("keeps every card chip inside a labeled cloud", async () => {
    renderOrbit([
      projectThread("a1", "/repo/alpha", "AlphaDir"),
      projectThread("a2", "/repo/alpha", "AlphaDir"),
    ]);
    await screen.findByRole("button", { name: /Select the alpha cards/ });
    // The cloud groups cards; it must not strip their anatomy — the
    // directory chips render exactly as they would anywhere else.
    expect(screen.getAllByText("AlphaDir").length).toBeGreaterThan(0);
  });

  it("floats a lone card chromeless — no label, no chip", async () => {
    renderOrbit([
      {
        ...projectThread("x", "/repo/gamma", "GammaDir"),
        linkedDirectories: [],
      } as unknown as NavigationThreadSummary,
    ]);
    await screen.findByRole("button", { name: /Open thread: Thread x/ });
    expect(screen.queryByRole("button", { name: /Select the/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /more .* threads/ })).toBeNull();
  });

  it("truncates a big cloud at the group cap and expands on the chip", async () => {
    const threads = Array.from({ length: 12 }, (unused, index) =>
      projectThread(`t${index}`, "/repo/alpha", "AlphaDir"),
    );
    renderOrbit(threads);

    const chip = await screen.findByRole("button", {
      name: /Show 4 more alpha threads/,
    });
    expect(chip.textContent).toBe("+4 more");
    expect(
      screen.getAllByRole("button", { name: /^Open thread:/ }),
    ).toHaveLength(8);

    // Re-query at click time: card measurement re-renders the map, and a
    // node captured by an earlier waitFor can already be detached.
    fireEvent.click(
      screen.getByRole("button", { name: /Show 4 more alpha threads/ }),
    );
    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: /^Open thread:/ }),
      ).toHaveLength(12);
    });

    // The chip stays so the cloud can fold back down.
    expect(
      screen.getByRole("button", { name: /Show fewer alpha threads/ })
        .textContent,
    ).toBe("Show fewer");
    fireEvent.click(
      screen.getByRole("button", { name: /Show fewer alpha threads/ }),
    );
    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: /^Open thread:/ }),
      ).toHaveLength(8);
    });
  });

  it("selects the cloud's visible cards from the pill", async () => {
    const { container } = renderOrbit([
      projectThread("a1", "/repo/alpha", "AlphaDir"),
      projectThread("a2", "/repo/alpha", "AlphaDir"),
      projectThread("b1", "/repo/beta", "BetaDir"),
    ]);
    const pill = await screen.findByRole("button", {
      name: /Select the alpha cards/,
    });
    expect(pill.getAttribute("aria-pressed")).toBe("false");

    // Re-query at click time — see the expand test above.
    fireEvent.click(
      screen.getByRole("button", { name: /Select the alpha cards/ }),
    );
    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: /Select the alpha cards/ })
          .getAttribute("aria-pressed"),
      ).toBe("true");
    });
    expect(
      container.querySelectorAll(".star-map-card-shell--selected"),
    ).toHaveLength(2);

    // Second click releases the same cloud.
    fireEvent.click(
      screen.getByRole("button", { name: /Select the alpha cards/ }),
    );
    await waitFor(() => {
      expect(
        container.querySelectorAll(".star-map-card-shell--selected"),
      ).toHaveLength(0);
    });
  });
});
