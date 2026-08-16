import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { StarMapScreen } from "../StarMapScreen";
import { STAR_MAP_PAN_SPEED } from "../star-map-keyboard";

/**
 * The map flies from the keyboard.
 *
 * The pointer gestures are complete on their own, which is exactly why this
 * needed proving end to end rather than only in the pure step function: the
 * camera writes the canvas transform by hand while keys are held and only
 * commits to React state on release, so "it moved" and "it stayed moved"
 * are two different claims.
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

function thread(id: string): NavigationThreadSummary {
  return {
    id,
    title: `Thread ${id}`,
    titleSource: "generated",
    linkedDirectories: [
      { id: `${id}-dir`, label: "PwrSnap", path: "/repos/PwrSnap", kind: "local" },
    ],
    source: "codex",
    inbox: { inInbox: true, reason: "updated-since-seen" },
    updatedAt: 100,
  } as unknown as NavigationThreadSummary;
}

function canvas(): HTMLElement {
  const element = document.querySelector(".star-map__canvas");
  if (!element) throw new Error("canvas not found");
  return element as HTMLElement;
}

function layer(): HTMLElement {
  const element = document.querySelector(".star-map");
  if (!element) throw new Error("layer not found");
  return element as HTMLElement;
}

function readTransform(): { x: number; y: number; scale: number } {
  const raw = canvas().style.transform;
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(
    raw,
  );
  if (!match) throw new Error(`unparsable transform: ${raw}`);
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
}

/** Let one animation frame run, so the camera integrates a step. */
async function flushFrame() {
  await act(async () => {
    await new Promise((resolve) => {
      requestAnimationFrame(() => resolve(undefined));
    });
  });
}

function controlAnimationFrames() {
  let currentTime = 0;
  let nextFrameId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const request = vi
    .spyOn(globalThis, "requestAnimationFrame")
    .mockImplementation((callback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      callbacks.set(frameId, callback);
      return frameId;
    });
  const cancel = vi
    .spyOn(globalThis, "cancelAnimationFrame")
    .mockImplementation((frameId) => {
      callbacks.delete(frameId);
    });

  return {
    flush: async (elapsedMs = 1000 / 60) => {
      currentTime += elapsedMs;
      const pending = [...callbacks.values()];
      callbacks.clear();
      if (pending.length !== 1) {
        throw new Error(`Expected one animation frame, received ${pending.length}.`);
      }
      await act(async () => {
        pending[0](currentTime);
      });
    },
    restore: () => {
      request.mockRestore();
      cancel.mockRestore();
    },
  };
}

async function openMap() {
  const rendered = render(
    <StarMapScreen
      desktopApi={buildDesktopApi()}
      localThreads={Array.from({ length: 9 }, (_, index) => thread(`t${index}`))}
      sessionKeys={{}}
      localInstanceLabel="Mac-Mini-M4"
      onOpenLocalThread={() => undefined}
      onFocusLocalInstance={() => undefined}
    />,
  );
  await waitFor(() => {
    expect(screen.getByRole("button", { name: /Open this instance/ })).toBeTruthy();
  });
  return rendered;
}

describe("star map keyboard camera", () => {
  afterEach(() => {
    window.localStorage.removeItem("pwragent.starMap.viewPreferences");
    window.localStorage.removeItem("pwragent.starMap.filterSelection");
  });

  it("flies the camera while a direction key is held", async () => {
    await openMap();
    const before = readTransform();

    fireEvent.keyDown(layer(), { key: "d", code: "KeyD" });
    await flushFrame();

    // D flies the camera right, so the canvas beneath travels left.
    expect(readTransform().x).toBeLessThan(before.x);
    expect(readTransform().y).toBe(before.y);

    fireEvent.keyDown(layer(), { key: "w", code: "KeyW" });
    await flushFrame();
    expect(readTransform().y).toBeGreaterThan(before.y);

    fireEvent.keyUp(window, { key: "d", code: "KeyD" });
    fireEvent.keyUp(window, { key: "w", code: "KeyW" });
    await flushFrame();
  });

  it("stops when the key comes up, and commits where it landed", async () => {
    await openMap();
    const before = readTransform();

    fireEvent.keyDown(layer(), { key: "a", code: "KeyA" });
    await flushFrame();
    fireEvent.keyUp(window, { key: "a", code: "KeyA" });
    // The frame after the release lands the flight and hands the view back
    // to React.
    await flushFrame();
    const landed = readTransform();
    expect(landed.x).toBeGreaterThan(before.x);

    // Nothing moves once the key is up, however many frames go by.
    await flushFrame();
    await flushFrame();
    expect(readTransform()).toEqual(landed);

    // The proof that the flight was COMMITTED rather than only painted: a
    // pointer drag reads the view from React state, so it must build on
    // where the keyboard left off rather than on the pre-flight value.
    const viewport = document.querySelector(".star-map__viewport")!;
    fireEvent.pointerDown(viewport, { button: 0, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(window, { clientX: 460, clientY: 400 });
    fireEvent.pointerUp(window, { clientX: 460, clientY: 400 });
    expect(readTransform().x).toBeCloseTo(landed.x - 40, 6);
  });

  it("zooms about the centre of the window on the minus and equals keys", async () => {
    await openMap();
    const before = readTransform();

    fireEvent.keyDown(layer(), { key: "=", code: "Equal" });
    await flushFrame();
    const zoomed = readTransform();
    expect(zoomed.scale).toBeGreaterThan(before.scale);
    // Same canvas point stays under the middle of the window.
    expect((640 - zoomed.x) / zoomed.scale).toBeCloseTo((640 - before.x) / before.scale, 4);

    fireEvent.keyUp(window, { key: "=", code: "Equal" });
    await flushFrame();

    fireEvent.keyDown(layer(), { key: "-", code: "Minus" });
    await flushFrame();
    expect(readTransform().scale).toBeLessThan(zoomed.scale);
    fireEvent.keyUp(window, { key: "-", code: "Minus" });
    await flushFrame();
  });

  it("puts the map back where it opens on 0", async () => {
    await openMap();
    const opened = readTransform();

    fireEvent.keyDown(layer(), { key: "d", code: "KeyD" });
    await flushFrame();
    fireEvent.keyUp(window, { key: "d", code: "KeyD" });
    await flushFrame();
    expect(readTransform().x).not.toBe(opened.x);

    fireEvent.keyDown(layer(), { key: "0", code: "Digit0" });
    expect(readTransform()).toEqual(opened);
  });

  it("resets the view on 0 even while a direction key is held", async () => {
    // Regression: the camera used to keep a private copy of the view, so a
    // reset mid-flight was overwritten by the next animation frame — and,
    // because React's last-rendered transform still matched, it did not even
    // repaint. Pressing 0 did nothing at all.
    await openMap();
    const opened = readTransform();
    const frames = controlAnimationFrames();

    try {
      fireEvent.keyDown(layer(), { key: "d", code: "KeyD" });
      await frames.flush();
      await frames.flush();
      expect(readTransform().x).toBeLessThan(opened.x);

      fireEvent.keyDown(layer(), { key: "0", code: "Digit0" });
      expect(readTransform()).toEqual(opened);

      // Still flying, so the NEXT frame continues from the reset position
      // rather than teleporting back to where the flight had reached.
      await frames.flush();
      const afterReset = readTransform();
      expect(afterReset.x).toBeCloseTo(
        opened.x - STAR_MAP_PAN_SPEED / 60,
        6,
      );

      fireEvent.keyUp(window, { key: "d", code: "KeyD" });
      await frames.flush();
    } finally {
      frames.restore();
    }
  });

  it("composes a trackpad pinch with an in-flight keyboard pan", async () => {
    // Regression: the wheel handler read React state, which is frozen at the
    // last landing while the keyboard is flying, so a pinch was computed
    // from a stale base and then discarded by the next frame.
    await openMap();
    const viewport = document.querySelector(".star-map__viewport")!;

    fireEvent.keyDown(layer(), { key: "d", code: "KeyD" });
    await flushFrame();
    const flying = readTransform();

    fireEvent.wheel(viewport, { deltaY: -120, ctrlKey: true, clientX: 640, clientY: 400 });
    const pinched = readTransform();
    expect(pinched.scale).toBeGreaterThan(flying.scale);

    // The flight carries on from the zoomed view: scale is kept, and the pan
    // keeps going in the same direction.
    await flushFrame();
    const after = readTransform();
    expect(after.scale).toBe(pinched.scale);
    expect(after.x).toBeLessThan(pinched.x);

    fireEvent.keyUp(window, { key: "d", code: "KeyD" });
    await flushFrame();
    expect(readTransform().scale).toBe(pinched.scale);
  });

  it("keeps flying when focus is on nothing, not just on the layer", async () => {
    // Closing the portaled intake dialog drops focus on document.body, and
    // the hint stays on screen advertising keys that then did nothing.
    await openMap();
    (document.activeElement as HTMLElement | null)?.blur();
    const before = readTransform();

    fireEvent.keyDown(document.body, { key: "d", code: "KeyD" });
    await flushFrame();

    expect(readTransform().x).toBeLessThan(before.x);
    fireEvent.keyUp(window, { key: "d", code: "KeyD" });
    await flushFrame();
  });

  it("leaves modified keystrokes to the app and the OS", async () => {
    // Cmd-W is "close window", not "fly up", and Ctrl-D is not a pan.
    await openMap();
    const before = readTransform();

    fireEvent.keyDown(layer(), { key: "w", code: "KeyW", metaKey: true });
    fireEvent.keyDown(layer(), { key: "d", code: "KeyD", ctrlKey: true });
    await flushFrame();

    expect(readTransform()).toEqual(before);
  });

  it("releases every key when the window loses focus", async () => {
    // Cmd-Tab away mid-flight and no keyup ever arrives; without this the
    // camera flies on with nothing holding it.
    await openMap();

    fireEvent.keyDown(layer(), { key: "d", code: "KeyD" });
    await flushFrame();
    const flying = readTransform();

    fireEvent.blur(window);
    await flushFrame();
    const released = readTransform();
    await flushFrame();

    expect(readTransform()).toEqual(released);
    expect(released.x).toBeLessThanOrEqual(flying.x);
  });

  it("shows the keys on the map, lit under the ones being held", async () => {
    await openMap();
    const hint = document.querySelector(".star-map__key-hint");
    expect(hint).toBeTruthy();
    expect(hint?.querySelectorAll(".star-map__key").length).toBe(8);
    expect(document.querySelectorAll(".star-map__key.is-held").length).toBe(0);

    // Asserted synchronously, not through `waitFor`: the held set is React
    // state written straight from the key handler, so if it needed waiting
    // for, that would itself be the bug.
    fireEvent.keyDown(layer(), { key: "a", code: "KeyA" });
    expect(document.querySelector(".star-map__key--left.is-held")).toBeTruthy();

    fireEvent.keyUp(window, { key: "a", code: "KeyA" });
    expect(document.querySelectorAll(".star-map__key.is-held").length).toBe(0);
    await flushFrame();
  });

});
