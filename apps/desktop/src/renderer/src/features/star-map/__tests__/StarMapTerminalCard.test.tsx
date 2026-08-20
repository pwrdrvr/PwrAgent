import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import {
  clampTerminalCardHeight,
  StarMapTerminalCard,
  STAR_MAP_SATELLITE_BAR_HEIGHT,
  STAR_MAP_TERMINAL_CARD_HEIGHT,
  STAR_MAP_TERMINAL_CARD_MIN_HEIGHT,
  STAR_MAP_TERMINAL_GRIP_HEIGHT,
  terminalCardMaxHeight,
} from "../StarMapSatelliteCards";

// The card lazy-loads the real pane to keep xterm out of the map's bundle;
// nothing here is about the pane's internals, only about the chrome the
// card puts around it.
vi.mock("../../thread-detail/IntegratedTerminal", () => ({
  IntegratedTerminal: (props: { chrome?: string; height: number }) => (
    <div
      data-testid="terminal-pane"
      data-chrome={props.chrome}
      data-height={props.height}
    />
  ),
}));

const RECT = { left: 40, top: 600, width: 420, height: 300 };

function thread(): NavigationThreadSummary {
  return {
    id: "t-local",
    title: "Local work",
    titleSource: "generated",
    linkedDirectories: [],
    source: "codex",
    inbox: { inInbox: false },
    updatedAt: 1,
  } as unknown as NavigationThreadSummary;
}

function renderCard(
  overrides: { onHeightChange?: (height: number) => void } = {},
) {
  return render(
    <StarMapTerminalCard
      onClose={() => undefined}
      onHeightChange={overrides.onHeightChange ?? (() => undefined)}
      rect={RECT}
      scale={1}
      thread={thread()}
      threadKey="codex:t-local"
      zIndex={10}
    />,
  );
}

describe("StarMapTerminalCard", () => {
  it("leaves exactly one close button on the card", async () => {
    renderCard();

    expect(
      screen.getAllByRole("button", { name: /close terminal/i }),
    ).toHaveLength(1);
    expect(await screen.findByTestId("terminal-pane")).toHaveAttribute(
      "data-chrome",
      "hosted",
    );
  });

  it("gives the pane the card minus its own chrome", async () => {
    renderCard();

    expect(await screen.findByTestId("terminal-pane")).toHaveAttribute(
      "data-height",
      String(
        RECT.height
          - STAR_MAP_SATELLITE_BAR_HEIGHT
          - STAR_MAP_TERMINAL_GRIP_HEIGHT,
      ),
    );
  });

  // Dragging the bottom edge down grows the card. The pane's own handle sat
  // under the title bar and grew the card downward when dragged up.
  it("grows the card when the bottom grip is dragged down", () => {
    const onHeightChange = vi.fn();
    renderCard({ onHeightChange });

    const grip = screen.getByRole("separator", { name: /resize terminal/i });
    fireEvent.pointerDown(grip, { button: 0, clientY: 900 });
    fireEvent.pointerMove(window, { clientY: 960 });

    expect(onHeightChange).toHaveBeenLastCalledWith(RECT.height + 60);

    fireEvent.pointerUp(window, { clientY: 960 });
    onHeightChange.mockClear();
    fireEvent.pointerMove(window, { clientY: 1200 });
    expect(onHeightChange).not.toHaveBeenCalled();
  });

  it("converts screen pixels to card pixels at the current zoom", () => {
    const onHeightChange = vi.fn();
    render(
      <StarMapTerminalCard
        onClose={() => undefined}
        onHeightChange={onHeightChange}
        rect={RECT}
        scale={0.5}
        thread={thread()}
        threadKey="codex:t-local"
        zIndex={10}
      />,
    );

    const grip = screen.getByRole("separator", { name: /resize terminal/i });
    fireEvent.pointerDown(grip, { button: 0, clientY: 900 });
    fireEvent.pointerMove(window, { clientY: 930 });

    expect(onHeightChange).toHaveBeenLastCalledWith(RECT.height + 60);
  });

  it("resizes from the keyboard, down to grow", () => {
    const onHeightChange = vi.fn();
    renderCard({ onHeightChange });

    const grip = screen.getByRole("separator", { name: /resize terminal/i });
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(onHeightChange).toHaveBeenLastCalledWith(RECT.height + 16);

    fireEvent.keyDown(grip, { key: "ArrowUp" });
    expect(onHeightChange).toHaveBeenLastCalledWith(RECT.height - 16);
  });

  it("never shrinks the card below its chrome plus a usable terminal", () => {
    expect(clampTerminalCardHeight(0)).toBe(STAR_MAP_TERMINAL_CARD_MIN_HEIGHT);
  });

  // A clamp that can hand back an out-of-range number is worse than useless
  // to its next caller, so the non-finite fallback takes the bounds too.
  //
  // The window has to be SHORT for this to bite: at jsdom's default 768 the
  // ceiling is 522 and the unclamped fallback of 300 sits under it, so the
  // assertion would agree with the bug. At 400 the ceiling is 272.
  it("keeps even its fallback inside the bounds it enforces", () => {
    const realHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 400,
    });
    try {
      expect(terminalCardMaxHeight()).toBeLessThan(
        STAR_MAP_TERMINAL_CARD_HEIGHT,
      );
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
        const clamped = clampTerminalCardHeight(value);
        expect(clamped).toBeGreaterThanOrEqual(
          STAR_MAP_TERMINAL_CARD_MIN_HEIGHT,
        );
        expect(clamped).toBeLessThanOrEqual(terminalCardMaxHeight());
      }
    } finally {
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: realHeight,
      });
    }
  });
});
