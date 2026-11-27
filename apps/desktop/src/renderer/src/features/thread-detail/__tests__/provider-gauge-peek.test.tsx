import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { HOVER_TRANSITION_GRACE_MS } from "../../../lib/useHoverTransitionGrace";
import { TOOLTIP_HOVER_DELAY_MS } from "../../../lib/useViewportTooltip";
import { ThreadContextPanel } from "../ThreadContextPanel";
import { providerPeekEntries } from "../context-panels/ProviderGaugePeek";

const HOVER_RAIL_REVEAL_DELAY_MS = 350;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
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

/** The collapsed rail at the window's right edge: the spine alone. */
function mockLayout(): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("context-rail")) return new DOMRect(1152, 0, 48, 800);
    if (this.classList.contains("provider-peek")) return new DOMRect(852, 500, 290, 260);
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
