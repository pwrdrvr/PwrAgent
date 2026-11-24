import { mkdtempSync } from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpAgentClient } from "../acp/acp-client";
import { AcpRolloutStore } from "../acp/acp-rollout-store";
import { AcpStdioJsonRpcTransport } from "../acp/acp-stdio-transport";
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

type AntigravityWireUsage = {
  inputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
};

type SteerStep =
  | { kind: "thought"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string }
  | { kind: "steer_accept"; text: string; detachUsage?: AntigravityWireUsage }
  | { kind: "steer_reject"; text: string };

type TerminalStep =
  | { kind: "end_turn"; usage?: AntigravityWireUsage }
  | { kind: "cancelled"; usage?: AntigravityWireUsage }
  | { kind: "cancel_mid_steer"; text: string; lateOutcome: "reject" | "resolve_cancelled" }
  | { kind: "fail"; message: string };

const nonEmptyWord = fc.stringMatching(/^[A-Za-z0-9]{1,12}$/);

const antigravityUsageArbitrary: fc.Arbitrary<AntigravityWireUsage> = fc
  .record({
    inputTokens: fc.integer({ min: 1, max: 50_000 }),
    cachedReadTokens: fc.integer({ min: 0, max: 50_000 }),
    cachedWriteTokens: fc.integer({ min: 0, max: 10_000 }),
    thoughtTokens: fc.integer({ min: 0, max: 5_000 }),
    visibleOutputTokens: fc.integer({ min: 1, max: 5_000 }),
  })
  .map(({ inputTokens, cachedReadTokens, cachedWriteTokens, thoughtTokens, visibleOutputTokens }) => {
    const outputTokens = thoughtTokens + visibleOutputTokens;
    return {
      inputTokens,
      cachedReadTokens,
      cachedWriteTokens,
      outputTokens,
      thoughtTokens,
      totalTokens: inputTokens + cachedReadTokens + cachedWriteTokens + outputTokens,
    };
  });

function sumWireUsage(
  left: AntigravityWireUsage | undefined,
  right: AntigravityWireUsage | undefined,
): AntigravityWireUsage | undefined {
  if (!left) return right ? { ...right } : undefined;
  if (!right) return { ...left };
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedReadTokens: left.cachedReadTokens + right.cachedReadTokens,
    cachedWriteTokens: left.cachedWriteTokens + right.cachedWriteTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    thoughtTokens: left.thoughtTokens + right.thoughtTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

const stepArbitrary: fc.Arbitrary<SteerStep> = fc.oneof(
  nonEmptyWord.map((text): SteerStep => ({ kind: "thought", text })),
  nonEmptyWord.map((text): SteerStep => ({ kind: "assistant", text })),
  nonEmptyWord.map((name): SteerStep => ({ kind: "tool", name })),
  fc.record({
    kind: fc.constant("steer_accept" as const),
    text: nonEmptyWord,
    detachUsage: fc.option(antigravityUsageArbitrary, { nil: undefined }),
  }),
  nonEmptyWord.map((text): SteerStep => ({ kind: "steer_reject", text })),
);

const terminalArbitrary: fc.Arbitrary<TerminalStep> = fc.oneof(
  fc.record({
    kind: fc.constant("end_turn" as const),
    usage: fc.option(antigravityUsageArbitrary, { nil: undefined }),
  }),
  fc.record({
    kind: fc.constant("cancelled" as const),
    usage: fc.option(antigravityUsageArbitrary, { nil: undefined }),
  }),
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

  async function checkWireHandoff(
    outcome: "detach" | "detach-with-usage" | "cancel" | "write-failure",
    together: boolean,
    text: string,
    verifiedReplay = false,
  ): Promise<void> {
    const runDir = mkdtempSync(path.join(tempDir, "wire-"));
    const sessionId = path.basename(runDir);
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null,
      kill(): boolean {
        child.exitCode = 0;
        child.emit("close");
        return true;
      },
    });
    const transport = new AcpStdioJsonRpcTransport({
      launchDescriptor: {
        // Exercise the real wire dispatch without resolving an installed CLI.
        backendId: "acp:antigravity",
        registryId: "antigravity",
        distributionKind: "local",
        command: "fixture-agent",
        args: [],
        env: {},
        cwd: "/repo",
      },
      spawn: () => child,
    });
    const frame = (value: object) => JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n";
    const response = (id: string, result: object) => frame({ id, result });
    const chunk = (text: string) => frame({
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
    });
    const initial = Promise.withResolvers<string>();
    const replacement = Promise.withResolvers<string>();
    let promptCount = 0;
    let cancelRequests = 0;
    child.stdin.on("data", (value: Buffer) => {
      for (const rawLine of value.toString().split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        const { id, method } = JSON.parse(line);
        if (method === "initialize") {
          child.stdout.write(response(id, {
            protocolVersion: 1,
            agentInfo: { version: "1.5.15" },
            agentCapabilities: { loadSession: verifiedReplay },
          }));
        } else if (method === "session/new") {
          child.stdout.write(response(id, { sessionId }));
        } else if (method === "session/load") {
          child.stdout.write(frame({
            method: "session/update",
            params: { sessionId, update: {
              sessionUpdate: "user_message_chunk",
              createdAt: Date.now() - 10_000,
              content: { type: "text", text: "Earlier provider prompt" },
            } },
          }) + response(id, {}));
        } else if (method === "session/prompt") {
          (promptCount++ === 0 ? initial : replacement).resolve(id);
        } else if (method === "session/cancel") {
          cancelRequests += 1;
        }
      }
    });
    const rolloutStore = new AcpRolloutStore(runDir);
    const append = rolloutStore.appendUpdate.bind(rolloutStore);
    const failedWrite = vi.fn();
    vi.spyOn(rolloutStore, "appendUpdate").mockImplementation((params) => {
      if (outcome === "write-failure" && params.update.kind === "pwragent_steered_user_prompt") {
        failedWrite();
        throw new Error("ENOSPC");
      }
      append(params);
    });
    const terminal = Promise.withResolvers<"finished" | "failed">();
    const order: string[] = [];
    let finalTurnUsage: unknown;
    const client = new AcpAgentClient({
      backendId: "acp:antigravity",
      store,
      rolloutStore,
      transport,
      onSessionUpdate: ({ update }) => {
        if (update.kind === "pwragent_steered_user_prompt") order.push("steer");
        if (update.sessionUpdate === "agent_message_chunk") order.push("answer");
        if (update.kind === "turn_finished") {
          finalTurnUsage = update.usage;
          terminal.resolve("finished");
        }
      },
      onPromptError: () => terminal.resolve("failed"),
    });
    try {
      await client.initialize();
      if (verifiedReplay) {
        await client.loadSession({
          backendId: "acp:antigravity", sessionId, cwd: "/repo", title: "Provider session",
          createdAt: Date.now() - 10_000, updatedAt: Date.now(), executionMode: "default", status: "idle",
        });
      } else {
        await client.startSession({ cwd: "/repo", executionMode: "default", mcpServers: "none" });
      }
      await client.startPrompt({ sessionId, prompt: "Initial prompt", turnId: "turn-1" });
      const oldId = await initial.promise;
      child.stdout.write(chunk("Before"));
      const receipt = client.steerSession({
        sessionId, text, content: [{ type: "text", text }], interjectionId: "wire",
      }).then(() => "accepted", () => "rejected");
      const nextId = await replacement.promise;
      const detachUsage = {
        inputTokens: 100,
        cachedReadTokens: 50,
        cachedWriteTokens: 0,
        outputTokens: 20,
        thoughtTokens: 8,
        totalTokens: 170,
      };
      const finalUsage = {
        inputTokens: 10,
        cachedReadTokens: 60,
        cachedWriteTokens: 0,
        outputTokens: 5,
        thoughtTokens: 2,
        totalTokens: 75,
      };
      const final = { stopReason: "end_turn", usage: finalUsage };
      const followup = outcome === "cancel"
        ? frame({ id: nextId, error: { code: -32603, message: "the running prompt is being cancelled" } })
        : chunk("After") + response(nextId, final);
      const oldResult = outcome === "cancel"
        ? { stopReason: "cancelled", usage: detachUsage }
        : outcome === "detach-with-usage"
          ? { stopReason: "end_turn", usage: detachUsage }
          : { stopReason: "end_turn" };
      const oldResponse = response(oldId, oldResult);
      child.stdout.write(together ? oldResponse + followup : oldResponse);
      if (!together) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        child.stdout.write(followup);
      }
      const terminalKind = await terminal.promise;
      expect(await Promise.race([receipt, new Promise((resolve) => setImmediate(() => resolve("pending")))]))
        .toBe(outcome === "cancel" ? "rejected" : "accepted");
      expect(terminalKind).toBe("finished");
      expect(order).toEqual(outcome === "cancel" ? ["answer"] : ["answer", "steer", "answer"]);
      if (outcome !== "cancel") {
        expect(cancelRequests).toBe(0);
      }
      if (outcome === "detach-with-usage") {
        expect(finalTurnUsage).toEqual({
          inputTokens: 110,
          cachedReadTokens: 110,
          cachedWriteTokens: 0,
          outputTokens: 25,
          thoughtTokens: 10,
          totalTokens: 245,
        });
      }
      if (verifiedReplay) {
        const records = rolloutStore.readUpdates({ backendId: "acp:antigravity", sessionId });
        expect(records.map(({ update }) => update.kind)).toEqual([
          "pwragent_antigravity_prompt_identity",
          "pwragent_antigravity_prompt_identity",
        ]);
        expect(records[1]?.update).toMatchObject({
          turnId: "turn-1",
          messageId: "user:turn-1:steer:wire",
          textDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        });
        expect(records.every(({ update }) => !("prompt" in update || "parts" in update))).toBe(true);
      } else if (outcome !== "write-failure") {
        const replay = rolloutStore.readReplay({ backendId: "acp:antigravity", sessionId });
        expect(replay.messages.map((message) => message.text)).toEqual(
          outcome === "cancel" ? ["Initial prompt", "Before"] : ["Initial prompt", "Before", text, "After"],
        );
      } else {
        expect(failedWrite).toHaveBeenCalledTimes(1);
      }
    } finally {
      await client.dispose();
    }
  }

  it.each(["detach", "detach-with-usage", "cancel", "write-failure"] as const)(
    "keeps prompt ownership and receipt settlement independent of stdout batching on %s",
    async (outcome) => {
      await fc.assert(fc.asyncProperty(fc.boolean(), nonEmptyWord, async (together, text) => {
        await checkWireHandoff(outcome, together, text);
      }), { numRuns: 10 });
    },
  );

  it("applies a detach and its first post-steer chunk in wire order", async () => {
    await checkWireHandoff("detach", true, "Change course");
  });

  it("retains prompt identities after timestamped provider replay has taken ownership", async () => {
    await checkWireHandoff("detach", true, "Initial prompt", true);
  });

  it("maintains single-turn ownership, exact user-message order, and rollout parity across arbitrary steer interleavings", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(stepArbitrary, { minLength: 1, maxLength: 14, size: "max" }),
        terminalArbitrary,
        fc.integer({ min: -400, max: 400 }),
        async (steps, terminal, providerTimestampOffset) => {
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

          let clock = 1_795_000_000_000;
          let turnFinishedEvents = 0;
          let lastStopReason: unknown;
          let lastTurnUsage: unknown;
          const steeredUpdates: string[] = [];
          const promptErrors: Array<{ error: unknown; usage?: unknown }> = [];
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
                lastTurnUsage = update.usage;
              } else if (update.kind === "pwragent_steered_user_prompt" && typeof update.prompt === "string") {
                steeredUpdates.push(update.prompt);
              }
            },
            onPromptError: ({ error, usage }) => {
              promptErrors.push({ error, usage });
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
            let expectedUsage: AntigravityWireUsage | undefined;
            let activeOwnerIndex = 0;
            let sawAssistantText = false;
            let steerSeq = 0;
            let toolSeq = 0;

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
              } else if (step.kind === "tool") {
                const toolCallId = `tool-${++toolSeq}`;
                transport.emitSessionUpdate("agy-prop-session", {
                  sessionUpdate: "tool_call",
                  toolCallId,
                  name: step.name,
                  status: "in_progress",
                });
                transport.emitSessionUpdate("agy-prop-session", {
                  sessionUpdate: "tool_call_update",
                  toolCallId,
                  name: step.name,
                  status: "completed",
                });
              } else if (step.kind === "steer_accept") {
                steerSeq += 1;
                const text = steerSeq % 2 === 1 ? "Initial prompt" : step.text;
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
                prompts[activeOwnerIndex]!.resolve({
                  stopReason: "end_turn",
                  ...(step.detachUsage ? { usage: step.detachUsage } : {}),
                });
                await expect(steerPromise).resolves.toEqual({ delivery: "currentTurn" });
                activeOwnerIndex = nextIndex;
                expectedUserMessages.push(text);
                expectedUsage = sumWireUsage(expectedUsage, step.detachUsage);
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
              expect(transport.notifications.some((n) => n.method === "session/cancel")).toBe(false);
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
              prompts[activeOwnerIndex]!.resolve({
                stopReason: "end_turn",
                ...(terminal.usage ? { usage: terminal.usage } : {}),
              });
              expectedUsage = sumWireUsage(expectedUsage, terminal.usage);
              await flushMicrotasks();
              expect(turnFinishedEvents).toBe(1);
              expect(lastStopReason).toBeUndefined();
              expect(lastTurnUsage).toEqual(expectedUsage);
              expect(promptErrors).toHaveLength(0);
            } else if (terminal.kind === "cancelled") {
              prompts[activeOwnerIndex]!.resolve({
                stopReason: "cancelled",
                ...(terminal.usage ? { usage: terminal.usage } : {}),
              });
              expectedUsage = sumWireUsage(expectedUsage, terminal.usage);
              await flushMicrotasks();
              expect(turnFinishedEvents).toBe(1);
              expect(lastStopReason).toBe("cancelled");
              expect(lastTurnUsage).toEqual(expectedUsage);
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
              expect(lastTurnUsage).toEqual(expectedUsage);
              expect(promptErrors).toHaveLength(0);
            } else {
              prompts[activeOwnerIndex]!.reject(new Error(terminal.message));
              await flushMicrotasks();
              expect(turnFinishedEvents).toBe(0);
              expect(promptErrors).toHaveLength(1);
              if (expectedUsage) {
                expect(promptErrors[0]?.usage).toMatchObject({
                  scope: "turn",
                  tokenUsage: {
                    inputTokens:
                      expectedUsage.inputTokens
                      + expectedUsage.cachedReadTokens
                      + expectedUsage.cachedWriteTokens,
                    cachedInputTokens: expectedUsage.cachedReadTokens,
                    outputTokens: expectedUsage.outputTokens,
                    reasoningOutputTokens: expectedUsage.thoughtTokens,
                    totalTokens: expectedUsage.totalTokens,
                  },
                });
              } else {
                expect(promptErrors[0]?.usage).toBeUndefined();
              }
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
            if (expectedUserMessages.length > 1) {
              const provider = new FakeAcpAgentTransport({
                initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
              });
              provider.request = async (method) => {
                if (method === "initialize") {
                  return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
                }
                expect(method).toBe("session/load");
                for (const entry of liveReplay.entries) {
                  if (entry.type === "activity") {
                    provider.emitSessionUpdate(session.sessionId, {
                      sessionUpdate: "tool_call",
                      toolCallId: entry.id,
                      name: entry.summary,
                      status: "completed",
                      createdAt: (entry.createdAt ?? clock) + providerTimestampOffset,
                    });
                    continue;
                  }
                  if (entry.type !== "message") continue;
                  provider.emitSessionUpdate(session.sessionId, {
                    sessionUpdate: entry.role === "user" ? "user_message_chunk"
                      : entry.phase === "commentary" ? "agent_thought_chunk" : "agent_message_chunk",
                    createdAt: (entry.createdAt ?? clock) + providerTimestampOffset,
                    content: {
                      type: "text",
                      text: entry.role === "user" ? entry.text : "Provider: " + entry.text,
                    },
                  });
                }
                return {};
              };
              const providerClient = new AcpAgentClient({
                backendId: "acp:antigravity", store, rolloutStore, transport: provider,
              });
              try {
                await providerClient.initialize();
                const replay = await providerClient.loadSession(store.getSession("acp:antigravity", session.sessionId)!);
                const messageEntries = (entries: typeof replay.entries) =>
                  entries.flatMap((entry) => entry.type === "message"
                    ? [{
                        role: entry.role,
                        ...(entry.role === "user" ? { id: entry.id, text: entry.text } : {}),
                        turnId: entry.turn?.id,
                      }]
                    : []);
                expect(messageEntries(replay.entries)).toEqual(messageEntries(liveReplay.entries));
                expect(replay.messages.filter((message) => message.role === "assistant")
                  .every((message) => message.text.startsWith("Provider: "))).toBe(true);
              } finally {
                await providerClient.dispose();
              }
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
