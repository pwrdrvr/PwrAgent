import { describe, expect, it } from "vitest";
import { pointerDeltaToCanvas } from "../star-map-layout";

/**
 * Dragging a card while zoomed in moved the card further than the mouse,
 * so it slid out from under the cursor mid-drag (the pointer ended up over
 * the canvas, and the cursor flipped from the card's pointer back to the
 * canvas grab hand). The delta was in screen pixels; the card lives inside
 * a `scale()`-transformed canvas.
 */
describe("pointerDeltaToCanvas", () => {
  it("passes the delta through unscaled at 1x", () => {
    expect(pointerDeltaToCanvas({ dx: 40, dy: -25, scale: 1 })).toEqual({
      dx: 40,
      dy: -25,
    });
  });

  it("shrinks the delta when zoomed IN so the card tracks the pointer", () => {
    // At 2x, 40 screen px is only 20 canvas px — applying 40 would render
    // as 80 on screen, which is the reported "card outruns the mouse".
    expect(pointerDeltaToCanvas({ dx: 40, dy: 60, scale: 2 })).toEqual({
      dx: 20,
      dy: 30,
    });
  });

  it("grows the delta when zoomed OUT", () => {
    expect(pointerDeltaToCanvas({ dx: 25, dy: -10, scale: 0.5 })).toEqual({
      dx: 50,
      dy: -20,
    });
  });

  it("keeps the card exactly under the pointer at any scale", () => {
    // The invariant the bug broke: canvas movement, rendered back through
    // the same scale, must equal the pointer movement.
    for (const scale of [0.35, 0.5, 1, 1.4, 2]) {
      const moved = pointerDeltaToCanvas({ dx: 120, dy: -75, scale });
      expect(moved.dx * scale).toBeCloseTo(120, 6);
      expect(moved.dy * scale).toBeCloseTo(-75, 6);
    }
  });

  it("treats a nonsense scale as unscaled rather than dividing by zero", () => {
    expect(pointerDeltaToCanvas({ dx: 10, dy: 10, scale: 0 })).toEqual({
      dx: 10,
      dy: 10,
    });
  });
});

describe("card drag under zoom", () => {
  it("moves the card by the pointer distance in canvas space", async () => {
    const { render, screen, fireEvent, waitFor, act } = await import(
      "@testing-library/react"
    );
    const { StarMapScreen } = await import("../StarMapScreen");
    const { vi } = await import("vitest");

    window.localStorage.setItem(
      "pwragent.starMap.viewPreferences",
      JSON.stringify({ layout: "orbit" }),
    );
    try {
      const desktopApi = {
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
      } as never;

      render(
        <StarMapScreen
          desktopApi={desktopApi}
          localThreads={[
            {
              id: "t1",
              title: "Thread t1",
              titleSource: "generated",
              linkedDirectories: [],
              source: "codex",
              inbox: { inInbox: true, reason: "updated-since-seen" },
              updatedAt: 100,
            } as never,
          ]}
          sessionKeys={{}}
          localInstanceLabel="Mac-Mini-M4"
          floating={false}
          onClose={() => undefined}
          onOpenLocalThread={() => undefined}
          onFocusLocalInstance={() => undefined}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /Open this instance/ }),
        ).toBeTruthy();
      });

      const shell = document.querySelector(".star-map-card-shell") as HTMLElement;
      expect(shell).not.toBeNull();
      const startLeft = Number.parseFloat(shell.style.left);

      // Zoom in, then drag by a known screen distance.
      const viewport = document.querySelector(".star-map__viewport")!;
      fireEvent.wheel(viewport, {
        deltaY: -240,
        ctrlKey: true,
        clientX: 400,
        clientY: 300,
      });
      const canvas = document.querySelector(".star-map__canvas") as HTMLElement;
      const scale = Number(
        /scale\(([\d.]+)\)/.exec(canvas.style.transform)?.[1] ?? "1",
      );
      expect(scale).toBeGreaterThan(1);

      const SCREEN_DX = 120;
      fireEvent.pointerDown(shell, { button: 0, clientX: 500, clientY: 400 });
      await act(async () => {
        fireEvent.pointerMove(window, {
          clientX: 500 + SCREEN_DX,
          clientY: 400,
        });
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      });

      // The card must travel SCREEN_DX / scale in canvas units so that,
      // rendered back through the same scale, it lands exactly under the
      // pointer. Applying the raw screen delta moved it `scale` times too
      // far — the card outrunning the mouse.
      const movedBy = Number.parseFloat(shell.style.left) - startLeft;
      expect(movedBy).toBeCloseTo(SCREEN_DX / scale, 1);
      fireEvent.pointerUp(window, { clientX: 500 + SCREEN_DX, clientY: 400 });
    } finally {
      window.localStorage.removeItem("pwragent.starMap.viewPreferences");
    }
  });
});
