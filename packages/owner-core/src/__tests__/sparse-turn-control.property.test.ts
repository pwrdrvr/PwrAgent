import fc from "fast-check";
import { expect, it } from "vitest";
import type { SteerTurnRequest } from "@pwragent/shared";
import { ThreadSteeringLifecycle } from "../thread-steering-lifecycle";
import { ThreadSteerSubmissionLifecycle } from "../thread-steer-submission-lifecycle";
import { ThreadInterruptionLifecycle } from "../thread-interruption-lifecycle";

it("sparse hosts preserve native acceptance without inventing unsupported provider effects", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom<SteerTurnRequest["backend"]>("codex", "claude", "acp:grok"), fc.boolean(), async (backend, refuses) => {
    let steers = 0;
    let interrupts = 0;
    const response = { threadId: "native", turnId: "turn" };
    const submission = new ThreadSteerSubmissionLifecycle({
      assertUnlocked: async () => {}, prepareInput: async request => request.input,
      prepareCodex: async () => ({ submit: async () => { steers++; if (refuses) throw new Error("native refused"); return response; } }),
    });
    const steering = new ThreadSteeringLifecycle({ submit: request => submission.submit(request) });
    const interruption = new ThreadInterruptionLifecycle({ interruptCodex: async () => { interrupts++; if (refuses) throw new Error("native refused"); return response; } });
    const request = { backend, ...response, expectedTurnId: response.turnId, requestId: "request", input: [{ type: "text" as const, text: "input" }] };
    if (backend !== "codex" || refuses) {
      await expect(steering.steerTurn(request)).rejects.toThrow(backend === "codex" ? "native refused" : "cannot steer");
      await expect(interruption.interruptTurn(request)).rejects.toThrow(backend === "codex" ? "native refused" : "cannot interrupt");
    } else {
      const copies = await Promise.all([steering.steerTurn(request), steering.steerTurn(request)]);
      expect(copies).toEqual(Array(2).fill({ backend, ...response, disposition: "steered" }));
      expect(await interruption.interruptTurn(request)).toEqual({ backend, ...response });
    }
    expect(steers).toBe(backend === "codex" ? 1 : 0);
    expect(interrupts).toBe(backend === "codex" ? 1 : 0);
  }), { numRuns: 18 });
});
