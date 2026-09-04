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
  it("preserves provider next-turn steering delivery", async () => {
    const steerTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-1",
      disposition: "queued" as const,
    }));
    const create = vi.fn();

    await expect(admitSteerTurn({ steerTurn }, { create }, request))
      .resolves.toEqual({
        backend: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
        disposition: "queued",
      });
    expect(create).not.toHaveBeenCalled();
  });

  it("durably holds the fallback when the target is stale", async () => {
    const steerTurn = vi.fn(async () => {
      throw new Error("expected active turn id `turn-1` but found `turn-2`");
    });
    const action = {
      id: "scheduled-held-1",
      backend: "codex" as const,
      threadId: "thread-1",
      kind: "turn" as const,
      origin: "desktop" as const,
      status: "held" as const,
      scheduledFor: 10_000,
      displayText: "Keep going",
      turn: request.fallback?.turn,
      createdAt: 10_000,
      updatedAt: 10_000,
      manualReleaseRequired: true,
    };
    const create = vi.fn(async () => ({ action }));

    await expect(admitSteerTurn({ steerTurn }, { create }, request))
      .resolves.toMatchObject({
        disposition: "held",
        scheduledAction: action,
        holdReason: expect.stringContaining("Review the turn result"),
      });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "thread-1",
        kind: "turn",
        displayText: "Keep going",
        manualReleaseRequired: true,
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
