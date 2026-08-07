import { describe, expect, it } from "vitest";
import {
  CHAT_CARD_CASCADE_STEP,
  CHAT_CARD_CASCADE_WRAP,
  CHAT_CARD_DEFAULT_HEIGHT,
  CHAT_CARD_DEFAULT_WIDTH,
  CHAT_CARD_MIN_HEIGHT,
  CHAT_CARD_MIN_WIDTH,
  cascadeChatCardRect,
  clampChatCardRect,
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
