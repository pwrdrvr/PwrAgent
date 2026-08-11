import { describe, expect, it } from "vitest";
import {
  CHAT_CARD_CASCADE_STEP,
  CHAT_CARD_CASCADE_WRAP,
  CHAT_CARD_CONTEXT_WIDTH,
  CHAT_CARD_DEFAULT_HEIGHT,
  CHAT_CARD_DEFAULT_WIDTH,
  CHAT_CARD_DOCK_GAP,
  CHAT_CARD_MIN_HEIGHT,
  CHAT_CARD_MIN_WIDTH,
  cascadeChatCardRect,
  chatCardEdgeToward,
  clampChatCardRect,
  dockContextRect,
  dockTerminalRect,
  placeChatCardBesideAnchor,
  raiseChatCard,
  resizeChatCardRect,
} from "../star-map-chat-card-geometry";

const viewport = { width: 1440, height: 900 };

describe("cascadeChatCardRect", () => {
  it("opens the first card at the default size", () => {
    const rect = cascadeChatCardRect({ openCardCount: 0, viewport });
    expect(rect.width).toBe(CHAT_CARD_DEFAULT_WIDTH);
    expect(rect.height).toBe(CHAT_CARD_DEFAULT_HEIGHT);
  });

  it("steps each subsequent card diagonally", () => {
    const first = cascadeChatCardRect({ openCardCount: 0, viewport });
    const second = cascadeChatCardRect({ openCardCount: 1, viewport });
    expect(second.left - first.left).toBe(CHAT_CARD_CASCADE_STEP);
    expect(second.top - first.top).toBe(CHAT_CARD_CASCADE_STEP);
  });

  it("wraps back to the origin instead of marching off-screen", () => {
    const first = cascadeChatCardRect({ openCardCount: 0, viewport });
    const wrapped = cascadeChatCardRect({
      openCardCount: CHAT_CARD_CASCADE_WRAP,
      viewport,
    });
    expect(wrapped.left).toBe(first.left);
    expect(wrapped.top).toBe(first.top);
  });

  it("shrinks to fit a viewport smaller than the default card", () => {
    const small = { width: 360, height: 320 };
    const rect = cascadeChatCardRect({ openCardCount: 0, viewport: small });
    expect(rect.width).toBeLessThanOrEqual(small.width);
    expect(rect.height).toBeLessThanOrEqual(small.height);
    expect(rect.width).toBeLessThan(CHAT_CARD_DEFAULT_WIDTH);
    expect(rect.height).toBeLessThan(CHAT_CARD_DEFAULT_HEIGHT);
  });

  it("holds the minimum size rather than shrinking into a viewport slot", () => {
    // A viewport narrower than the minimum cannot be satisfied; the card
    // stays legible and overflows rather than collapsing to a sliver.
    const rect = cascadeChatCardRect({
      openCardCount: 0,
      viewport: { width: 200, height: 180 },
    });
    expect(rect.width).toBe(CHAT_CARD_MIN_WIDTH);
    expect(rect.height).toBe(CHAT_CARD_MIN_HEIGHT);
  });
});

describe("clampChatCardRect", () => {
  it("leaves an on-screen card untouched", () => {
    const rect = { left: 200, top: 150, width: 420, height: 520 };
    expect(clampChatCardRect(rect, viewport)).toEqual(rect);
  });

  it("keeps a sliver on screen when dragged off the right edge", () => {
    const clamped = clampChatCardRect(
      { left: 5_000, top: 100, width: 420, height: 520 },
      viewport,
    );
    expect(clamped.left).toBeLessThan(viewport.width);
    expect(viewport.width - clamped.left).toBeGreaterThan(0);
  });

  it("keeps the title bar reachable when dragged off the left edge", () => {
    const clamped = clampChatCardRect(
      { left: -5_000, top: 100, width: 420, height: 520 },
      viewport,
    );
    expect(clamped.left + 420).toBeGreaterThan(0);
  });

  it("never lets the title bar go above the top edge", () => {
    const clamped = clampChatCardRect(
      { left: 100, top: -400, width: 420, height: 520 },
      viewport,
    );
    expect(clamped.top).toBe(0);
  });

  it("keeps the title bar on screen when dragged past the bottom", () => {
    const clamped = clampChatCardRect(
      { left: 100, top: 5_000, width: 420, height: 520 },
      viewport,
    );
    expect(clamped.top).toBeLessThan(viewport.height);
  });

  it("enforces the minimum size", () => {
    const clamped = clampChatCardRect(
      { left: 10, top: 10, width: 10, height: 10 },
      viewport,
    );
    expect(clamped.width).toBe(CHAT_CARD_MIN_WIDTH);
    expect(clamped.height).toBe(CHAT_CARD_MIN_HEIGHT);
  });
});

describe("resizeChatCardRect", () => {
  it("grows by the drag delta", () => {
    const resized = resizeChatCardRect({
      rect: { left: 100, top: 100, width: 420, height: 520 },
      deltaX: 60,
      deltaY: 40,
      viewport,
    });
    expect(resized.width).toBe(480);
    expect(resized.height).toBe(560);
  });

  it("stops at the minimum size", () => {
    const resized = resizeChatCardRect({
      rect: { left: 100, top: 100, width: 420, height: 520 },
      deltaX: -9_000,
      deltaY: -9_000,
      viewport,
    });
    expect(resized.width).toBe(CHAT_CARD_MIN_WIDTH);
    expect(resized.height).toBe(CHAT_CARD_MIN_HEIGHT);
  });

  it("does not grow past the viewport edge it is anchored against", () => {
    const resized = resizeChatCardRect({
      rect: { left: 800, top: 200, width: 420, height: 300 },
      deltaX: 9_000,
      deltaY: 9_000,
      viewport,
    });
    expect(resized.left + resized.width).toBe(viewport.width);
    expect(resized.top + resized.height).toBe(viewport.height);
  });

  it("keeps the minimum size even when the viewport edge is closer", () => {
    // Anchored near the bottom, the minimum height and the viewport edge
    // conflict; staying legible wins over fitting.
    const resized = resizeChatCardRect({
      rect: { left: 100, top: 700, width: 420, height: 190 },
      deltaX: 0,
      deltaY: 9_000,
      viewport,
    });
    expect(resized.height).toBe(CHAT_CARD_MIN_HEIGHT);
  });

  it("keeps the origin pinned", () => {
    const rect = { left: 240, top: 180, width: 420, height: 520 };
    const resized = resizeChatCardRect({ rect, deltaX: 50, deltaY: 50, viewport });
    expect(resized.left).toBe(rect.left);
    expect(resized.top).toBe(rect.top);
  });
});

describe("raiseChatCard", () => {
  it("moves the card to the end of the order", () => {
    expect(raiseChatCard(["a", "b", "c"], "a")).toEqual(["b", "c", "a"]);
  });

  it("returns the same reference when already on top", () => {
    const order = ["a", "b", "c"];
    expect(raiseChatCard(order, "c")).toBe(order);
  });

  it("appends an unknown key", () => {
    expect(raiseChatCard(["a"], "b")).toEqual(["a", "b"]);
  });
});

describe("placeChatCardBesideAnchor", () => {
  const bounds = { width: 4000, height: 3000 };
  const anchor = { x: 1000, y: 900, width: 200, height: 120 };

  it("opens to the right of the thread card it belongs to", () => {
    const rect = placeChatCardBesideAnchor({ anchor, bounds, occupied: [] });
    expect(rect.left).toBeGreaterThan(anchor.x + anchor.width);
    // Vertically overlapping the anchor, so the pairing reads at a glance.
    expect(rect.top).toBeLessThan(anchor.y + anchor.height);
    expect(rect.top + rect.height).toBeGreaterThan(anchor.y);
  });

  it("opens to the left when the right would leave the canvas", () => {
    const rect = placeChatCardBesideAnchor({
      anchor: { ...anchor, x: bounds.width - 260 },
      bounds,
      occupied: [],
    });
    expect(rect.left + rect.width).toBeLessThanOrEqual(bounds.width);
  });

  it("stays beside its thread even when that overlaps other cards", () => {
    // Being next to the thread it belongs to beats being tidy. An overlap
    // is the operator's to resolve by dragging, so placement must not go
    // hunting for free space and land the card somewhere unrelated.
    const crowd = Array.from({ length: 4 }, (unused, index) => ({
      left: anchor.x + 200 + index * 40,
      top: anchor.y + index * 40,
      width: 420,
      height: 520,
    }));
    const rect = placeChatCardBesideAnchor({ anchor, bounds, occupied: crowd });
    expect(rect.left).toBeLessThan(anchor.x + 900);
    expect(Math.abs(rect.top - anchor.y)).toBeLessThan(600);
  });

  it("offsets a card opened at the exact same spot as another", () => {
    // Perfectly stacked cards hide the older one completely, which reads
    // as the click having done nothing.
    const first = placeChatCardBesideAnchor({ anchor, bounds, occupied: [] });
    const second = placeChatCardBesideAnchor({
      anchor,
      bounds,
      occupied: [first],
    });
    expect(second.left === first.left && second.top === first.top).toBe(false);
  });

  it("keeps the card inside the canvas", () => {
    const rect = placeChatCardBesideAnchor({
      anchor: { x: 0, y: 0, width: 200, height: 120 },
      bounds,
      occupied: [],
    });
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.left + rect.width).toBeLessThanOrEqual(bounds.width);
  });
});

describe("chatCardEdgeToward", () => {
  const rect = { left: 100, top: 100, width: 200, height: 100 };

  it("stops on the border facing the thread card", () => {
    const right = chatCardEdgeToward(rect, { x: 1000, y: 150 });
    expect(right.x).toBeCloseTo(300, 5);
    const above = chatCardEdgeToward(rect, { x: 200, y: -500 });
    expect(above.y).toBeCloseTo(100, 5);
  });

  it("never reports a point outside the card", () => {
    for (const target of [
      { x: 0, y: 0 },
      { x: 5000, y: 5000 },
      { x: 200, y: 5000 },
    ]) {
      const point = chatCardEdgeToward(rect, target);
      expect(point.x).toBeGreaterThanOrEqual(rect.left - 0.001);
      expect(point.x).toBeLessThanOrEqual(rect.left + rect.width + 0.001);
      expect(point.y).toBeGreaterThanOrEqual(rect.top - 0.001);
      expect(point.y).toBeLessThanOrEqual(rect.top + rect.height + 0.001);
    }
  });

  it("degenerates to the centre when the target sits on it", () => {
    expect(chatCardEdgeToward(rect, { x: 200, y: 150 })).toEqual({
      x: 200,
      y: 150,
    });
  });
});

describe("satellite docking", () => {
  const host = { left: 500, top: 400, width: 420, height: 520 };

  it("docks the context card on the host's right edge, matching height", () => {
    const rect = dockContextRect(host);
    expect(rect.left).toBe(host.left + host.width + CHAT_CARD_DOCK_GAP);
    expect(rect.top).toBe(host.top);
    expect(rect.height).toBe(host.height);
    expect(rect.width).toBe(CHAT_CARD_CONTEXT_WIDTH);
  });

  it("docks the terminal under the host at the host's width", () => {
    const rect = dockTerminalRect(host);
    expect(rect.left).toBe(host.left);
    expect(rect.top).toBe(host.top + host.height + CHAT_CARD_DOCK_GAP);
    expect(rect.width).toBe(host.width);
  });

  it("spans the whole group when the context card is open", () => {
    const rect = dockTerminalRect(host, { contextOpen: true });
    expect(rect.width).toBe(
      host.width + CHAT_CARD_DOCK_GAP + CHAT_CARD_CONTEXT_WIDTH,
    );
  });

  it("derives from the host, so a moved host moves the whole group", () => {
    const moved = { ...host, left: host.left + 300, top: host.top - 120 };
    const before = dockContextRect(host);
    const after = dockContextRect(moved);
    expect(after.left - before.left).toBe(300);
    expect(after.top - before.top).toBe(-120);
  });
});
