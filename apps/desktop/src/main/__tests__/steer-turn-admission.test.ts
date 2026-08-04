import { describe, expect, it, vi } from "vitest";
import type { SteerTurnRequest } from "@pwragent/shared";
import { admitSteerTurn } from "../scheduled-actions/steer-turn-admission";

const request: SteerTurnRequest = {
  backend: "codex",
  threadId: "thread-1",
  expectedTurnId: "turn-1",
  requestId: "steer-1",
  input: [{ type: "text", text: "Keep going" }],
  fallback: {
    displayText: "Keep going",
    turn: { input: [{ type: "text", text: "Keep going" }] },
  },
};

describe("admitSteerTurn", () => {
  it("durably schedules the accepted fallback when the target is stale", async () => {
    const steerTurn = vi.fn(async () => {
      throw new Error("expected active turn id `turn-1` but found `turn-2`");
    });
    const action = {
      id: "scheduled-1",
      backend: "codex" as const,
      threadId: "thread-1",
      kind: "turn" as const,
      origin: "desktop" as const,
      status: "scheduled" as const,
      scheduledFor: 10_000,
      displayText: "Keep going",
      turn: request.fallback?.turn,
      createdAt: 10_000,
      updatedAt: 10_000,
    };
    const create = vi.fn(async () => ({ action }));

    await expect(admitSteerTurn({ steerTurn }, { create }, request))
      .resolves.toMatchObject({
        disposition: "scheduled",
        scheduledAction: action,
      });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "thread-1",
        kind: "turn",
        displayText: "Keep going",
      }),
      { id: expect.stringMatching(/^scheduled-action:steer:/) },
    );
  });

  it("does not schedule fallback for unrelated steering failures", async () => {
    const steerTurn = vi.fn(async () => {
      throw new Error("backend disconnected");
    });
    const create = vi.fn();

    await expect(admitSteerTurn({ steerTurn }, { create }, request))
      .rejects.toThrow("backend disconnected");
    expect(create).not.toHaveBeenCalled();
  });
});
