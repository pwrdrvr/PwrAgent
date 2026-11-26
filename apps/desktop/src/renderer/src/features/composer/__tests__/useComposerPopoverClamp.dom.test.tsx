import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useComposerPopoverClamp } from "../useComposerPopoverClamp";

type LayoutState = {
  row: { left: number; right: number };
  triggerRight: number;
  menuWidth: number;
};

function rect(left: number, right: number, top = 600, height = 60): DOMRect {
  return {
    left,
    right,
    top,
    bottom: top + height,
    width: right - left,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function readTranslateX(element: HTMLElement): number {
  const match = /translateX\((-?\d+(?:\.\d+)?)px\)/.exec(element.style.transform);
  return match ? Number(match[1]) : 0;
}

function mockLayout(state: LayoutState) {
  return vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function getBoundingClientRect(this: HTMLElement) {
      if (this.classList.contains("composer__setup")) {
        return rect(state.row.left, state.row.right);
      }
      if (this.dataset.testid === "popover-menu") {
        const widthLimit = this.style.maxWidth ? Number.parseFloat(this.style.maxWidth) : undefined;
        const width = widthLimit !== undefined ? Math.min(state.menuWidth, widthLimit) : state.menuWidth;
        const shift = readTranslateX(this);
        const right = state.triggerRight + shift;
        return rect(right - width, right, 320, 260);
      }
      return rect(0, 0, 0, 0);
    });
}

function Harness({
  open = true,
  extraSibling = false,
}: {
  open?: boolean;
  extraSibling?: boolean;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const menuStyle = useComposerPopoverClamp(open, menuRef);
  return (
    <div className="composer__setup">
      <fieldset className="composer__pending-controls">
        <div data-testid="sibling-chip">Model pill</div>
        {extraSibling ? <div data-testid="late-chip">Access mode</div> : null}
        <div className="composer-thread-options">
          <button type="button">Thread options</button>
          {open ? (
            <div data-testid="popover-menu" ref={menuRef} role="menu" style={menuStyle}>
              Job Monitors
            </div>
          ) : null}
        </div>
      </fieldset>
      <div className="composer__application-actions">
        <button type="button">Terminal</button>
      </div>
      <div className="composer__actions">
        <button type="button">Send</button>
      </div>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useComposerPopoverClamp same-height wrap behavior", () => {
  it("re-clamps when a sibling chip resizes and wraps the trigger onto row 2 without changing .composer__setup's box", () => {
    const observers: Array<{
      callback: () => void;
      targets: Set<Element>;
    }> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class MockResizeObserver {
        readonly entry: { callback: () => void; targets: Set<Element> };
        constructor(callback: () => void) {
          this.entry = { callback, targets: new Set() };
          observers.push(this.entry);
        }
        observe(target: Element): void {
          this.entry.targets.add(target);
        }
        unobserve(target: Element): void {
          this.entry.targets.delete(target);
        }
        disconnect(): void {
          this.entry.targets.clear();
        }
      },
    );
    vi.stubGlobal("innerWidth", 1024);

    // Windows 1024x720 pane: .composer__setup spans 366..704 and already holds
    // two rows because Terminal + Send sit on row 2. Initially Thread options
    // sits at the right end of row 1 (right = 704), so the 288px menu fits
    // (416..704) with shift = 0.
    const layout: LayoutState = {
      row: { left: 366, right: 704 },
      triggerRight: 704,
      menuWidth: 288,
    };
    mockLayout(layout);

    render(<Harness open />);
    const menu = screen.getByRole("menu");
    expect(readTranslateX(menu)).toBe(0);

    // Sibling chip widens and wraps Thread options onto row 2 (right = 392)
    // alongside Terminal + Send. .composer__setup's own box does not resize;
    // only the sibling chip's ResizeObserver fires.
    const siblingChip = screen.getByTestId("sibling-chip");
    layout.triggerRight = 392;
    act(() => {
      for (const observer of observers) {
        if (observer.targets.has(siblingChip)) {
          observer.callback();
        }
      }
    });

    expect(menu).toHaveStyle({ transform: "translateX(262px)" });
    const clamped = menu.getBoundingClientRect();
    expect(clamped.left).toBeGreaterThanOrEqual(layout.row.left);
    expect(clamped.right).toBeLessThanOrEqual(layout.row.right);
  });

  it("re-clamps when a late-mounting chip inside .composer__pending-controls wraps the trigger onto row 2", async () => {
    vi.stubGlobal("innerWidth", 1024);
    const layout: LayoutState = {
      row: { left: 366, right: 704 },
      triggerRight: 704,
      menuWidth: 288,
    };
    mockLayout(layout);

    const { rerender } = render(<Harness open extraSibling={false} />);
    const menu = screen.getByRole("menu");
    expect(readTranslateX(menu)).toBe(0);

    // Late-arriving sibling chip mounts into the display:contents fieldset and
    // pushes the trigger onto row 2 with no ResizeObserver event on .composer__setup.
    layout.triggerRight = 392;
    rerender(<Harness open extraSibling />);

    await waitFor(() => {
      expect(menu).toHaveStyle({ transform: "translateX(262px)" });
    });
    const clamped = menu.getBoundingClientRect();
    expect(clamped.left).toBe(366);
    expect(clamped.right).toBe(654);
  });

  it("does not double-shift if ResizeObserver fires synchronously before React commits the first shift", () => {
    let fireAll: (() => void) | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class MockResizeObserver {
        constructor(callback: () => void) {
          fireAll = callback;
        }
        observe(): void {
          // Immediately trigger a second clamp while the DOM still holds shift = 0.
          fireAll?.();
        }
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    vi.stubGlobal("innerWidth", 1024);

    const layout: LayoutState = {
      row: { left: 366, right: 704 },
      triggerRight: 392,
      menuWidth: 288,
    };
    mockLayout(layout);

    render(<Harness open />);
    expect(screen.getByRole("menu")).toHaveStyle({ transform: "translateX(262px)" });
  });
});
