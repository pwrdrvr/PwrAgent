import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { ReadUsageActivityResponse } from "@pwragent/shared/contracts/usage-activity";
import { HOVER_TRANSITION_GRACE_MS } from "../../../lib/useHoverTransitionGrace";
import { TOOLTIP_HOVER_DELAY_MS } from "../../../lib/useViewportTooltip";
import { ThreadContextPanel } from "../ThreadContextPanel";
import { providerPeekEntries } from "../context-panels/ProviderGaugePeek";
import { fiveHourLatches } from "../context-panels/five-hour-latch";

const HOVER_RAIL_REVEAL_DELAY_MS = 350;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fiveHourLatches.clear();
});

beforeEach(() => {
  vi.useFakeTimers();
});

const thread: NavigationThreadSummary = {
  id: "thread-1",
  title: "Thread",
  titleSource: "explicit",
  source: "codex",
  linkedDirectories: [],
  inbox: { inInbox: false },
};

function backend(
  kind: string,
  label: string,
  rateLimits?: BackendSummary["rateLimits"],
  available = true,
): BackendSummary {
  return {
    kind,
    label,
    available,
    methods: [],
    capabilities: {},
    executionModes: [],
    ...(rateLimits ? { rateLimits } : {}),
  } as unknown as BackendSummary;
}

const BACKENDS = [
  backend("codex", "OpenAI", [
    { name: "5h limit", usedPercent: 12, windowMinutes: 300 },
    { name: "Weekly limit", usedPercent: 36, windowMinutes: 10_080 },
  ]),
  backend("acp:grok", "Grok"),
  backend("claude", "Claude", [{ name: "Weekly limit", usedPercent: 81, windowMinutes: 10_080 }]),
  backend("acp:kimi", "Kimi", [{ name: "Weekly limit", usedPercent: 99, windowMinutes: 10_080 }], false),
];

/** Each pace line a limit shows under its meter makes the peek this much taller. */
const PACE_LINE_HEIGHT = 200;

/** The collapsed rail at the window's right edge: the spine alone. */
function mockLayout(): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("context-rail")) return new DOMRect(1152, 0, 48, 800);
    if (this.classList.contains("provider-peek")) {
      const paceLines = this.querySelectorAll(".backend-status-list__pace").length;
      return new DOMRect(852, 500, 290, 260 + paceLines * PACE_LINE_HEIGHT);
    }
    if (this.classList.contains("tooltip-hover-bridge")) return new DOMRect(1142, 500, 10, 260);
    return new DOMRect(1160, 740, 32, 32);
  });
}

function renderPanel(
  onActiveTabChange = vi.fn(),
  pinned = false,
  activeTab: ComponentProps<typeof ThreadContextPanel>["activeTab"] = "info",
) {
  mockLayout();
  render(
    <ThreadContextPanel
      activeTab={activeTab}
      backends={BACKENDS}
      pinned={pinned}
      thread={thread}
      onActiveTabChange={onActiveTabChange}
    />,
  );
  return onActiveTabChange;
}

/** `mouseout` then `mouseover`, as the browser reports a move. */
function move(from: Element, to: Element, at = { clientX: 1176, clientY: 756 }): void {
  fireEvent.mouseOut(from, { relatedTarget: to, ...at });
  fireEvent.mouseOver(to, { relatedTarget: from, ...at });
}

function gauge(): HTMLElement {
  return screen.getByRole("tab", { name: /AI provider info/ });
}

function peek(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".provider-peek");
}

async function openPeek(): Promise<HTMLElement> {
  move(document.body, gauge());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(TOOLTIP_HOVER_DELAY_MS);
  });
  return peek()!;
}

describe("AI provider gauge peek", () => {
  it("lists each available provider's tightest limit, worst first", () => {
    const entries = providerPeekEntries(BACKENDS, 0);
    expect(entries.map((entry) => [entry.backend.label, entry.usedPercent])).toEqual([
      ["Claude", 81],
      ["OpenAI", 36],
      ["Grok", undefined],
    ]);
  });

  // Antigravity reports two pools, each with a 5h and a Weekly window. The
  // peek showed only the fullest limit, so Gemini vanished behind Claude/GPT.
  const ANTIGRAVITY = backend("acp:antigravity", "Antigravity", [
    { name: "5h Claude/GPT limit", limitId: "b1", usedPercent: 0, windowMinutes: 300 },
    { name: "Weekly Claude/GPT limit", limitId: "b2", usedPercent: 36, windowMinutes: 10_080 },
    { name: "Weekly Gemini limit", limitId: "b3", usedPercent: 30, windowMinutes: 10_080 },
    { name: "5h Gemini limit", limitId: "b4", usedPercent: 7.4, windowMinutes: 300 },
  ]);

  it("shows each of a provider's pools by its Weekly window", () => {
    const entries = providerPeekEntries([ANTIGRAVITY, BACKENDS[0]!], 0);
    expect(entries.map((entry) => [
      entry.backend.label,
      entry.scopes.map((scope) => [scope.scope, scope.window, scope.limit.name]),
    ])).toEqual([
      ["Antigravity", [
        ["Claude/GPT", "Weekly", "Weekly Claude/GPT limit"],
        ["Gemini", "Weekly", "Weekly Gemini limit"],
      ]],
      // One plan: no scope, and its 5h window stays on the panel.
      ["OpenAI", [[null, "Weekly", "Weekly limit"]]],
    ]);
  });

  describe("a scope's 5h row", () => {
    const RESET = Date.UTC(2030, 0, 1, 12);
    const openAi = (fiveHourUsed: number) => backend("codex", "OpenAI", [
      { name: "5h limit", usedPercent: fiveHourUsed, windowMinutes: 300, resetAt: RESET },
      { name: "Weekly limit", usedPercent: 30, windowMinutes: 10_080 },
    ]);
    const panel = (backends: BackendSummary[]) => (
      <ThreadContextPanel
        activeTab="info"
        backends={backends}
        pinned={false}
        thread={thread}
        onActiveTabChange={vi.fn()}
      />
    );
    const windows = (shown: HTMLElement) =>
      [...shown.querySelectorAll(".provider-peek__window")].map((node) => node.textContent);

    it("shows under the Weekly row while at risk, and stays across a remount", async () => {
      mockLayout();
      const view = render(panel([openAi(85)]));
      let shown = await openPeek();
      expect(windows(shown)).toEqual(["Weekly", "5h"]);
      const rows = shown.querySelectorAll(".provider-peek__scope .provider-peek__limit");
      expect(rows).toHaveLength(2);
      expect(rows[1]).toHaveTextContent("85% used");

      // The peek unmounts on the way out; the latch is not its state.
      move(gauge(), document.body);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HOVER_TRANSITION_GRACE_MS * 2);
      });
      expect(peek()).toBeNull();
      // Between the bounds, with no pace to project from: it keeps its state.
      view.rerender(panel([openAi(70)]));
      shown = await openPeek();
      expect(windows(shown)).toEqual(["Weekly", "5h"]);
      expect(shown).toHaveTextContent("70% used");
    });

    it("wears the warning tone once the window has run out", async () => {
      mockLayout();
      render(panel([openAi(100)]));
      const rows = (await openPeek()).querySelectorAll(".provider-peek__limit");
      expect(rows).toHaveLength(2);
      expect(rows[0]).not.toHaveClass("is-warning");
      expect(rows[1]).toHaveClass("is-warning");
    });

    // The latch keys the window, not the scope's label, which becomes
    // "All models" when a second scope appears.
    it("stays shown when the provider gains a second scope", async () => {
      mockLayout();
      const view = render(panel([openAi(85)]));
      move(document.body, gauge());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TOOLTIP_HOVER_DELAY_MS);
      });
      move(gauge(), document.body);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HOVER_TRANSITION_GRACE_MS * 2);
      });
      const withSpark = openAi(70);
      withSpark.rateLimits = [
        ...withSpark.rateLimits!,
        { name: "GPT-5.3-Codex-Spark Weekly limit", limitName: "GPT-5.3-Codex-Spark", usedPercent: 4, windowMinutes: 10_080 },
      ];
      view.rerender(panel([withSpark]));
      const shown = await openPeek();
      expect([...shown.querySelectorAll(".provider-peek__scope-name")].map((node) => node.textContent))
        .toEqual(["All models", "Spark"]);
      expect(windows(shown)).toEqual(["Weekly", "5h", "Weekly"]);
    });

    it("stays hidden in the same band without a crossing", async () => {
      mockLayout();
      render(panel([openAi(70)]));
      expect(windows(await openPeek())).toEqual(["Weekly"]);
    });
  });

  it("names the pools as subheaders, and the rows by their window alone", async () => {
    mockLayout();
    render(
      <ThreadContextPanel
        activeTab="info"
        backends={[ANTIGRAVITY, BACKENDS[2]!]}
        pinned={false}
        thread={thread}
        onActiveTabChange={vi.fn()}
      />,
    );
    const shown = await openPeek();
    const providers = [...shown.querySelectorAll<HTMLElement>(".provider-peek__provider")];
    const read = (provider: HTMLElement) => ({
      scopes: [...provider.querySelectorAll(".provider-peek__scope-name")].map((node) => node.textContent),
      windows: [...provider.querySelectorAll(".provider-peek__window")].map((node) => node.textContent),
    });
    expect(providers.map((provider) => provider.querySelector(".provider-peek__name")!.textContent))
      .toEqual(["Claude", "Antigravity"]);
    expect(read(providers[0]!)).toEqual({ scopes: [], windows: ["Weekly"] });
    expect(read(providers[1]!)).toEqual({ scopes: ["Claude/GPT", "Gemini"], windows: ["Weekly", "Weekly"] });
    expect(providers[1]).toHaveTextContent("36% used");
    expect(providers[1]).toHaveTextContent("30% used");
    // The panel's own label ("Weekly Gemini limit") is hidden by the peek's
    // stylesheet, which jsdom does not load; the visible text is the rest.
    for (const label of shown.querySelectorAll(".provider-peek__stat dt")) label.remove();
    expect(shown).not.toHaveTextContent(/limit/i);
    expect(shown).not.toHaveTextContent("5h");
    // Every row shares the one window column, so every bar starts at one edge.
    for (const row of shown.querySelectorAll(".provider-peek__limit")) {
      expect(row.firstElementChild).toHaveClass("provider-peek__window");
      expect(row.querySelector(".backend-status-list__meter")).not.toBeNull();
    }
  });

  it("peeks on hover while the rail stays collapsed", async () => {
    renderPanel();
    const shown = await openPeek();
    expect(shown).toBeInTheDocument();
    const names = [...shown.querySelectorAll(".provider-peek__name")].map((name) => name.textContent);
    expect(names).toEqual(["Claude", "OpenAI", "Grok"]);
    expect(shown).toHaveTextContent("No limits reported");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_RAIL_REVEAL_DELAY_MS * 2);
    });
    // The hover reveal never fired: no panel opened behind the peek.
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
  });

  it("peeks over an open rail showing another panel", async () => {
    renderPanel(vi.fn(), true);
    const shown = await openPeek();
    expect(shown).toBeInTheDocument();
    // The peek is the only tooltip: the tab's own never joins it.
    expect(screen.getAllByRole("tooltip")).toEqual([shown]);
  });

  it("keeps the tab tooltip, not the peek, while the AI providers panel shows", async () => {
    renderPanel(vi.fn(), true, "providers");
    move(document.body, gauge());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOOLTIP_HOVER_DELAY_MS);
    });
    expect(peek()).toBeNull();
    expect(screen.getByRole("tooltip")).toHaveTextContent(/AI provider info/);
  });

  it("stays open across the bridge and on the card", async () => {
    renderPanel();
    const shown = await openPeek();
    const bridge = shown.querySelector(".tooltip-hover-bridge")!;
    move(gauge(), bridge, { clientX: 1146, clientY: 600 });
    move(bridge, shown, { clientX: 1100, clientY: 600 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_TRANSITION_GRACE_MS * 2);
    });
    expect(peek()).not.toBeNull();
    move(shown, document.body, { clientX: 600, clientY: 600 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_TRANSITION_GRACE_MS + 1);
    });
    expect(peek()).toBeNull();
  });

  it("still opens the full panel on click", async () => {
    const onActiveTabChange = renderPanel();
    await openPeek();
    fireEvent.pointerDown(gauge());
    fireEvent.click(gauge());
    expect(onActiveTabChange).toHaveBeenCalledWith("providers");
    expect(peek()).toBeNull();
  });

  it("opens the panel from the peek's own row", async () => {
    const onActiveTabChange = renderPanel();
    const shown = await openPeek();
    fireEvent.click(shown.querySelector(".project-card__target")!);
    expect(onActiveTabChange).toHaveBeenCalledWith("providers");
    expect(peek()).toBeNull();
  });

  // Found in the running app: the pace read finished after the peek was
  // placed, and the taller card ran off the bottom of the window.
  it("re-places the peek when its pace lines arrive", async () => {
    const now = Date.UTC(2026, 10, 24, 21);
    vi.setSystemTime(now);
    const weekly = {
      name: "Weekly limit",
      windowKey: "secondary" as const,
      windowMinutes: 10_080,
      resetAt: now + 82 * 3_600_000,
    };
    let answer: (response: ReadUsageActivityResponse) => void = () => undefined;
    const readUsageActivity = vi.fn(() => new Promise<ReadUsageActivityResponse>((resolve) => {
      answer = resolve;
    }));
    mockLayout();
    render(
      <ThreadContextPanel
        activeTab="info"
        backends={[backend("codex", "OpenAI", [{ ...weekly, usedPercent: 53 }])]}
        desktopApi={{ readUsageActivity } as unknown as ComponentProps<typeof ThreadContextPanel>["desktopApi"]}
        pinned={false}
        thread={thread}
        onActiveTabChange={vi.fn()}
      />,
    );
    const shown = await openPeek();
    // The read starts once the peek is up, on the next tick.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(readUsageActivity).toHaveBeenCalledTimes(1);
    expect(shown.querySelector(".backend-status-list__pace")).toBeNull();
    await act(async () => {
      answer({
        rows: [],
        readAt: now,
        rateLimits: [],
        truncated: false,
        limitObservation: {
          observedAt: now,
          accountKey: "acct",
          planType: "pro",
          limits: [{ ...weekly, usedPercent: 53 }],
        },
      } as unknown as ReadUsageActivityResponse);
      await vi.advanceTimersByTimeAsync(0);
    });
    const placed = peek()!;
    expect(placed.querySelector(".backend-status-list__pace")).not.toBeNull();
    const bottom = Number.parseFloat(placed.style.top) + placed.getBoundingClientRect().height;
    expect(bottom).toBeLessThanOrEqual(window.innerHeight);
  });

  // Found by the scaling audit: reading the pace only while the peek was up
  // dropped a read still running when it closed, so every glance read again.
  it("reads the pace once across glances that end before it answers", async () => {
    const now = Date.UTC(2026, 10, 25, 9);
    vi.setSystemTime(now);
    const weekly = { name: "Weekly limit", windowKey: "secondary" as const, windowMinutes: 10_080, resetAt: now + 82 * 3_600_000 };
    const readUsageActivity = vi.fn(() => new Promise<ReadUsageActivityResponse>((resolve) => {
      setTimeout(() => resolve({
        rows: [],
        readAt: now,
        rateLimits: [],
        truncated: false,
        limitObservation: { observedAt: now, accountKey: "glances", planType: "pro", limits: [{ ...weekly, usedPercent: 53 }] },
      } as unknown as ReadUsageActivityResponse), 5_000);
    }));
    mockLayout();
    render(
      <ThreadContextPanel
        activeTab="info"
        backends={[backend("codex", "OpenAI", [{ ...weekly, usedPercent: 53 }])]}
        desktopApi={{ readUsageActivity } as unknown as ComponentProps<typeof ThreadContextPanel>["desktopApi"]}
        pinned={false}
        thread={thread}
        onActiveTabChange={vi.fn()}
      />,
    );
    for (let glance = 0; glance < 3; glance += 1) {
      await openPeek();
      move(gauge(), document.body, { clientX: 600, clientY: 600 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HOVER_TRANSITION_GRACE_MS + 1);
      });
      expect(peek()).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
    }
    expect(readUsageActivity).toHaveBeenCalledTimes(1);
  });

  // React reports a leave to outside the window with `window` as the related
  // target, which `Node.contains` rejects.
  it("closes without an error when the pointer leaves the window from the gauge", async () => {
    const errors: unknown[] = [];
    const record = (event: ErrorEvent) => {
      errors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener("error", record);
    try {
      renderPanel();
      await openPeek();
      fireEvent.mouseOut(gauge(), { relatedTarget: null, clientX: 1199, clientY: 756 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HOVER_TRANSITION_GRACE_MS + 1);
      });
      expect(peek()).toBeNull();
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener("error", record);
    }
  });

  it("hands the hover reveal back when the pointer moves on up the spine", async () => {
    renderPanel();
    await openPeek();
    const other = screen.getByRole("tab", { name: /^Details/ });
    move(gauge(), other, { clientX: 1176, clientY: 40 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOVER_RAIL_REVEAL_DELAY_MS + 1);
    });
    expect(screen.getByRole("tabpanel", { name: /^Details/ })).toBeInTheDocument();
  });
});
