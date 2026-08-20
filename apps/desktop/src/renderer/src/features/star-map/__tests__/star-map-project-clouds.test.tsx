import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { StarMapScreen } from "../StarMapScreen";

/**
 * Projects-lens clouds.
 *
 * The lens used to seat a project's threads on one flat ring capped at
 * sixteen cards, with a single dead "+N more" caption for the whole body:
 * a parent thread and its children scattered around the ring like any
 * other cards, and the seventeenth thread was unreachable. It now groups
 * the same way the Instances lens does — parent/child clouds plus a
 * catch-all, each with its own working chip.
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
  } as unknown as DesktopApi;
}

function thread(params: {
  id: string;
  path: string;
  label: string;
  title?: string;
  parentThreadId?: string;
}): NavigationThreadSummary {
  return {
    id: params.id,
    title: params.title ?? `Thread ${params.id}`,
    titleSource: "generated",
    linkedDirectories: [
      { id: `dir-${params.path}`, label: params.label, path: params.path, kind: "local" },
    ],
    source: "codex",
    inbox: { inInbox: false },
    updatedAt: 100,
    ...(params.parentThreadId
      ? { parentThreadId: params.parentThreadId, parentThreadBackend: "codex" }
      : {}),
  } as unknown as NavigationThreadSummary;
}

function renderProjects(threads: NavigationThreadSummary[]) {
  window.localStorage.setItem(
    "pwragent.starMap.viewPreferences",
    JSON.stringify({ layout: "projects" }),
  );
  return render(
    <StarMapScreen
      desktopApi={buildDesktopApi()}
      localThreads={threads}
      sessionKeys={{}}
      localInstanceLabel="Mac-Mini-M4"
      onOpenLocalThread={() => undefined}
      onFocusLocalInstance={() => undefined}
    />,
  );
}

describe("star map projects lens clouds", () => {
  afterEach(() => {
    window.localStorage.removeItem("pwragent.starMap.viewPreferences");
    window.localStorage.removeItem("pwragent.starMap.filterSelection");
  });

  it("gives a parent thread and its children their own cloud", async () => {
    renderProjects([
      thread({ id: "p1", path: "/repo/alpha", label: "AlphaDir", title: "Root work" }),
      thread({
        id: "c1",
        parentThreadId: "p1",
        path: "/repo/alpha",
        label: "AlphaDir",
        title: "Child one",
      }),
      thread({
        id: "c2",
        parentThreadId: "p1",
        path: "/repo/alpha",
        label: "AlphaDir",
        title: "Child two",
      }),
      thread({ id: "loose", path: "/repo/alpha", label: "AlphaDir" }),
    ]);

    // The parent group is captioned by its parent's title, and says so:
    // "N threads" would read exactly like a project cloud, which is the
    // ambiguity that made an operator count thread groups as projects.
    const label = await screen.findByRole("button", {
      name: "Select the Root work thread and its 2 replies",
    });
    expect(label.className).toContain("star-map__cluster-label--parent");
    expect(label.textContent).toContain("Root work");

    // The catch-all is NOT labelled: the project body already names and
    // counts the project, so a second pill would print it twice.
    expect(
      screen.queryByRole("button", { name: /Select the alpha cards/ }),
    ).toBeNull();
  });

  it("expands past the per-cloud cap from the chip", async () => {
    renderProjects(
      Array.from({ length: 11 }, (unused, index) =>
        thread({ id: `t${index}`, path: "/repo/alpha", label: "AlphaDir" }),
      ),
    );

    const chip = await screen.findByRole("button", {
      name: /Show 3 more alpha threads/,
    });
    expect(chip.textContent).toBe("+3 more");
    expect(
      screen.getAllByRole("button", { name: /^Open thread:/ }),
    ).toHaveLength(8);

    // Re-query at click time: card measurement re-renders the map.
    fireEvent.click(
      screen.getByRole("button", { name: /Show 3 more alpha threads/ }),
    );
    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: /^Open thread:/ }),
      ).toHaveLength(11);
    });
  });

  it("keeps two projects' clouds independent", async () => {
    renderProjects([
      thread({ id: "a1", path: "/repo/alpha", label: "AlphaDir", title: "Alpha root" }),
      thread({
        id: "a2",
        parentThreadId: "a1",
        path: "/repo/alpha",
        label: "AlphaDir",
        title: "Alpha child",
      }),
      thread({ id: "b1", path: "/repo/beta", label: "BetaDir", title: "Beta root" }),
      thread({
        id: "b2",
        parentThreadId: "b1",
        path: "/repo/beta",
        label: "BetaDir",
        title: "Beta child",
      }),
    ]);

    await screen.findByRole("button", {
      name: "Select the Alpha root thread and its 1 reply",
    });
    await screen.findByRole("button", {
      name: "Select the Beta root thread and its 1 reply",
    });
  });

  it("selects a parent cloud's cards from its pill", async () => {
    const { container } = renderProjects([
      thread({ id: "p1", path: "/repo/alpha", label: "AlphaDir", title: "Root work" }),
      thread({
        id: "c1",
        parentThreadId: "p1",
        path: "/repo/alpha",
        label: "AlphaDir",
        title: "Child one",
      }),
      thread({ id: "loose", path: "/repo/alpha", label: "AlphaDir" }),
    ]);
    // Card keys name their owning instance, and the map drops a selection
    // swept against the placeholder id the moment the durable one lands.
    // This lens draws no instance body to wait on, so wait on the keys.
    await waitFor(() => {
      expect(
        container.querySelector('[data-card-key="pwr_local::codex:p1"]'),
      ).not.toBeNull();
    });
    const name = "Select the Root work thread and its 1 reply";
    await screen.findByRole("button", { name });

    fireEvent.click(screen.getByRole("button", { name }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name }).getAttribute("aria-pressed"),
      ).toBe("true");
    });
    // The parent and its child only — the loose thread is a cloudmate of
    // neither, and pooling by project would have swept it in too.
    expect(
      container.querySelectorAll(".star-map-card-shell--selected"),
    ).toHaveLength(2);
  });
});
