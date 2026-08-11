import { describe, expect, it } from "vitest";
import {
  isStarMapResetViewKey,
  isStarMapTypingTarget,
  resolveStarMapCameraKey,
  STAR_MAP_MAX_FRAME_MS,
  STAR_MAP_PAN_SPEED,
  STAR_MAP_PAN_SPRINT,
  stepStarMapCamera,
  type StarMapCameraKey,
} from "../star-map-keyboard";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  MIN_VISIBLE_FRACTION,
} from "../star-map-view-geometry";

const CANVAS = { width: 4000, height: 3000 };
const VIEWPORT = { width: 1280, height: 800 };

/** One integration step, well clear of the bounds on every side. */
const STEP_MS = 100;
const STEP_PX = (STAR_MAP_PAN_SPEED * STEP_MS) / 1000;

function fly(params: {
  held: StarMapCameraKey[];
  elapsedMs?: number;
  sprint?: boolean;
  view?: { x: number; y: number; scale: number };
}) {
  return stepStarMapCamera({
    view: params.view ?? { x: -500, y: -400, scale: 1 },
    held: new Set(params.held),
    elapsedMs: params.elapsedMs ?? STEP_MS,
    sprint: params.sprint ?? false,
    canvas: CANVAS,
    viewport: VIEWPORT,
  });
}

describe("resolveStarMapCameraKey", () => {
  it("binds movement to physical key POSITION, not the character", () => {
    // The whole point of `code`: these are the WASD positions regardless of
    // what the layout prints on them.
    expect(resolveStarMapCameraKey({ key: "w", code: "KeyW" })).toBe("up");
    expect(resolveStarMapCameraKey({ key: "s", code: "KeyS" })).toBe("down");
    expect(resolveStarMapCameraKey({ key: "a", code: "KeyA" })).toBe("left");
    expect(resolveStarMapCameraKey({ key: "d", code: "KeyD" })).toBe("right");
  });

  it("flies the same physical keys on AZERTY, where they report z/q/s/d", () => {
    // The regression this exists for: binding on `event.key` left every
    // AZERTY operator unable to pan at all, while the hint drew an
    // inverted-T claiming those exact positions.
    expect(resolveStarMapCameraKey({ key: "z", code: "KeyW" })).toBe("up");
    expect(resolveStarMapCameraKey({ key: "q", code: "KeyA" })).toBe("left");
    expect(resolveStarMapCameraKey({ key: "s", code: "KeyS" })).toBe("down");
    expect(resolveStarMapCameraKey({ key: "d", code: "KeyD" })).toBe("right");
  });

  it("flies the same physical keys on Dvorak, where they report ,aoe", () => {
    expect(resolveStarMapCameraKey({ key: ",", code: "KeyW" })).toBe("up");
    expect(resolveStarMapCameraKey({ key: "a", code: "KeyA" })).toBe("left");
    expect(resolveStarMapCameraKey({ key: "o", code: "KeyS" })).toBe("down");
    expect(resolveStarMapCameraKey({ key: "e", code: "KeyD" })).toBe("right");
  });

  it("does NOT fly a letter that merely spells w/a/s/d on another layout", () => {
    // AZERTY's physical Z reports key "w". Panning for it would put "up" on
    // two keys and undo the position binding.
    expect(resolveStarMapCameraKey({ key: "w", code: "KeyZ" })).toBeUndefined();
    expect(resolveStarMapCameraKey({ key: "a", code: "KeyQ" })).toBeUndefined();
  });

  it("maps the arrows and the zoom pair by position too", () => {
    expect(resolveStarMapCameraKey({ key: "ArrowUp", code: "ArrowUp" })).toBe("up");
    expect(resolveStarMapCameraKey({ key: "ArrowLeft", code: "ArrowLeft" })).toBe("left");
    expect(resolveStarMapCameraKey({ key: "=", code: "Equal" })).toBe("zoomIn");
    expect(resolveStarMapCameraKey({ key: "-", code: "Minus" })).toBe("zoomOut");
    expect(resolveStarMapCameraKey({ key: "+", code: "NumpadAdd" })).toBe("zoomIn");
    expect(resolveStarMapCameraKey({ key: "-", code: "NumpadSubtract" })).toBe("zoomOut");
  });

  it("falls back to the character only when an event carries no code", () => {
    // Synthetic events often set `key` alone; the map should still fly.
    expect(resolveStarMapCameraKey({ key: "w" })).toBe("up");
    expect(resolveStarMapCameraKey({ key: "W" })).toBe("up");
    expect(resolveStarMapCameraKey({ key: "ArrowDown" })).toBe("down");
    expect(resolveStarMapCameraKey({ key: "=" })).toBe("zoomIn");
  });

  it("leaves every other key alone", () => {
    for (const code of ["KeyQ", "KeyE", "Escape", "Enter", "Space", "PageUp", "Tab"]) {
      expect(resolveStarMapCameraKey({ key: "x", code })).toBeUndefined();
    }
  });

  it("resets on zero, digit row or numpad", () => {
    expect(isStarMapResetViewKey({ key: "0", code: "Digit0" })).toBe(true);
    expect(isStarMapResetViewKey({ key: "0", code: "Numpad0" })).toBe(true);
    expect(isStarMapResetViewKey({ key: "0" })).toBe(true);
    expect(isStarMapResetViewKey({ key: ")", code: "Digit0" })).toBe(true);
    expect(isStarMapResetViewKey({ key: "1", code: "Digit1" })).toBe(false);
    expect(isStarMapResetViewKey({ key: "o", code: "KeyO" })).toBe(false);
  });
});

describe("isStarMapTypingTarget", () => {
  function target(html: string, selector?: string): Element {
    const host = document.createElement("div");
    host.innerHTML = html;
    const element = selector ? host.querySelector(selector) : host.firstElementChild;
    if (!element) throw new Error("no target");
    return element;
  }

  it("leaves text entry to the field", () => {
    expect(isStarMapTypingTarget(target("<input />"))).toBe(true);
    expect(isStarMapTypingTarget(target("<textarea></textarea>"))).toBe(true);
  });

  it("treats a chat card as a window over the map, not part of it", () => {
    // A chat card is a thread you are reading, so `w` inside one belongs to
    // the card even when the press lands on its chrome rather than a field.
    expect(
      isStarMapTypingTarget(
        target(
          '<div class="star-map-chat-card"><button>Close</button></div>',
          "button",
        ),
      ),
    ).toBe(true);
  });

  it("lets bare sky and map chrome fly the camera", () => {
    expect(isStarMapTypingTarget(target('<div class="star-map__sky"></div>'))).toBe(
      false,
    );
    expect(
      isStarMapTypingTarget(target('<button class="star-map__filter-chip" />')),
    ).toBe(false);
  });
});

describe("stepStarMapCamera", () => {
  it("moves the canvas opposite the camera", () => {
    // D flies the camera right, so the content under it travels left.
    const right = fly({ held: ["right"] });
    expect(right.x).toBe(-500 - STEP_PX);
    expect(right.y).toBe(-400);

    const up = fly({ held: ["up"] });
    expect(up.y).toBe(-400 + STEP_PX);
    expect(up.x).toBe(-500);
  });

  it("normalises diagonals so two keys are not faster than one", () => {
    const straight = fly({ held: ["right"] });
    const diagonal = fly({ held: ["right", "down"] });
    const straightDistance = Math.hypot(straight.x + 500, straight.y + 400);
    const diagonalDistance = Math.hypot(diagonal.x + 500, diagonal.y + 400);
    expect(diagonalDistance).toBeCloseTo(straightDistance, 6);
  });

  it("cancels opposing keys instead of drifting", () => {
    const stalled = fly({ held: ["left", "right"] });
    expect(stalled.x).toBe(-500);
    expect(stalled.y).toBe(-400);
  });

  it("sprints on Shift", () => {
    const cruise = fly({ held: ["right"] });
    const sprint = fly({ held: ["right"], sprint: true });
    expect(-500 - sprint.x).toBeCloseTo((-500 - cruise.x) * STAR_MAP_PAN_SPRINT, 6);
  });

  it("scales the step by elapsed time, not by frame count", () => {
    const half = fly({ held: ["right"], elapsedMs: 50 });
    expect(-500 - half.x).toBeCloseTo(STAR_MAP_PAN_SPEED * 0.05, 6);
  });

  it("caps one step so a backgrounded window does not teleport the map", () => {
    // A window that stops receiving animation frames delivers a multi-second
    // gap as its next `elapsedMs`; integrating it whole would slam the map
    // into its clamp the instant the operator came back.
    const long = fly({ held: ["right"], elapsedMs: 10_000 });
    const capped = fly({ held: ["right"], elapsedMs: STAR_MAP_MAX_FRAME_MS });
    expect(long).toEqual(capped);
  });

  it("does nothing when no key is held", () => {
    const view = { x: -500, y: -400, scale: 1 };
    expect(stepStarMapCamera({
      view,
      held: new Set<StarMapCameraKey>(),
      elapsedMs: 16,
      sprint: false,
      canvas: CANVAS,
      viewport: VIEWPORT,
    })).toBe(view);
  });

  it("zooms about the centre of the window", () => {
    // The keyboard has no pointer to zoom about, so the one fixed point the
    // operator can predict is the middle of the screen.
    const before = { x: -500, y: -400, scale: 1 };
    const after = fly({ held: ["zoomIn"], view: before, elapsedMs: 100 });
    expect(after.scale).toBeGreaterThan(1);

    const centerX = VIEWPORT.width / 2;
    const centerY = VIEWPORT.height / 2;
    // The canvas point under the centre is unchanged by the zoom.
    expect((centerX - after.x) / after.scale).toBeCloseTo(
      (centerX - before.x) / before.scale,
      6,
    );
    expect((centerY - after.y) / after.scale).toBeCloseTo(
      (centerY - before.y) / before.scale,
      6,
    );
  });

  it("parks against the zoom limits rather than drifting past them", () => {
    let view = { x: -500, y: -400, scale: 1 };
    for (let step = 0; step < 200; step += 1) {
      view = fly({ held: ["zoomIn"], view, elapsedMs: 100 });
    }
    expect(view.scale).toBe(MAX_ZOOM);
    // Held at the ceiling the canvas must stop moving too: a ratio computed
    // off the unclamped scale would keep sliding it sideways forever.
    const parked = fly({ held: ["zoomIn"], view, elapsedMs: 100 });
    expect(parked).toEqual(view);

    for (let step = 0; step < 400; step += 1) {
      view = fly({ held: ["zoomOut"], view, elapsedMs: 100 });
    }
    expect(view.scale).toBe(MIN_ZOOM);
  });

  it("keeps a strip of canvas on screen however long a key is held", () => {
    let view = { x: -500, y: -400, scale: 1 };
    for (let step = 0; step < 500; step += 1) {
      view = fly({ held: ["left", "up"], view, elapsedMs: 100 });
    }
    const overlapX = Math.min(VIEWPORT.width, view.x + CANVAS.width * view.scale)
      - Math.max(0, view.x);
    expect(overlapX).toBeGreaterThanOrEqual(VIEWPORT.width * MIN_VISIBLE_FRACTION);
  });
});
