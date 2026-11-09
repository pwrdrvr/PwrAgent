import fc from "fast-check";
import { expect, it } from "vitest";
import type { AppServerThreadMessageOrigin, AppServerTurnInputItem, SteerTurnRequest } from "@pwragent/shared";
import { ThreadSteerSubmissionLifecycle, type ThreadSteerSubmissionHost } from "../thread-steer-submission-lifecycle";
import { ThreadSteeringLifecycle } from "../thread-steering-lifecycle";

const scenario = fc.record({
  backend: fc.constantFrom<SteerTurnRequest["backend"]>("codex", "claude", "acp:kimi", "acp:claude"),
  threadId: fc.constantFrom("same", "other", "same\u0000turn"),
  turnId: fc.constantFrom("turn", "other"),
  deliveryNow: fc.boolean(), locked: fc.boolean(), gate: fc.boolean(),
  origin: fc.constantFrom("operator", "messaging", "agent", "restart"),
  review: fc.constantFrom("none", "native", "managed"),
  nextTurn: fc.boolean(), fails: fc.constantFrom("none", "queue", "input", "prepare", "provider", "retain", "bind"),
});

// Oracle: gates admit no provider work; the selected provider owns the result.
// A rejected send forgets its prepared context. An accepted send keeps it and
// runs retention before causal completion, with no inference of active turns.
it("matches the submission decision and ordered-effect oracle across generated owner commands", async () => {
  await fc.assert(fc.asyncProperty(fc.array(scenario, { minLength: 1, maxLength: 30 }), async (commands) => {
    for (const command of commands) {
      const trace: string[] = [];
      const effect = (name: string, failure = name) => {
        trace.push(name);
        if (command.fails === failure) throw new Error(failure);
      };
      const request: SteerTurnRequest = { backend: command.backend, threadId: command.threadId,
        expectedTurnId: command.turnId, requestId: "request", input: [{ type: "text", text: "Original" }],
        ...(command.deliveryNow ? { delivery: "now" } : {}) };
      const origin: AppServerThreadMessageOrigin | undefined = command.origin === "operator" ? undefined
        : command.origin === "restart" ? { kind: "pwragent", systemReason: "app-restart" }
          : { kind: command.origin === "messaging" ? "messaging" : "agent" };
      const preparedInput = [{ type: "text" as const, text: "Prepared" }];
      const providerResult = { threadId: `provider:${command.threadId}`, turnId: `provider:${command.turnId}` };
      const assertPayload = (params: SteerTurnRequest, input: AppServerTurnInputItem[], messageOrigin?: AppServerThreadMessageOrigin) => {
        expect(params).toEqual(request);
        expect(input).toBe(preparedInput);
        expect(messageOrigin).toBe(origin);
      };
      const host: ThreadSteerSubmissionHost = {
        assertUnlocked: async (params) => {
          expect(params).toBe(request);
          trace.push("lock");
          if (command.locked) throw new Error("locked");
        },
        isRestartGateClosed: () => { trace.push("gate"); return command.gate; },
        queue: async (params, messageOrigin, queueOrigin) => {
          expect(params).toBe(request); expect(messageOrigin).toBe(origin);
          expect(queueOrigin).toBe(command.origin === "messaging" ? "messaging" : "manual");
          effect("queue"); return { id: "entry", createdAt: 123 };
        },
        reviewMode: (params) => {
          expect(params).toBe(request); trace.push("review");
          return command.review === "none" ? undefined : command.review;
        },
        prepareInput: async (params) => {
          expect(params).toBe(request); effect("input"); return preparedInput;
        },
        steerClaude: async (params, input, messageOrigin) => {
          assertPayload(params, input, messageOrigin);
          effect("claude", "provider"); return { ...providerResult, messageId: "message" };
        },
        retainClaude: async (params, messageId, messageOrigin) => {
          expect(params).toBe(request); expect(messageId).toBe("message"); expect(messageOrigin).toBe(origin);
          effect("retain");
        },
        prepareAcp: async (params, input, messageOrigin) => {
          assertPayload(params, input, messageOrigin); effect("prepare");
          return { submit: async () => { effect("acp", "provider"); return { delivery: command.nextTurn ? "nextTurn" : "currentTurn" }; },
            bindCurrentTurn: () => { effect("bind"); }, forget: () => { trace.push("forget"); } };
        },
        prepareCodex: async (params, input, messageOrigin) => {
          assertPayload(params, input, messageOrigin); effect("prepare");
          return { submit: async () => { effect("codex", "provider"); return providerResult; },
            retain: async (result) => { expect(result).toBe(providerResult); effect("retain"); },
            forget: () => { trace.push("forget"); } };
        },
      };
      const submission = new ThreadSteerSubmissionLifecycle(host);
      const lifecycle = new ThreadSteeringLifecycle({ submit: (params, origin) => submission.submit(params, origin),
        complete: async () => { trace.push("causal"); } });
      const expected: string[] = [];
      let error: string | undefined;
      let response = { backend: request.backend, ...providerResult, disposition: "steered" as "steered" | "queued" };
      if (command.deliveryNow && command.backend !== "claude") error = "cannot interrupt";
      else {
        expected.push("lock");
        if (command.locked) error = "locked";
        else {
          expected.push("gate");
          if (command.gate && origin && command.origin !== "restart") {
            expected.push("queue");
            if (command.fails === "queue") error = "queue";
            else response = { backend: request.backend, threadId: request.threadId, turnId: request.expectedTurnId,
              disposition: "queued", ...{ queueEntryId: "entry", queueEntryCreatedAt: 123 } };
          } else {
            expected.push("review");
            if (command.review === "native") error = "Native review steering is unsupported";
            else {
              expected.push("input");
              if (command.fails === "input") error = "input";
              else {
                const acp = command.backend.startsWith("acp:");
                if (command.backend !== "claude") expected.push("prepare");
                if (command.backend !== "claude" && command.fails === "prepare") error = "prepare";
                else {
                  expected.push(acp ? "acp" : command.backend);
                  if (command.fails === "provider") {
                    if (command.backend !== "claude") expected.push("forget");
                    error = "provider";
                  } else if (acp) {
                    if (!command.nextTurn) {
                      expected.push("bind");
                      if (command.fails === "bind") error = "bind";
                    }
                    response = { backend: request.backend, threadId: request.threadId, turnId: request.expectedTurnId,
                      disposition: command.nextTurn ? "queued" : "steered" };
                  } else {
                    expected.push("retain");
                    if (command.fails === "retain") error = "retain";
                  }
                }
              }
            }
          }
        }
      }
      if (error) await expect(lifecycle.steerTurn(request, origin)).rejects.toThrow(error);
      else {
        expected.push("causal");
        expect(await lifecycle.steerTurn(request, origin)).toEqual(response);
      }
      expect(trace).toEqual(expected);
    }
  }));
});
