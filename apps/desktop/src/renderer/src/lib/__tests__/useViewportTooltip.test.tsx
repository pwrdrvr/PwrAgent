import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TOOLTIP_HOVER_DELAY_MS,
  useViewportTooltip,
} from "../useViewportTooltip";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function TooltipFixture() {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });

  return (
    <div>
      <div data-testid="sidebar-scroll-region">
        <button
          type="button"
          onMouseEnter={(event) =>
            tooltip.show(event.currentTarget, "Branch details")
          }
        >
          agent/keep-tooltip-open
        </button>
      </div>
      <div data-testid="transcript-scroll-region" />
      {tooltip.tooltipNode}
    </div>
  );
}

function DelayedTooltipFixture() {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });

  return (
    <div>
      <div data-testid="sidebar-scroll-region">
        <button
          type="button"
          aria-describedby={tooltip.visible ? tooltip.tooltipId : undefined}
          onMouseEnter={(event) =>
            tooltip.showAfterDelay(event.currentTarget, "Branch details")
          }
          onMouseLeave={tooltip.hide}
        >
          agent/delay-tooltip
        </button>
      </div>
      {tooltip.tooltipNode}
    </div>
  );
}

function HorizontallyBoundedTooltipFixture() {
  const tooltip = useViewportTooltip({
    className: "viewport-tooltip",
    getHorizontalBounds: (target) => {
      const bounds = target.closest<HTMLElement>("[data-tooltip-bounds]");
      if (!bounds) {
        return undefined;
      }
      const { left, right } = bounds.getBoundingClientRect();
      return { left, right };
    },
  });

  return (
    <div data-tooltip-bounds>
      <button
        type="button"
        onMouseEnter={(event) =>
          tooltip.show(event.currentTarget, "Thread options")
        }
      >
        Thread options
      </button>
      {tooltip.tooltipNode}
    </div>
  );
}

function AnchorLifecycleFixture(props: {
  anchorKey?: string;
  anchorLabel?: string;
  anchorStatus?: string;
  anchorTop?: number;
  showAnchor?: boolean;
  tooltipContent?: string;
  unrelatedLabel?: string;
}) {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const tooltipContent = props.tooltipContent ?? "Branch details";
  const updateTooltip = tooltip.update;

  useEffect(() => {
    updateTooltip(tooltipContent);
  }, [tooltipContent, updateTooltip]);

  return (
    <div>
      <div data-testid="anchor-layout" data-anchor-top={props.anchorTop ?? 80}>
        {props.showAnchor === false ? null : (
          <button
            key={props.anchorKey ?? "anchor"}
            aria-label={`Branch status: ${props.anchorStatus ?? "pending"}`}
            className={`branch-status--${props.anchorStatus ?? "pending"}`}
            type="button"
            onMouseEnter={(event) =>
              tooltip.show(event.currentTarget, tooltipContent)
            }
            onMouseLeave={tooltip.hide}
          >
            {props.anchorLabel ?? "agent/lifecycle-tooltip"}
          </button>
        )}
      </div>
      <div data-testid="unrelated-update">{props.unrelatedLabel ?? "Idle"}</div>
      {tooltip.tooltipNode}
    </div>
  );
}

function rectangle(rect: Partial<DOMRect>): DOMRect {
  const x = rect.x ?? rect.left ?? 0;
  const y = rect.y ?? rect.top ?? 0;
  const width = rect.width ?? 0;
  const height = rect.height ?? 0;
  return {
    bottom: rect.bottom ?? y + height,
    height,
    left: rect.left ?? x,
    right: rect.right ?? x + width,
    top: rect.top ?? y,
    width,
    x,
    y,
    toJSON: () => undefined,
  };
}

describe("useViewportTooltip", () => {
  it("keeps a tooltip open when an unrelated pane scrolls", () => {
    render(<TooltipFixture />);

    fireEvent.mouseEnter(screen.getByRole("button"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Branch details");

    fireEvent.scroll(screen.getByTestId("transcript-scroll-region"));

    expect(screen.getByRole("tooltip")).toHaveTextContent("Branch details");
  });

  it("closes a tooltip when the scroll moves its anchor", () => {
    render(<TooltipFixture />);

    fireEvent.mouseEnter(screen.getByRole("button"));
    fireEvent.scroll(screen.getByTestId("sidebar-scroll-region"));

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("cancels a pending tooltip when the window loses focus", () => {
    vi.useFakeTimers();
    render(<DelayedTooltipFixture />);

    fireEvent.mouseEnter(screen.getByRole("button"));
    fireEvent.blur(window);
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows a delayed tooltip when its accessibility relationship is added", async () => {
    vi.useFakeTimers();
    render(<DelayedTooltipFixture />);

    fireEvent.mouseEnter(screen.getByRole("button"));
    await act(async () => {
      vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS);
      await Promise.resolve();
    });

    expect(screen.getByRole("tooltip")).toHaveTextContent("Branch details");
    expect(screen.getByRole("button")).toHaveAttribute(
      "aria-describedby",
      screen.getByRole("tooltip").id,
    );
  });

  it("cancels a pending tooltip when scrolling moves its anchor", () => {
    vi.useFakeTimers();
    render(<DelayedTooltipFixture />);

    fireEvent.mouseEnter(screen.getByRole("button"));
    fireEvent.scroll(screen.getByTestId("sidebar-scroll-region"));
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("keeps a portal tooltip within a local horizontal boundary", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRect(this: HTMLElement) {
        if (this.hasAttribute("data-tooltip-bounds")) {
          return rectangle({ left: 408, right: 708, top: 400, height: 400 });
        }
        if (this.getAttribute("role") === "tooltip") {
          return rectangle({ width: 100, height: 40 });
        }
        if (this.tagName === "BUTTON") {
          return rectangle({ left: 408, top: 600, width: 28, height: 26 });
        }
        return rectangle({});
      },
    );
    vi.stubGlobal("innerWidth", 1200);
    vi.stubGlobal("innerHeight", 800);

    render(<HorizontallyBoundedTooltipFixture />);

    fireEvent.mouseEnter(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveStyle({ left: "408px" });
    });
  });

  it("closes a tooltip when a refresh removes its anchor", async () => {
    const { rerender } = render(<AnchorLifecycleFixture />);

    fireEvent.mouseEnter(screen.getByRole("button"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Branch details");

    rerender(<AnchorLifecycleFixture showAnchor={false} />);

    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });
  });

  it("closes a tooltip when React replaces its anchor", async () => {
    const { rerender } = render(<AnchorLifecycleFixture anchorKey="first" />);

    fireEvent.mouseEnter(screen.getByRole("button"));
    rerender(<AnchorLifecycleFixture anchorKey="second" />);

    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });
  });

  it("closes a tooltip when its connected anchor moves", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRect(this: HTMLElement) {
        if (this.getAttribute("role") === "tooltip") {
          return rectangle({ width: 240, height: 40 });
        }
        if (this.tagName === "BUTTON") {
          const top = Number(
            this.closest("[data-anchor-top]")?.getAttribute("data-anchor-top"),
          );
          return rectangle({ left: 20, top, width: 160, height: 26 });
        }
        return rectangle({});
      },
    );
    vi.stubGlobal("innerWidth", 1200);
    vi.stubGlobal("innerHeight", 800);
    const { rerender } = render(<AnchorLifecycleFixture anchorTop={80} />);

    fireEvent.mouseEnter(screen.getByRole("button"));
    rerender(<AnchorLifecycleFixture anchorTop={180} />);

    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });
  });

  it("keeps a tooltip open through unrelated DOM updates", async () => {
    const { rerender } = render(<AnchorLifecycleFixture unrelatedLabel="Idle" />);

    fireEvent.mouseEnter(screen.getByRole("button"));
    rerender(<AnchorLifecycleFixture unrelatedLabel="Streaming" />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole("tooltip")).toHaveTextContent("Branch details");
  });

  it("keeps a live tooltip open when its anchor attributes and card content update", async () => {
    const { rerender } = render(
      <AnchorLifecycleFixture
        anchorStatus="pending"
        tooltipContent="Checks pending"
      />,
    );

    fireEvent.mouseEnter(screen.getByRole("button"));
    rerender(
      <AnchorLifecycleFixture
        anchorStatus="success"
        tooltipContent="Checks passed"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent("Checks passed");
    });
    expect(screen.getByRole("button")).toHaveAccessibleName(
      "Branch status: success",
    );
    expect(screen.getByRole("button")).toHaveClass("branch-status--success");
  });

  it("closes a tooltip on Escape", () => {
    render(<AnchorLifecycleFixture />);

    fireEvent.mouseEnter(screen.getByRole("button"));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("closes a tooltip when the operator clicks elsewhere", () => {
    render(<AnchorLifecycleFixture />);

    fireEvent.mouseEnter(screen.getByRole("button"));
    fireEvent.pointerDown(screen.getByTestId("unrelated-update"));

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("places the tooltip below its target when above would overlap the app shell boundary", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRect(this: HTMLElement) {
        if (this.classList.contains("app-shell")) {
          return rectangle({ top: 40, width: 1200, height: 760 });
        }
        if (this.getAttribute("role") === "tooltip") {
          return rectangle({ width: 300, height: 60 });
        }
        if (this.tagName === "BUTTON") {
          return rectangle({ left: 20, top: 82, width: 72, height: 26 });
        }
        return rectangle({});
      },
    );

    vi.stubGlobal("innerWidth", 1200);
    vi.stubGlobal("innerHeight", 800);

    render(
      <div className="app-shell">
        <TooltipFixture />
      </div>,
    );

    fireEvent.mouseEnter(screen.getByRole("button"));

    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveStyle({ top: "118px" });
    });
  });

  describe("macOS stoplight gutter", () => {
    // `titleBarStyle: "hiddenInset"` reserves the traffic lights INSIDE the
    // renderer, so `.app-shell` starts at 0 and the shell-boundary clamp lets a
    // tooltip park on top of the close/minimize/zoom buttons and the wordmark
    // beside them. Whichever strip carries the 80px reservation is the real
    // floor.
    function mockStoplightLayout(gutterClass: string) {
      vi.spyOn(
        HTMLElement.prototype,
        "getBoundingClientRect",
      ).mockImplementation(function getBoundingClientRect(this: HTMLElement) {
        if (this.classList.contains("app-shell")) {
          return rectangle({ top: 0, width: 1200, height: 800 });
        }
        if (this.classList.contains(gutterClass)) {
          return rectangle({ top: 0, width: 320, height: 46 });
        }
        if (this.getAttribute("role") === "tooltip") {
          // Short enough that "above the target" lands at y=26 — inside the
          // bare 12px viewport padding, but ON the 46px stoplight strip. That
          // gap is what each case below measures.
          return rectangle({ width: 264, height: 60 });
        }
        if (this.tagName === "BUTTON") {
          return rectangle({ left: 20, top: 96, width: 72, height: 26 });
        }
        return rectangle({});
      });
      vi.stubGlobal("innerWidth", 1200);
      vi.stubGlobal("innerHeight", 800);
    }

    afterEach(() => {
      delete document.documentElement.dataset.platform;
      delete document.documentElement.dataset.fullscreen;
    });

    it("keeps clear of the sidebar masthead, which the app shell does not fence off", async () => {
      document.documentElement.dataset.platform = "darwin";
      mockStoplightLayout("sidebar__masthead");

      render(
        <div className="app-shell">
          <header className="sidebar__masthead" />
          <TooltipFixture />
        </div>,
      );

      fireEvent.mouseEnter(screen.getByRole("button"));

      await waitFor(() => {
        // Above would be 96 − 60 − 10 = 26, which is on the strip. It flips
        // below the 26px-tall target instead of covering the traffic lights.
        expect(screen.getByRole("tooltip")).toHaveStyle({ top: "132px" });
      });
    });

    it("keeps clear of the thread header's cluster when the sidebar is hidden", async () => {
      // `.sidebar` goes `display: none` in that layout, so its masthead
      // measures zero and reserves nothing — the relocated cluster in the
      // thread header holds the stoplight room instead. Reading only the
      // sidebar's strip would put tooltips back on the traffic lights after a
      // single toggle.
      document.documentElement.dataset.platform = "darwin";
      mockStoplightLayout("thread-header__masthead");

      render(
        <div className="app-shell" data-sidebar-hidden="true">
          <header className="sidebar__masthead" />
          <div className="thread-header__masthead" />
          <TooltipFixture />
        </div>,
      );

      fireEvent.mouseEnter(screen.getByRole("button"));

      await waitFor(() => {
        expect(screen.getByRole("tooltip")).toHaveStyle({ top: "132px" });
      });
    });

    it("does not reserve a gutter in fullscreen, where the stoplights are gone", async () => {
      // app.css drops the 80px reservation under `[data-fullscreen="true"]`
      // for the same reason. Flooring anyway would flip a tooltip that had
      // room above onto the content it points at.
      document.documentElement.dataset.platform = "darwin";
      document.documentElement.dataset.fullscreen = "true";
      mockStoplightLayout("sidebar__masthead");

      render(
        <div className="app-shell">
          <header className="sidebar__masthead" />
          <TooltipFixture />
        </div>,
      );

      fireEvent.mouseEnter(screen.getByRole("button"));

      await waitFor(() => {
        // No gutter reserved, so y=26 is free and the tooltip keeps its
        // preferred side rather than being flipped onto the content.
        expect(screen.getByRole("tooltip")).toHaveStyle({ top: "26px" });
      });
    });

    it("does not reserve a gutter off macOS, where no buttons sit in the renderer", async () => {
      document.documentElement.dataset.platform = "linux";
      mockStoplightLayout("sidebar__masthead");

      render(
        <div className="app-shell">
          <header className="sidebar__masthead" />
          <TooltipFixture />
        </div>,
      );

      fireEvent.mouseEnter(screen.getByRole("button"));

      await waitFor(() => {
        expect(screen.getByRole("tooltip")).toHaveStyle({ top: "26px" });
      });
    });
  });
});
