import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpAgentClient } from "../acp/acp-client";
import { AcpRolloutStore } from "../acp/acp-rollout-store";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import { StateDb } from "../state/state-db";
import { AcpSessionStore } from "../storage/acp-session-store";
import { openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

type DeferredPrompt = {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

function createDeferredPrompt(): DeferredPrompt {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type SteerStep =
  | { kind: "thought"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "steer_accept"; text: string }
  | { kind: "steer_reject"; text: string };

type TerminalStep =
  | { kind: "end_turn" }
  | { kind: "cancelled" }
  | { kind: "cancel_mid_steer"; text: string; lateOutcome: "reject" | "resolve_cancelled" }
  | { kind: "fail"; message: string };

const nonEmptyWord = fc.stringMatching(/^[A-Za-z0-9]{1,12}$/);

const stepArbitrary: fc.Arbitrary<SteerStep> = fc.oneof(
  nonEmptyWord.map((text): SteerStep => ({ kind: "thought", text })),
  nonEmptyWord.map((text): SteerStep => ({ kind: "assistant", text })),
  nonEmptyWord.map((text): SteerStep => ({ kind: "steer_accept", text })),
  nonEmptyWord.map((text): SteerStep => ({ kind: "steer_reject", text })),
);

const terminalArbitrary: fc.Arbitrary<TerminalStep> = fc.oneof(
  fc.constant<TerminalStep>({ kind: "end_turn" }),
  fc.constant<TerminalStep>({ kind: "cancelled" }),
  fc.record({
    kind: fc.constant("cancel_mid_steer" as const),
    text: nonEmptyWord,
    lateOutcome: fc.constantFrom("reject" as const, "resolve_cancelled" as const),
  }),
  nonEmptyWord.map((message): TerminalStep => ({ kind: "fail", message })),
);

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe("Antigravity ACP overlapping-prompt steering model", () => {
  let tempDir: string;
  let stateDb: StateDb;
  let store: AcpSessionStore;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-agy-steer-prop-"));
    stateDb = openInMemoryStateDb();
    store = new AcpSessionStore(stateDb);
  });

  afterEach(() => {
    stateDb.close();
    removeTempStateDbDir(tempDir);
  });

  it("maintains single-turn ownership, exact user-message order, and rollout parity across arbitrary steer interleavings", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(stepArbitrary, { minLength: 1, maxLength: 14, size: "max" }),
        terminalArbitrary,
        async (steps, terminal) => {
          const runDir = mkdtempSync(path.join(tempDir, "run-"));
          const rolloutStore = new AcpRolloutStore(path.join(runDir, "rollouts"));
          const prompts: DeferredPrompt[] = [];
          const transport = new FakeAcpAgentTransport({
            initialize: {
              protocolVersion: 1,
              agentInfo: { name: "Antigravity ACP Server", version: "1.5.15" },
            },
            "session/new": { sessionId: "agy-prop-session" },
          });
          const baseRequest = transport.request.bind(transport);
          transport.request = async (method, params, timeoutMs) => {
            if (method === "session/prompt") {
              transport.requests.push({ method, params, timeoutMs });
              const deferred = createDeferredPrompt();
              prompts.push(deferred);
              return await deferred.promise;
            }
            return await baseRequest(method, params, timeoutMs);
          };

          let clock = 1000;
          let turnFinishedEvents = 0;
          let lastStopReason: unknown;
          const steeredUpdates: string[] = [];
          const promptErrors: unknown[] = [];
          const client = new AcpAgentClient({
            backendId: "acp:antigravity",
            store,
            rolloutStore,
            transport,
            now: () => (clock += 10),
            onSessionUpdate: ({ update }) => {
              if (update.kind === "turn_finished") {
                turnFinishedEvents += 1;
                lastStopReason = update.stopReason;
              } else if (update.kind === "pwragent_steered_user_prompt" && typeof update.prompt === "string") {
                steeredUpdates.push(update.prompt);
              }
            },
            onPromptError: ({ error }) => {
              promptErrors.push(error);
            },
          });

          try {
            await client.initialize();
            const session = await client.startSession({
              cwd: "/repo",
              executionMode: "default",
              mcpServers: "none",
            });
            await client.startPrompt({
              sessionId: session.sessionId,
              prompt: "Initial prompt",
              turnId: "turn-1",
            });

            // Reference model state
            const expectedUserMessages = ["Initial prompt"];
            let activeOwnerIndex = 0;
            let sawAssistantText = false;
            let steerSeq = 0;

            for (const step of steps) {
              if (step.kind === "thought") {
                transport.emitSessionUpdate("agy-prop-session", {
                  sessionUpdate: "agent_thought_chunk",
                  content: { type: "text", text: step.text },
                });
              } else if (step.kind === "assistant") {
                sawAssistantText = true;
                transport.emitSessionUpdate("agy-prop-session", {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: step.text },
                });
              } else if (step.kind === "steer_accept") {
                const text = `steer-${++steerSeq}-${step.text}`;
                const nextIndex = prompts.length;
                const steerPromise = client.steerSession({
                  sessionId: session.sessionId,
                  text,
                  prompt: text,
                  parts: [{ type: "text", text }],
                  content: [{ type: "text", text }],
                  interjectionId: `id-${steerSeq}`,
                });
                await vi.waitFor(() => expect(prompts.length).toBe(nextIndex + 1));
                prompts[activeOwnerIndex]!.resolve({ stopReason: "end_turn" });
                await expect(steerPromise).resolves.toEqual({ delivery: "currentTurn" });
                activeOwnerIndex = nextIndex;
                expectedUserMessages.push(text);
              } else {
                const text = `rejected-${++steerSeq}-${step.text}`;
                const nextIndex = prompts.length;
                const steerPromise = client.steerSession({
                  sessionId: session.sessionId,
                  text,
                  prompt: text,
                  parts: [{ type: "text", text }],
                  content: [{ type: "text", text }],
                  interjectionId: `rej-${steerSeq}`,
                });
                await vi.waitFor(() => expect(prompts.length).toBe(nextIndex + 1));
                prompts[nextIndex]!.reject(new Error("permission pending"));
                await expect(steerPromise).rejects.toThrow("permission pending");
              }

              // Invariants while turn is still active:
              expect(client.hasActiveTurns()).toBe(true);
              expect(store.getSession("acp:antigravity", session.sessionId)?.status).toBe("active");
              expect(turnFinishedEvents).toBe(0);
              expect(promptErrors).toHaveLength(0);
              expect(
                client.readReplay(session.sessionId).messages
                  .filter((message) => message.role === "user")
                  .map((message) => message.text),
              ).toEqual(expectedUserMessages);
            }

            // Ensure non-empty assistant output when testing clean end_turn completion.
            if (terminal.kind === "end_turn" && !sawAssistantText) {
              transport.emitSessionUpdate("agy-prop-session", {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Final answer" },
              });
            }

            if (terminal.kind === "end_turn") {
              prompts[activeOwnerIndex]!.resolve({ stopReason: "end_turn" });
              await flushMicrotasks();
              expect(turnFinishedEvents).toBe(1);
              expect(lastStopReason).toBeUndefined();
              expect(promptErrors).toHaveLength(0);
            } else if (terminal.kind === "cancelled") {
              prompts[activeOwnerIndex]!.resolve({ stopReason: "cancelled" });
              await flushMicrotasks();
              expect(turnFinishedEvents).toBe(1);
              expect(lastStopReason).toBe("cancelled");
              expect(promptErrors).toHaveLength(0);
            } else if (terminal.kind === "cancel_mid_steer") {
              const text = `cancelled-steer-${++steerSeq}-${terminal.text}`;
              const nextIndex = prompts.length;
              const steerPromise = client.steerSession({
                sessionId: session.sessionId,
                text,
                prompt: text,
                parts: [{ type: "text", text }],
                content: [{ type: "text", text }],
                interjectionId: `cancel-${steerSeq}`,
              });
              await vi.waitFor(() => expect(prompts.length).toBe(nextIndex + 1));
              prompts[activeOwnerIndex]!.resolve({ stopReason: "cancelled" });
              await expect(steerPromise).rejects.toThrow("cancelled before steering was accepted");
              if (terminal.lateOutcome === "reject") {
                prompts[nextIndex]!.reject(new Error("the running prompt is being cancelled"));
              } else {
                prompts[nextIndex]!.resolve({ stopReason: "cancelled" });
              }
              await flushMicrotasks();
              expect(turnFinishedEvents).toBe(1);
              expect(lastStopReason).toBe("cancelled");
              expect(promptErrors).toHaveLength(0);
            } else {
              prompts[activeOwnerIndex]!.reject(new Error(terminal.message));
              await flushMicrotasks();
              expect(turnFinishedEvents).toBe(0);
              expect(promptErrors).toHaveLength(1);
            }

            // Post-turn invariants:
            expect(client.hasActiveTurns()).toBe(false);
            expect(store.getSession("acp:antigravity", session.sessionId)?.status).toBe("idle");
            expect(steeredUpdates).toEqual(expectedUserMessages.slice(1));

            const liveReplay = client.readReplay(session.sessionId);
            expect(
              liveReplay.messages
                .filter((message) => message.role === "user")
                .map((message) => message.text),
            ).toEqual(expectedUserMessages);

            // Rollout replay must match live replay across every steer boundary:
            // identical user-message order and identical assistant content inside
            // each segment between user prompts (no pre-steer text leaking past a
            // steer boundary or post-steer text collapsing before it).
            const segmentMessages = (
              messages: ReadonlyArray<{ role: string; text: string }>,
            ) => {
              const segments: Array<{ user: string; assistantChars: string }> = [];
              for (const message of messages) {
                if (message.role === "user") {
                  segments.push({ user: message.text, assistantChars: "" });
                } else if (segments.length > 0) {
                  segments[segments.length - 1]!.assistantChars += message.text;
                }
              }
              return segments.map((segment) => ({
                user: segment.user,
                // AcpRolloutStore buffers thought and final chunks in separate
                // keys until a non-chunk boundary flushes them; sort characters
                // only for order within a single segment while proving exact
                // per-segment containment across every steer boundary.
                assistantChars: [...segment.assistantChars].sort().join(""),
              }));
            };
            const liveSegments = segmentMessages(liveReplay.messages);
            await client.dispose();
            const restoredClient = new AcpAgentClient({
              backendId: "acp:antigravity",
              store,
              rolloutStore,
              transport: new FakeAcpAgentTransport({
                initialize: { protocolVersion: 1, agentCapabilities: { loadSession: false } },
              }),
            });
            try {
              await restoredClient.initialize();
              const restoredReplay = await restoredClient.loadSession(
                store.getSession("acp:antigravity", session.sessionId)!,
              );
              expect(segmentMessages(restoredReplay.messages)).toEqual(liveSegments);
            } finally {
              await restoredClient.dispose();
            }
          } finally {
            await client.dispose();
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
