import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { CreateScheduledThreadActionRequest, SteerTurnRequest } from "@pwragent/shared";
import { admitSteerTurn } from "../scheduled-actions/steer-turn-admission";

describe("native review steer admission", () => {
  // A steer refused before provider delivery must become one automatic
  // follow-up with the operator's original input and turn settings.
  it("queues every native-review rejection without requiring manual release", async () => {
    await fc.assert(fc.asyncProperty(
      fc.record({
        text: fc.string().map((text) => `Follow up: ${text}`),
        model: fc.constantFrom("review-model", "follow-up-model"),
        executionMode: fc.constantFrom("default", "auto", "full-access"),
        fastMode: fc.boolean(),
        status: fc.constantFrom("scheduled", "dispatching", "queued"),
      }),
      async ({ text, model, executionMode, fastMode, status }) => {
        const request: SteerTurnRequest = {
          backend: "codex", threadId: "parent", expectedTurnId: "review", requestId: "steer",
          input: [{ type: "text", text }],
          fallback: {
            displayText: text,
            turn: { input: [{ type: "text", text }], model, executionMode, fastMode },
          },
        };
        const steerTurn = vi.fn(async () => {
          throw new Error("Native review steering is unsupported; queue a follow-up instead.");
        });
        const create = vi.fn(async (queued: CreateScheduledThreadActionRequest) => ({
          action: {
            ...queued, id: "follow-up", origin: "desktop" as const,
            status, createdAt: 1, updatedAt: 1,
            ...(status === "queued" ? { queueEntryId: "queued-follow-up" } : {}),
          },
        }));

        const response = await admitSteerTurn({ steerTurn }, { create, get: () => undefined }, request);

        expect(response).toMatchObject({
          disposition: "scheduled", fallbackReason: "native-review",
          scheduledAction: { id: "follow-up", status },
        });
        expect(steerTurn).toHaveBeenCalledExactlyOnceWith(request);
        expect(create).toHaveBeenCalledExactlyOnceWith({
          ...request.fallback,
          backend: request.backend, threadId: request.threadId,
          kind: "turn", origin: "desktop", scheduledFor: expect.any(Number),
        }, { id: expect.stringMatching(/^scheduled-action:steer:/) });
      },
    ));
  });
});
