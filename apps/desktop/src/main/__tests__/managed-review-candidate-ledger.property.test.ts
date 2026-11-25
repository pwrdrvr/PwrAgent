import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fc from "fast-check";
import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared/contracts/agent-tools";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import { AgentToolMcpServer, type AgentToolHttpMcpServerConfig } from "../agent-tools/agent-tool-mcp-server";
import { resolveAgentToolCatalogs } from "../agent-tools/agent-tool-catalog-registry";
import {
  buildManagedReviewLedgerToolRouter,
  MANAGED_REVIEW_LEDGER_TOOL_NAMES,
} from "../agent-tools/pwragent-managed-review-ledger-tools";
import { pwragentToolSkipsAgentApproval } from "../app-server/acp-host-tool-approval";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import {
  MANAGED_REVIEW_CANDIDATE_CATEGORIES,
  MANAGED_REVIEW_CANDIDATE_MAX_FIELD_LENGTH,
  MANAGED_REVIEW_CANDIDATE_MAX_PER_TURN,
  ManagedReviewCandidateLedger,
  type ManagedReviewCandidateCategory,
  type ManagedReviewCandidatePriority,
  type ManagedReviewCandidateTurnKey,
} from "../app-server/managed-review-candidate-ledger";
import type { StateDb } from "../state/state-db";
import { AcpAgentStore } from "../storage/acp-agent-store";
import { AcpSessionStore } from "../storage/acp-session-store";
import { createOverlayStoreMock, MockBackendClient } from "./helpers/backend-registry-fixture";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const BACKENDS: readonly AppServerBackendKind[] = ["codex", "acp:antigravity", "acp:grok"];

const turnKeyArb: fc.Arbitrary<ManagedReviewCandidateTurnKey> = fc.record({
  backend: fc.constantFrom(...BACKENDS),
  threadId: fc.constantFrom("thread-a", "thread-b"),
  turnId: fc.constantFrom("turn-1", "turn-2"),
});

const categoryArb = fc.constantFrom<ManagedReviewCandidateCategory>(
  ...MANAGED_REVIEW_CANDIDATE_CATEGORIES,
);

const priorityArb = fc.constantFrom<ManagedReviewCandidatePriority>(0, 1, 2, 3);

const nonEmptyTextArb = fc
  .string({ minLength: 1, maxLength: 40 })
  .map((value) => `x${value.trim()}`);

type ModelCandidate = {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  category: ManagedReviewCandidateCategory;
  summary: string;
  mechanism: string;
  disposition: "pending" | "keep" | "drop";
  priority?: ManagedReviewCandidatePriority;
  dispositionReason?: string;
};

type LedgerStep =
  | {
      kind: "record";
      turn: ManagedReviewCandidateTurnKey;
      file: string;
      startLine: number;
      lineSpan: number;
      category: ManagedReviewCandidateCategory;
      summary: string;
      mechanism: string;
    }
  | {
      kind: "dispose";
      turn: ManagedReviewCandidateTurnKey;
      candidateIndex: number;
      disposition: "keep" | "drop";
      priority?: ManagedReviewCandidatePriority;
      category?: ManagedReviewCandidateCategory;
      reason: string;
    }
  | { kind: "list"; turn: ManagedReviewCandidateTurnKey }
  | { kind: "clearTurn"; turn: ManagedReviewCandidateTurnKey }
  | { kind: "clearThread"; backend: AppServerBackendKind; threadId: string };

const stepArb: fc.Arbitrary<LedgerStep> = fc.oneof(
  fc.record({
    kind: fc.constant("record" as const),
    turn: turnKeyArb,
    file: nonEmptyTextArb,
    startLine: fc.integer({ min: 1, max: 500 }),
    lineSpan: fc.integer({ min: 0, max: 50 }),
    category: categoryArb,
    summary: nonEmptyTextArb,
    mechanism: nonEmptyTextArb,
  }),
  fc.record({
    kind: fc.constant("dispose" as const),
    turn: turnKeyArb,
    candidateIndex: fc.integer({ min: 0, max: 6 }),
    disposition: fc.constantFrom<"keep" | "drop">("keep", "drop"),
    priority: fc.option(priorityArb, { nil: undefined }),
    category: fc.option(categoryArb, { nil: undefined }),
    reason: nonEmptyTextArb,
  }),
  fc.record({
    kind: fc.constant("list" as const),
    turn: turnKeyArb,
  }),
  fc.record({
    kind: fc.constant("clearTurn" as const),
    turn: turnKeyArb,
  }),
  fc.record({
    kind: fc.constant("clearThread" as const),
    backend: fc.constantFrom(...BACKENDS),
    threadId: fc.constantFrom("thread-a", "thread-b"),
  }),
);

function modelTurnKey(turn: ManagedReviewCandidateTurnKey): string {
  return JSON.stringify([turn.backend, turn.threadId, turn.turnId]);
}

describe("ManagedReviewCandidateLedger model properties", () => {
  it("preserves per-turn isolation, monotonic IDs, disposition transitions, and complete cleanup across arbitrary sequences", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 60 }), (steps) => {
        const ledger = new ManagedReviewCandidateLedger();
        const model = new Map<
          string,
          {
            turn: ManagedReviewCandidateTurnKey;
            nextId: number;
            candidates: ModelCandidate[];
          }
        >();

        for (const step of steps) {
          if (step.kind === "record") {
            const key = modelTurnKey(step.turn);
            const endLine = step.startLine + step.lineSpan;
            const actual = ledger.record(step.turn, {
              file: step.file,
              start_line: step.startLine,
              end_line: endLine,
              category: step.category,
              summary: step.summary,
              mechanism: step.mechanism,
            });
            let state = model.get(key);
            if (!state) {
              state = { turn: step.turn, nextId: 1, candidates: [] };
              model.set(key, state);
            }
            const expectedCandidate: ModelCandidate = {
              id: `C${state.nextId}`,
              file: step.file.trim(),
              startLine: step.startLine,
              endLine,
              category: step.category,
              summary: step.summary.trim(),
              mechanism: step.mechanism.trim(),
              disposition: "pending",
            };
            state.nextId += 1;
            state.candidates.push(expectedCandidate);
            expect(actual).toEqual({
              ok: true,
              data: {
                id: expectedCandidate.id,
                recorded: expectedCandidate,
                total_candidates: state.candidates.length,
              },
            });
          } else if (step.kind === "dispose") {
            const key = modelTurnKey(step.turn);
            const state = model.get(key);
            const target = state?.candidates[step.candidateIndex];
            const id = target ? target.id : `C${step.candidateIndex + 100}`;
            const actual = ledger.dispose(step.turn, {
              id,
              disposition: step.disposition,
              priority: step.priority,
              category: step.category,
              reason: step.reason,
            });
            if (step.disposition === "keep" && step.priority === undefined) {
              expect(actual).toMatchObject({ ok: false, code: "invalid_arguments" });
            } else if (!target) {
              expect(actual).toMatchObject({ ok: false, code: "not_found" });
            } else {
              target.disposition = step.disposition;
              target.dispositionReason = step.reason.trim();
              if (step.category !== undefined) {
                target.category = step.category;
              }
              if (step.disposition === "keep") {
                target.priority = step.priority;
              } else {
                delete target.priority;
              }
              expect(actual).toMatchObject({
                ok: true,
                data: {
                  updated: target,
                },
              });
            }
          } else if (step.kind === "list") {
            const expected = model.get(modelTurnKey(step.turn))?.candidates ?? [];
            const listed = ledger.list(step.turn);
            expect(listed.candidates).toEqual(expected);
            expect(listed.total).toBe(expected.length);
            expect(listed.counts).toEqual({
              pending: expected.filter((item) => item.disposition === "pending").length,
              keep: expected.filter((item) => item.disposition === "keep").length,
              drop: expected.filter((item) => item.disposition === "drop").length,
            });
          } else if (step.kind === "clearTurn") {
            const key = modelTurnKey(step.turn);
            expect(ledger.clearTurn(step.turn)).toBe(model.delete(key));
          } else {
            let expectedRemoved = 0;
            for (const [key, state] of model.entries()) {
              if (
                state.turn.backend === step.backend
                && state.turn.threadId === step.threadId
              ) {
                model.delete(key);
                expectedRemoved += 1;
              }
            }
            expect(
              ledger.clearThread({
                backend: step.backend,
                threadId: step.threadId,
              }),
            ).toBe(expectedRemoved);
          }

          expect(ledger.activeTurnCount).toBe(model.size);
        }

        ledger.clearAll();
        expect(ledger.activeTurnCount).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it("enforces field validation, bounding, and per-turn capacity limits without mutating state", () => {
    const ledger = new ManagedReviewCandidateLedger();
    const turn: ManagedReviewCandidateTurnKey = {
      backend: "acp:antigravity",
      threadId: "review-thread",
      turnId: "review-turn",
    };

    expect(
      ledger.record(turn, {
        file: "   ",
        start_line: 1,
        end_line: 1,
        category: "correctness",
        summary: "Missing guard",
        mechanism: "Crashes on empty input.",
      }),
    ).toMatchObject({ ok: false, code: "invalid_arguments" });

    expect(
      ledger.record(turn, {
        file: "a.ts",
        start_line: 20,
        end_line: 10,
        category: "correctness",
        summary: "Inverted range",
        mechanism: "End before start.",
      }),
    ).toMatchObject({ ok: false, code: "invalid_arguments" });

    expect(
      ledger.record(turn, {
        file: "a.ts",
        start_line: 1,
        end_line: 2,
        category: "not-a-category",
        summary: "Bad category",
        mechanism: "Invalid enum.",
      }),
    ).toMatchObject({ ok: false, code: "invalid_arguments" });

    expect(ledger.activeTurnCount).toBe(0);

    const oversized = "z".repeat(MANAGED_REVIEW_CANDIDATE_MAX_FIELD_LENGTH + 250);
    const first = ledger.record(turn, {
      file: "a.ts",
      start_line: 1,
      end_line: 2,
      category: "performance",
      summary: oversized,
      mechanism: oversized,
    });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.data.recorded.summary).toHaveLength(
        MANAGED_REVIEW_CANDIDATE_MAX_FIELD_LENGTH,
      );
      expect(first.data.recorded.mechanism).toHaveLength(
        MANAGED_REVIEW_CANDIDATE_MAX_FIELD_LENGTH,
      );
    }

    for (let index = 1; index < MANAGED_REVIEW_CANDIDATE_MAX_PER_TURN; index += 1) {
      const added = ledger.record(turn, {
        file: `file-${index}.ts`,
        start_line: index,
        end_line: index,
        category: "correctness",
        summary: `Issue ${index}`,
        mechanism: `Detail ${index}`,
      });
      expect(added.ok).toBe(true);
    }

    const overflow = ledger.record(turn, {
      file: "overflow.ts",
      start_line: 1,
      end_line: 1,
      category: "correctness",
      summary: "One too many",
      mechanism: "Should hit the per-turn cap.",
    });
    expect(overflow).toMatchObject({ ok: false, code: "limit_exceeded" });
    expect(ledger.list(turn).total).toBe(MANAGED_REVIEW_CANDIDATE_MAX_PER_TURN);
  });
});

describe("managed review ledger MCP isolation and approval", () => {
  it("exposes only the 3 auto-approved ledger tools to managedReview Antigravity clients and hides them from normal clients", async () => {
    const ledger = new ManagedReviewCandidateLedger();
    const reviewRouter = buildManagedReviewLedgerToolRouter(ledger);
    let retireAtDispatch = false;
    const server = new AgentToolMcpServer({
      resolveCatalogs: (context) =>
        context.managedReview
          ? [{ id: "managed_review", router: reviewRouter }]
          : resolveAgentToolCatalogs({}, { taskMonitorRole: "all", antigravityMcpContext: true }),
      resolveCallContext: (context) =>
        context.threadId
          ? { backend: context.backend, threadId: context.threadId, turnId: "active-turn" }
          : undefined,
      authorizeToolCall: async (turn) => {
        if (retireAtDispatch) ledger.retireToolTurn(turn);
        return null;
      },
    });

    try {
      const reviewReg = await server.registerClient({
        backend: "acp:antigravity",
        managedReview: true,
      });
      const normalReg = await server.registerClient({
        backend: "acp:antigravity",
        threadId: "normal-thread",
      });

      const reviewClient = new Client({ name: "review-agent", version: "1.0.0" });
      const normalClient = new Client({ name: "normal-agent", version: "1.0.0" });
      await reviewClient.connect(
        new StreamableHTTPClientTransport(new URL(reviewReg.server.url), {
          requestInit: {
            headers: Object.fromEntries(
              reviewReg.server.headers.map(({ name, value }) => [name, value]),
            ),
          },
        }),
      );
      await normalClient.connect(
        new StreamableHTTPClientTransport(new URL(normalReg.server.url), {
          requestInit: {
            headers: Object.fromEntries(
              normalReg.server.headers.map(({ name, value }) => [name, value]),
            ),
          },
        }),
      );

      try {
        // Before bindThread (session/new timing): tools/list already returns ONLY the 3 ledger tools directly.
        const reviewTools = await reviewClient.listTools();
        expect(reviewTools.tools.map((tool) => tool.name).sort()).toEqual(
          [...MANAGED_REVIEW_LEDGER_TOOL_NAMES].sort(),
        );
        expect(reviewTools.tools.map((tool) => tool.name)).not.toContain("tool_search");
        expect(reviewTools.tools.map((tool) => tool.name)).not.toContain("call_pwragent_tool");

        // Every ledger tool skips operator approval in ACP.
        for (const name of MANAGED_REVIEW_LEDGER_TOOL_NAMES) {
          expect(pwragentToolSkipsAgentApproval(await reviewReg.readTool?.(name))).toBe(true);
        }

        // Normal Antigravity threads never see any ledger tool.
        const normalTools = await normalClient.listTools();
        for (const name of MANAGED_REVIEW_LEDGER_TOOL_NAMES) {
          expect(normalTools.tools.map((tool) => tool.name)).not.toContain(name);
        }
        await expect(
          normalClient.callTool({ name: "list_review_candidates", arguments: {} }),
        ).resolves.toMatchObject({ isError: true });

        // Bind review thread and execute Pass 1 -> Pass 2 calls.
        reviewReg.bindThread("review-child-thread");
        const turn = { backend: "acp:antigravity", threadId: "review-child-thread", turnId: "active-turn" } as const;
        ledger.armToolTurn(turn, turn.turnId);
        const recorded = await reviewClient.callTool({
          name: "record_review_candidate",
          arguments: {
            file: "apps/desktop/src/main/app-server/acp-backend-adapter.ts",
            start_line: 3585,
            end_line: 3586,
            category: "performance",
            summary: "Keep session database reads off the ACP streaming path",
            mechanism: "Calls synchronous getSession() on every streamed assistant chunk.",
          },
        });
        expect(recorded.isError).not.toBe(true);
        expect(recorded.structuredContent).toMatchObject({
          id: "C1",
          total_candidates: 1,
        });

        const listed = await reviewClient.callTool({
          name: "list_review_candidates",
          arguments: {},
        });
        expect(listed.isError).not.toBe(true);
        expect(listed.structuredContent).toMatchObject({
          total: 1,
          counts: { pending: 1, keep: 0, drop: 0 },
        });

        const disposed = await reviewClient.callTool({
          name: "dispose_review_candidate",
          arguments: {
            id: "C1",
            disposition: "keep",
            priority: 2,
            reason: "Verified on every non-tool assistant_message_chunk.",
          },
        });
        expect(disposed.isError).not.toBe(true);
        expect(disposed.structuredContent).toMatchObject({
          updated: { id: "C1", disposition: "keep", priority: 2 },
          summary: { pending: 0, keep: 1, drop: 0 },
        });
        retireAtDispatch = true;
        await expect(reviewClient.callTool({
          name: "dispose_review_candidate",
          arguments: { id: "C1", disposition: "drop", reason: "Arrived after terminal" },
        })).resolves.toMatchObject({ isError: true });
        expect(ledger.snapshot(turn)).toMatchObject({ keep: 1, drop: 0 });

        // General tools remain unreachable from a managed review client.
        await expect(
          reviewClient.callTool({ name: "handoff_task", arguments: { task: "nope" } }),
        ).resolves.toMatchObject({ isError: true });
      } finally {
        await reviewClient.close();
        await normalClient.close();
      }
    } finally {
      await server.close();
    }
  });
});

class ReviewListingAcpTransport extends FakeAcpAgentTransport {
  readonly sessions = new Map<string, { client?: Client; tools: string[]; serverNames: string[] }>();
  readonly prompts: string[] = [];
  private nextSession = 0;

  override async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (method === "session/new") {
      this.requests.push({ method, params });
      const sessionId = `review-acp-${++this.nextSession}`;
      const servers = (params?.mcpServers ?? []) as AgentToolHttpMcpServerConfig[];
      const httpServer = servers.find((candidate) => candidate.type === "http");
      if (httpServer) {
        const client = new Client({ name: "acp-review-agent", version: "1.0.0" });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(httpServer.url), {
            requestInit: {
              headers: Object.fromEntries(
                httpServer.headers.map(({ name, value }) => [name, value]),
              ),
            },
          }),
        );
        const { tools } = await client.listTools();
        this.sessions.set(sessionId, {
          client,
          tools: tools.map((tool) => tool.name).sort(),
          serverNames: servers.map((server) => server.name),
        });
      } else {
        this.sessions.set(sessionId, {
          tools: [],
          serverNames: servers.map((server) => server.name),
        });
      }
      return { sessionId };
    }
    if (method === "session/prompt") {
      const sessionId = String(params?.sessionId);
      const promptBlocks = (params?.prompt ?? []) as Array<{ text?: string }>;
      this.prompts.push(promptBlocks.map((block) => block.text ?? "").join("\n"));
      const session = this.sessions.get(sessionId);
      if (session?.client) {
        const recorded = await session.client.callTool({
          name: "record_review_candidate",
          arguments: {
            file: "/repo/src/main.ts",
            start_line: 10,
            end_line: 12,
            category: "correctness",
            summary: "Guard null path",
            mechanism: "Throws when input is empty.",
          },
        });
        expect(recorded.isError).not.toBe(true);
        const disposed = await session.client.callTool({
          name: "dispose_review_candidate",
          arguments: {
            id: "C1",
            disposition: "keep",
            priority: 2,
            reason: "Reproducible on empty input.",
          },
        });
        expect(disposed.isError).not.toBe(true);
      }
      this.emitSessionUpdate(sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: JSON.stringify({
            findings: [
              {
                title: "[P2] Guard null path",
                body: "Throws when input is empty.",
                confidence_score: 0.95,
                priority: 2,
                code_location: {
                  absolute_file_path: "/repo/src/main.ts",
                  line_range: { start: 10, end: 12 },
                },
              },
            ],
            overall_correctness: "patch is incorrect",
            overall_explanation: "Missing null guard.",
            overall_confidence_score: 0.95,
          }),
        },
      });
      this.requests.push({ method, params });
      return { stopReason: "end_turn" };
    }
    return await super.request(method, params, timeoutMs);
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map((session) => session.client?.close()),
    );
    this.sessions.clear();
  }
}

describe("ManagedReviewService candidate ledger lifecycle integration", () => {
  let stateDb: StateDb;

  beforeEach(() => {
    stateDb = openInMemoryStateDb();
  }, 60_000);

  afterEach(() => {
    stateDb.close();
  }, 60_000);

  it.each([false, true])("fences ACP ledger calls and clears candidates at terminal (card write fails: %s)", async (cardWriteFails) => {
    const backend = "acp:antigravity";
    const agentStore = new AcpAgentStore(stateDb);
    const sessionStore = new AcpSessionStore(stateDb);
    agentStore.upsertInstalledAgent({
      backendId: backend,
      registryId: "antigravity",
      name: "Antigravity",
      version: "1.5.15",
      distributionKind: "local",
      distributionSource: "antigravity",
      installStatus: "installed",
      authStatus: "not-required",
      verificationStatus: "not-applicable",
      allowlistRuleId: "fixture-antigravity",
      installedAt: 1,
      updatedAt: 1,
      launchDescriptor: {
        backendId: backend,
        registryId: "antigravity",
        distributionKind: "local",
        command: "/fixture/agy",
        args: ["acp"],
        env: {},
      },
    });
    const transport = new ReviewListingAcpTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true },
        },
      },
    });
    const overlayStore = createOverlayStoreMock();
    const upsert = overlayStore.upsertThreadSubAgent.bind(overlayStore);
    const lateCall = Promise.withResolvers<boolean>();
    vi.spyOn(overlayStore, "upsertThreadSubAgent").mockImplementation(async (params) => {
      if (params.subAgent.status === "success") {
        const reviewClient = [...transport.sessions.values()]
          .find((session) => session.tools.includes("record_review_candidate"))?.client;
        const response = await reviewClient!.callTool({
          name: "record_review_candidate",
          arguments: {
            file: "/repo/src/late.ts", start_line: 1, end_line: 1,
            category: "correctness", summary: "Late candidate", mechanism: "Terminal already arrived.",
          },
        });
        lateCall.resolve(response.isError === true);
        if (cardWriteFails) throw new Error("fixture terminal review card write failed");
      }
      return await upsert(params);
    });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      acpAgentStore: agentStore,
      acpSessionStore: sessionStore,
      createAcpTransport: () => transport,
      overlayStore,
      createScratchProjectDirectory: async () => "/tmp/pwragent-review-ledger",
      threadTitleGenerationService: null,
    });
    try {
      const parent = await registry.startThread({ backend, cwd: "/repo" });
      const review = await registry.startReview({
        backend,
        threadId: parent.threadId,
        target: { type: "uncommittedChanges" },
      });

      const reviewSession = transport.sessions.get(review.reviewThreadId);
      expect(reviewSession?.serverNames).toEqual([PWRAGENT_TOOL_NAMESPACE]);
      expect(reviewSession?.tools).toEqual(
        [...MANAGED_REVIEW_LEDGER_TOOL_NAMES].sort(),
      );
      expect(transport.prompts.at(-1)).toContain("record_review_candidate");
      expect(transport.prompts.at(-1)).toContain("list_review_candidates");
      expect(transport.prompts.at(-1)).toContain("dispose_review_candidate");

      expect.soft(await lateCall.promise).toBe(true);
      await vi.waitFor(() => {
        expect(
          registryModules(registry).managedReviewService.candidateLedger.activeTurnCount,
        ).toBe(0);
      });
    } finally {
      await transport.closeAll();
      await registry.close();
    }
  });

  it("falls back to the static prompt when an ACP reviewer lacks HTTP MCP support", async () => {
    const backend = "acp:grok";
    const agentStore = new AcpAgentStore(stateDb);
    const sessionStore = new AcpSessionStore(stateDb);
    agentStore.upsertInstalledAgent({
      backendId: backend,
      registryId: "grok",
      name: "Grok",
      version: "1.0.77",
      distributionKind: "local",
      distributionSource: "grok",
      installStatus: "installed",
      authStatus: "not-required",
      verificationStatus: "not-applicable",
      allowlistRuleId: "fixture-grok",
      installedAt: 1,
      updatedAt: 1,
      launchDescriptor: {
        backendId: backend,
        registryId: "grok",
        distributionKind: "local",
        command: "/fixture/grok",
        args: ["acp"],
        env: {},
      },
    });
    const transport = new ReviewListingAcpTransport({
      initialize: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: false },
        },
      },
    });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      acpAgentStore: agentStore,
      acpSessionStore: sessionStore,
      createAcpTransport: () => transport,
      overlayStore: createOverlayStoreMock(),
      createScratchProjectDirectory: async () => "/tmp/pwragent-review-static",
      threadTitleGenerationService: null,
    });
    try {
      const parent = await registry.startThread({ backend, cwd: "/repo" });
      const review = await registry.startReview({
        backend,
        threadId: parent.threadId,
        target: { type: "uncommittedChanges" },
      });

      const reviewSession = transport.sessions.get(review.reviewThreadId);
      expect(reviewSession?.serverNames).toEqual([]);
      expect(reviewSession?.tools).toEqual([]);
      expect(transport.prompts.at(-1)).not.toContain("record_review_candidate");
      expect(transport.prompts.at(-1)).not.toContain("list_review_candidates");
      expect(transport.prompts.at(-1)).not.toContain("dispose_review_candidate");
    } finally {
      await transport.closeAll();
      await registry.close();
    }
  });

  it("accepts only the provider-confirmed Codex review turn before startTurn returns", async () => {
    await fc.assert(fc.asyncProperty(fc.boolean(), async (holdStartedDelivery) => {
      const child = "codex-review-starting";
      const providerTurn = "provider-turn";
      const client = new MockBackendClient({
        initializeResult: { methods: ["thread/start", "turn/start"] },
        startThreadResult: { threadId: child },
      });
      const registry = createDesktopBackendRegistry({
        codexClient: client, overlayStore: createOverlayStoreMock(), threadTitleGenerationService: null,
      });
      const { threadArchiveCoordinator, turnState } = registryModules(registry);
      const gate = Promise.withResolvers<void>();
      const prepareArchive = threadArchiveCoordinator.prepareArchiveReferenceChanges.bind(threadArchiveCoordinator);
      vi.spyOn(threadArchiveCoordinator, "prepareArchiveReferenceChanges").mockImplementation((backend, notification) =>
        holdStartedDelivery && notification.method === "turn/started" && notification.params.threadId === child
          ? gate.promise
          : prepareArchive(backend, notification));
      const outcomes: boolean[] = [];
      vi.spyOn(client, "startTurn").mockImplementation(async () => {
        const delivery = client.emit({
          method: "turn/started",
          params: { threadId: child, turnId: providerTurn, turn: { id: providerTurn } },
        });
        try {
          if (holdStartedDelivery) {
            expect(turnState.pendingStartedTurnId(child)).toBe(providerTurn);
          } else {
            await delivery;
          }
          for (const turnId of ["unrelated-turn", providerTurn]) {
            const result = await client.emitRequest({
              method: "item/tool/call",
              params: {
                threadId: child, turnId, requestId: turnId, callId: turnId,
                namespace: PWRAGENT_TOOL_NAMESPACE, tool: "list_review_candidates", arguments: {},
              },
            }) as { success: boolean };
            outcomes.push(result.success);
          }
        } finally {
          gate.resolve();
          await delivery;
        }
        return { threadId: child, turnId: providerTurn };
      });
      try {
        await registry.startReview({
          backend: "codex", threadId: "parent", target: { type: "uncommittedChanges" },
          runMode: "pwragent-sub-agent",
        });
        expect(outcomes).toEqual([false, true]);
      } finally {
        await registry.close();
      }
    }), { numRuns: 2, examples: [[true], [false]] });
  });

  it("attaches dynamic ledger tools to Codex managed review children, refuses non-review threads, and clears on terminal", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
      models: [{ id: "gpt-6.1-terra", label: "GPT-6.1-Terra", current: true, supportsReasoning: true }],
    });
    let nextThreadNumber = 0;
    const startThreadSpy = vi.spyOn(codexClient, "startThread").mockImplementation(async () => ({
      threadId: `codex-thread-${++nextThreadNumber}`,
    }));
    const startTurnSpy = vi.spyOn(codexClient, "startTurn");
    const registry = createDesktopBackendRegistry({
      codexClient,
      acpAgentStore: new AcpAgentStore(stateDb),
      acpSessionStore: new AcpSessionStore(stateDb),
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: null,
    });

    try {
      const parent = await registry.startThread({ backend: "codex", cwd: "/repo" });
      const review = await registry.startReview({
        backend: "codex",
        threadId: parent.threadId,
        target: { type: "uncommittedChanges" },
        runMode: "pwragent-sub-agent",
      });
      expect(review.reviewThreadId).not.toBe(parent.threadId);

      const childStartCall = startThreadSpy.mock.calls.at(-1)?.[0];
      const dynamicSpecs = (childStartCall?.dynamicTools ?? []) as Array<
        { type?: string; name: string; tools?: Array<{ name: string }> }
      >;
      const dynamicNames = dynamicSpecs.flatMap((spec) =>
        spec.type === "namespace" && Array.isArray(spec.tools)
          ? spec.tools.map((tool) => tool.name)
          : [spec.name],
      );
      expect(dynamicNames).toEqual(
        expect.arrayContaining([...MANAGED_REVIEW_LEDGER_TOOL_NAMES]),
      );

      const childPrompt = startTurnSpy.mock.calls.at(-1)?.[0]?.input?.[0];
      expect(childPrompt && "text" in childPrompt ? childPrompt.text : "").toContain(
        "record_review_candidate",
      );

      // Active managed review child can call the ledger tools.
      const recordResponse = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: review.reviewThreadId,
          turnId: review.turnId,
          requestId: "req-1",
          callId: "call-1",
          namespace: PWRAGENT_TOOL_NAMESPACE,
          tool: "record_review_candidate",
          arguments: {
            file: "/repo/a.ts",
            start_line: 1,
            end_line: 3,
            category: "correctness",
            summary: "Fix leak",
            mechanism: "Timer is never cleared.",
          },
        },
      }) as { success: boolean };
      expect(recordResponse.success).toBe(true);
      expect(
        registryModules(registry).managedReviewService.candidateLedger.activeTurnCount,
      ).toBe(1);

      // A normal non-review Codex thread cannot call the ledger tools.
      registryModules(registry).turnState.registerTurn({
        backend: "codex",
        threadId: parent.threadId,
        turnId: "normal-turn",
      });
      const refused = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: parent.threadId,
          turnId: "normal-turn",
          requestId: "req-2",
          callId: "call-2",
          namespace: PWRAGENT_TOOL_NAMESPACE,
          tool: "list_review_candidates",
          arguments: {},
        },
      }) as { success: boolean; contentItems?: Array<{ text?: string }> };
      expect(refused.success).toBe(false);
      expect(refused.contentItems?.[0]?.text).toContain("forbidden");

      // Terminal failure/completion clears the in-memory ledger.
      await codexClient.emit({
        method: "turn/failed",
        params: {
          threadId: review.reviewThreadId,
          turnId: review.turnId,
          turn: {
            id: review.turnId,
            status: "failed",
            error: { message: "cancelled fixture" },
          },
        },
      });
      await vi.waitFor(() => {
        expect(
          registryModules(registry).managedReviewService.candidateLedger.activeTurnCount,
        ).toBe(0);
      });
    } finally {
      await registry.close();
    }
  });
});
