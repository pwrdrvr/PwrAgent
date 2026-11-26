import path, { join, resolve } from "node:path";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fc from "fast-check";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared/contracts/agent-tools";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import { AgentToolMcpServer, type AgentToolHttpMcpServerConfig } from "../agent-tools/agent-tool-mcp-server";
import { resolveAgentToolCatalogs } from "../agent-tools/agent-tool-catalog-registry";
import {
  buildManagedReviewLedgerToolRouter,
  MANAGED_REVIEW_LEDGER_TOOL_NAMES,
} from "../agent-tools/pwragent-managed-review-ledger-tools";
import { pwragentToolSkipsAgentApproval } from "../app-server/acp-host-tool-approval";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import { ManagedReviewCandidateLedger } from "../app-server/managed-review-candidate-ledger";
import { reviewEntryFindings } from "../../shared/review-output";
import type { StateDb } from "../state/state-db";
import { AcpAgentStore } from "../storage/acp-agent-store";
import { AcpSessionStore } from "../storage/acp-session-store";
import { createOverlayStoreMock, git, MockBackendClient } from "./helpers/backend-registry-fixture";
import { runIsolatedGit } from "./helpers/isolated-git";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const { registryLogInfo } = vi.hoisted(() => ({ registryLogInfo: vi.fn() }));
vi.mock("../log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../log")>();
  return {
    ...actual,
    getMainLogger: (scope: string) => {
      const logger = actual.getMainLogger(scope);
      return scope === "pwragent:backend-registry" ? { ...logger, info: registryLogInfo } : logger;
    },
  };
});

async function createNestedReviewCheckout() {
  const scratch = await mkdtemp(join(tmpdir(), "pwragent-review-ledger-"));
  onTestFinished(async () => await rm(scratch, { recursive: true, force: true }));
  const root = await realpath(scratch);
  const cwd = join(root, "packages", "app");
  await mkdir(cwd, { recursive: true });
  await runIsolatedGit(root, ["init", "-b", "main"]);
  const { stdout } = await runIsolatedGit(cwd, ["rev-parse", "--show-toplevel"]);
  return { cwd, root: resolve(stdout.trim()) };
}

describe("managed review ledger MCP isolation and approval", () => {
  it("exposes only the 4 auto-approved managed review tools to managedReview Antigravity clients and hides them from normal clients", async () => {
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
        // Before bindThread (session/new timing), tools/list already returns only the ledger tools.
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
        ledger.armToolTurn(turn, turn.turnId, { worktreeRoot: resolve("/repo") });
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

        const verdict = {
          use_ledger: true,
          overall_correctness: "patch is incorrect",
          overall_explanation: "Synchronous database read on streaming path.",
          overall_confidence_score: 0.95,
        };
        await expect(reviewClient.callTool({
          name: "submit_review_output",
          arguments: verdict,
        })).resolves.toMatchObject({ isError: true });
        expect(ledger.submittedOutput(turn)).toBeUndefined();

        const beforeRefining = ledger.list(turn);
        await expect(reviewClient.callTool({
          name: "dispose_review_candidate",
          arguments: {
            id: "C1",
            disposition: "keep",
            priority: 2,
            reason: "Verified on the streaming path.",
            summary: "Invalid attempted replacement",
            start_line: 3587,
          },
        })).resolves.toMatchObject({ isError: true });
        expect(ledger.list(turn)).toEqual(beforeRefining);

        const disposed = await reviewClient.callTool({
          name: "dispose_review_candidate",
          arguments: {
            id: "C1",
            disposition: "keep",
            priority: 2,
            reason: "Verified on every non-tool assistant_message_chunk.",
            mechanism: 'Calls synchronous `getSession()` on `"agent_message_chunk"` updates.',
            start_line: 3586,
            confidence_score: 0.96,
          },
        });
        expect(disposed.isError).not.toBe(true);
        expect(disposed.structuredContent).toMatchObject({
          updated: { id: "C1", disposition: "keep", priority: 2 },
          summary: { pending: 0, keep: 1, drop: 0 },
        });
        const submitted = await reviewClient.callTool({
          name: "submit_review_output",
          arguments: verdict,
        });
        expect(submitted.isError).not.toBe(true);
        const receipt = {
          finding_count: 1,
          ledger_summary: { total: 1, pending: 0, keep: 1, drop: 0 },
        };
        expect(submitted.structuredContent).toEqual(receipt);
        expect(JSON.stringify(submitted.content)).not.toContain("Calls synchronous");
        expect(ledger.submittedOutput(turn)?.findings).toEqual([{
          title: "Keep session database reads off the ACP streaming path",
          body: 'Calls synchronous `getSession()` on `"agent_message_chunk"` updates.',
          confidence_score: 0.96,
          priority: 2,
          category: "performance",
          code_location: {
            absolute_file_path: resolve("/repo/apps/desktop/src/main/app-server/acp-backend-adapter.ts"),
            line_range: { start: 3586, end: 3586 },
          },
        }]);
        retireAtDispatch = true;
        await expect(reviewClient.callTool({
          name: "dispose_review_candidate",
          arguments: { id: "C1", disposition: "drop", reason: "Arrived after terminal" },
        })).resolves.toMatchObject({ isError: true });
        await expect(reviewClient.callTool({
          name: "submit_review_output",
          arguments: verdict,
        })).resolves.toMatchObject({ isError: true });
        expect(ledger.snapshot(turn)).toMatchObject({ keep: 1, drop: 0 });
        expect(ledger.submittedOutput(turn)?.findings).toHaveLength(1);

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
  private readonly onPrompt?: (params: {
    sessionId: string;
    client?: Client;
    emitText: (text: string) => void;
  }) => Promise<void>;

  constructor(
    options?: ConstructorParameters<typeof FakeAcpAgentTransport>[0],
    onPrompt?: (params: {
      sessionId: string;
      client?: Client;
      emitText: (text: string) => void;
    }) => Promise<void>,
  ) {
    super(options);
    this.onPrompt = onPrompt;
  }

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
      const emitText = (text: string) => {
        this.emitSessionUpdate(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        });
      };
      if (this.onPrompt) {
        await this.onPrompt({ sessionId, client: session?.client, emitText });
      } else {
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
        emitText(JSON.stringify({
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
        }));
      }
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
    registryLogInfo.mockClear();
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
      expect(transport.prompts.at(-1)).toContain("submit_review_output");

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
      expect(transport.prompts.at(-1)).not.toContain("submit_review_output");
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
    const overlayStore = createOverlayStoreMock();
    const upsertReview = vi.spyOn(overlayStore, "upsertManagedReviewEntry");
    const registry = createDesktopBackendRegistry({
      codexClient,
      acpAgentStore: new AcpAgentStore(stateDb),
      acpSessionStore: new AcpSessionStore(stateDb),
      overlayStore,
      threadTitleGenerationService: null,
    });
    const onEvent = vi.fn<(event: AgentEvent) => void>();
    const unsubscribe = registry.onEvent(onEvent);

    try {
      const parent = await registry.startThread({ backend: "codex", cwd: resolve("/repo") });
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

      // Active managed review child can also call submit_review_output, and a
      // failed terminal discards it without publishing.
      const submitResponse = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: review.reviewThreadId,
          turnId: review.turnId,
          requestId: "req-submit",
          callId: "call-submit",
          namespace: PWRAGENT_TOOL_NAMESPACE,
          tool: "submit_review_output",
          arguments: {
            findings: [],
            overall_correctness: "patch is correct",
            overall_explanation: "No defects found before failure.",
          },
        },
      }) as { success: boolean };
      expect(submitResponse.success).toBe(true);
      expect(
        registryModules(registry).managedReviewService.candidateLedger.submittedOutput({
          backend: "codex",
          threadId: review.reviewThreadId,
          turnId: review.turnId,
        }),
      ).toMatchObject({ overall_correctness: "patch is correct" });

      // A failed provider turn must forward the failure and discard the submission.
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
      const parentReviewEvents = onEvent.mock.calls.map(([event]) => event.notification)
        .filter(({ params }) => "threadId" in params && params.threadId === parent.threadId
          && "turnId" in params && params.turnId === review.turnId);
      expect(parentReviewEvents.filter(({ method }) => method === "turn/failed")).toHaveLength(1);
      const resultId = `managed-review:${review.turnId}:result`;
      expect(parentReviewEvents).not.toContainEqual(expect.objectContaining({ method: "turn/completed" }));
      expect(parentReviewEvents).not.toContainEqual(expect.objectContaining({
        method: "item/completed",
        params: expect.objectContaining({ item: expect.objectContaining({ id: resultId }) }),
      }));
      expect(upsertReview).not.toHaveBeenCalledWith(expect.objectContaining({
        threadId: parent.threadId,
        entry: expect.objectContaining({ id: resultId }),
      }));
      expect(registryModules(registry).managedReviewService.candidateLedger.activeTurnCount).toBe(0);
      expect(
        registryModules(registry).managedReviewService.candidateLedger.submittedOutput({
          backend: "codex",
          threadId: review.reviewThreadId,
          turnId: review.turnId,
        }),
      ).toBeUndefined();
    } finally {
      unsubscribe();
      await registry.close();
    }
  });

  it.each(["explicit", "ledger"])("publishes %s ACP findings even when the terminal text is invalid JSON", async (mode) => {
    const { cwd, root } = await createNestedReviewCheckout();
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
    const findingBody = 'The `"remote-pin"` step and `"local-name"` step omit version checks.';
    const explicitFinding = {
      title: "Remote-pin test leaves owner-version wiring unfalsified",
      body: findingBody,
      confidence_score: 0.94,
      priority: 2,
      code_location: {
        absolute_file_path: resolve("/repo/apps/desktop/src/main/__tests__/navigation-query-source.test.ts"),
        line_range: { start: 1260, end: 1342 },
      },
    };
    const useLedger = mode === "ledger";
    let submitResult: { isError?: boolean; structuredContent?: unknown } | undefined;
    const transport = new ReviewListingAcpTransport(
      {
        initialize: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            mcpCapabilities: { http: true },
          },
        },
      },
      async ({ client, emitText }) => {
        if (!client) throw new Error("Managed review MCP tools were not attached.");
        if (useLedger) {
          expect((await client.callTool({
            name: "record_review_candidate",
            arguments: {
              file: "packages/app/src/disconnect.ts",
              start_line: 10,
              end_line: 11,
              category: "lifecycle",
              summary: "Unsubscribe on disconnect",
              mechanism: "The listener remains active after disconnect.",
            },
          })).isError).not.toBe(true);
          expect((await client.callTool({
            name: "dispose_review_candidate",
            arguments: { id: "C1", disposition: "keep", priority: 1, reason: "Disconnect skips cleanup." },
          })).isError).not.toBe(true);
        }
        submitResult = await client.callTool({
          name: "submit_review_output",
          arguments: {
            ...(useLedger ? { use_ledger: true } : {}),
            findings: [explicitFinding],
            overall_correctness: "patch is incorrect",
            overall_explanation: "Verified actionable defects.",
            overall_confidence_score: 0.93,
          },
        }) as { isError?: boolean; structuredContent?: unknown };
        // Even if the model also emits invalid JSON with unescaped quotes (the
        // real PR #4453 failure mode) or a short confirmation, the structured
        // tool submission wins.
        emitText('{"findings":[{"body":"broken `"remote-pin"` json"}]}');
      },
    );
    const overlayStore = createOverlayStoreMock();
    const publishedEntries: Array<{ id: string; review: string; output?: unknown }> = [];
    const upsertReview = overlayStore.upsertManagedReviewEntry.bind(overlayStore);
    vi.spyOn(overlayStore, "upsertManagedReviewEntry").mockImplementation(async (params) => {
      if (params.entry.id.endsWith(":result")) {
        publishedEntries.push(params.entry);
      }
      return await upsertReview(params);
    });
    const registry = createDesktopBackendRegistry({
      codexClient: new MockBackendClient({}),
      acpAgentStore: agentStore,
      acpSessionStore: sessionStore,
      createAcpTransport: () => transport,
      overlayStore,
      createScratchProjectDirectory: async () => "/tmp/pwragent-review-submit-tool",
      threadTitleGenerationService: null,
    });
    try {
      const parent = await registry.startThread({ backend, cwd });
      await registry.startReview({
        backend,
        threadId: parent.threadId,
        target: { type: "uncommittedChanges" },
      });

      await vi.waitFor(() => {
        expect(publishedEntries).toHaveLength(1);
      });
      expect(submitResult?.isError).not.toBe(true);
      expect(publishedEntries[0]?.output).toEqual({
        findings: [
          ...(useLedger ? [{
            title: "Unsubscribe on disconnect",
            body: "The listener remains active after disconnect.",
            category: "lifecycle",
            confidence_score: 0,
            priority: 1,
            code_location: {
              absolute_file_path: join(root, "packages", "app", "src", "disconnect.ts"),
              line_range: { start: 10, end: 11 },
            },
          }] : []),
          explicitFinding,
        ],
        overall_correctness: "patch is incorrect",
        overall_explanation: "Verified actionable defects.",
        overall_confidence_score: 0.93,
      });
      expect(publishedEntries[0]?.review).toContain("[P2] Remote-pin test leaves owner-version wiring unfalsified");
      expect(publishedEntries[0]?.review).not.toContain('{"findings"');
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

  it.each(["keep", "drop"] as const)("publishes a Codex ledger batch with a %s disposition and empty terminal text", async (disposition) => {
    const { cwd, root } = await createNestedReviewCheckout();
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
      models: [{ id: "gpt-6.1-terra", label: "GPT-6.1-Terra", current: true, supportsReasoning: true }],
    });
    let nextThreadNumber = 0;
    vi.spyOn(codexClient, "startThread").mockImplementation(async () => ({
      threadId: `codex-submit-thread-${++nextThreadNumber}`,
    }));
    const overlayStore = createOverlayStoreMock();
    const publishedEntries: Array<{ id: string; review: string; output?: unknown }> = [];
    const upsertReview = overlayStore.upsertManagedReviewEntry.bind(overlayStore);
    vi.spyOn(overlayStore, "upsertManagedReviewEntry").mockImplementation(async (params) => {
      if (params.entry.id.endsWith(":result")) {
        publishedEntries.push(params.entry);
      }
      return await upsertReview(params);
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      acpAgentStore: new AcpAgentStore(stateDb),
      acpSessionStore: new AcpSessionStore(stateDb),
      overlayStore,
      threadTitleGenerationService: null,
    });
    try {
      const parent = await registry.startThread({ backend: "codex", cwd });
      const review = await registry.startReview({
        backend: "codex",
        threadId: parent.threadId,
        cwd,
        target: { type: "uncommittedChanges" },
        runMode: "pwragent-sub-agent",
      });

      const call = async (tool: string, args: Record<string, unknown>) => await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: review.reviewThreadId,
          turnId: review.turnId,
          requestId: `req-${tool}`,
          callId: `call-${tool}`,
          namespace: PWRAGENT_TOOL_NAMESPACE,
          tool,
          arguments: args,
        },
      }) as { success: boolean };
      expect((await call("record_review_candidate", {
        summary: "Preserve quoted code span",
        mechanism: 'Keeps `"remote-pin"` intact.',
        category: "correctness",
        file: "packages/app/src/review.ts",
        start_line: 5,
        end_line: 9,
      })).success).toBe(true);
      const keep = disposition === "keep";
      expect((await call("dispose_review_candidate", {
        id: "C1",
        disposition,
        reason: keep ? "Verified for malformed input." : "The caller preserves the span.",
        ...(keep ? { priority: 1 } : {}),
      })).success).toBe(true);
      const verdict = {
        overall_correctness: keep ? "patch is incorrect" : "patch is correct",
        overall_explanation: keep ? "One defect found." : "No actionable defects.",
      };
      expect((await call("submit_review_output", { use_ledger: true, ...verdict })).success).toBe(true);
      expect(publishedEntries).toHaveLength(0);

      await codexClient.emit({
        method: "turn/completed",
        params: {
          threadId: review.reviewThreadId,
          turnId: review.turnId,
          turn: {
            id: review.turnId,
            status: "completed",
            output: [],
          },
        },
      });

      await vi.waitFor(() => {
        expect(publishedEntries).toHaveLength(1);
      });
      expect(publishedEntries[0]?.output).toMatchObject({
        ...verdict,
        findings: keep ? [
          {
            title: "Preserve quoted code span",
            body: 'Keeps `"remote-pin"` intact.',
            priority: 1,
            code_location: {
              absolute_file_path: join(root, "packages", "app", "src", "review.ts"),
              line_range: { start: 5, end: 9 },
            },
          },
        ] : [],
      });
      expect(publishedEntries[0]?.review).toContain(
        keep ? "[P1] Preserve quoted code span" : "No findings.",
      );
      expect(
        registryModules(registry).managedReviewService.candidateLedger.activeTurnCount,
      ).toBe(0);
    } finally {
      await registry.close();
    }
  });

  it("publishes Codex submit_review_output ahead of kept candidates when terminal text is empty", async () => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
      models: [{ id: "gpt-6.1-terra", label: "GPT-6.1-Terra", current: true, supportsReasoning: true }],
    });
    let nextThreadNumber = 0;
    vi.spyOn(codexClient, "startThread").mockImplementation(async () => ({
      threadId: `codex-submit-thread-${++nextThreadNumber}`,
    }));
    const overlayStore = createOverlayStoreMock();
    const publishedEntries: Array<{ id: string; review: string; output?: unknown }> = [];
    const upsertReview = overlayStore.upsertManagedReviewEntry.bind(overlayStore);
    vi.spyOn(overlayStore, "upsertManagedReviewEntry").mockImplementation(async (params) => {
      if (params.entry.id.endsWith(":result")) {
        publishedEntries.push(params.entry);
      }
      return await upsertReview(params);
    });
    const registry = createDesktopBackendRegistry({
      codexClient,
      acpAgentStore: new AcpAgentStore(stateDb),
      acpSessionStore: new AcpSessionStore(stateDb),
      overlayStore,
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

      const { candidateLedger } = registryModules(registry).managedReviewService;
      const turn = { backend: "codex" as const, threadId: review.reviewThreadId, turnId: review.turnId };
      const candidate = candidateLedger.record(turn, {
        file: resolve("/repo/src/earlier.ts"),
        start_line: 1,
        end_line: 2,
        category: "correctness",
        summary: "Earlier candidate",
        mechanism: "The final review revises this observation.",
      });
      expect(candidate).toMatchObject({ ok: true, data: { recorded: { id: "C1" } } });
      expect(candidateLedger.dispose(turn, {
        id: "C1",
        disposition: "keep",
        priority: 2,
        reason: "Verified during triage.",
      })).toMatchObject({ ok: true });

      const submitResponse = await codexClient.emitRequest({
        method: "item/tool/call",
        params: {
          threadId: review.reviewThreadId,
          turnId: review.turnId,
          requestId: "req-codex-submit",
          callId: "call-codex-submit",
          namespace: PWRAGENT_TOOL_NAMESPACE,
          tool: "submit_review_output",
          arguments: {
            findings: [
              {
                title: "Preserve quoted code span",
                body: 'Keeps `"remote-pin"` intact.',
                confidence_score: 0.91,
                priority: 1,
                code_location: {
                  absolute_file_path: resolve("/repo/src/review.ts"),
                  line_range: { start: 5, end: 9 },
                },
              },
            ],
            overall_correctness: "patch is incorrect",
            overall_explanation: "One defect found.",
            overall_confidence_score: 0.9,
          },
        },
      }) as { success: boolean };
      expect(submitResponse.success).toBe(true);

      await codexClient.emit({
        method: "turn/completed",
        params: {
          threadId: review.reviewThreadId,
          turnId: review.turnId,
          turn: {
            id: review.turnId,
            status: "completed",
            output: [],
          },
        },
      });

      await vi.waitFor(() => {
        expect(publishedEntries).toHaveLength(1);
      });
      expect(publishedEntries[0]?.output).toMatchObject({
        overall_correctness: "patch is incorrect",
        overall_explanation: "One defect found.",
        findings: [
          {
            title: "Preserve quoted code span",
            body: 'Keeps `"remote-pin"` intact.',
            priority: 1,
          },
        ],
      });
      expect(publishedEntries[0]?.review).toContain("[P1] Preserve quoted code span");
      expect(
        registryModules(registry).managedReviewService.candidateLedger.activeTurnCount,
      ).toBe(0);
    } finally {
      await registry.close();
    }
  });

  it.each([
    { source: "text", text: '{"findings":[', published: '{"findings":[' },
    { source: "none", text: "  ", published: "Review completed without output." },
  ])("attributes unstructured fallback reviews to $source", async ({ source, text, published }) => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
      models: [{ id: "gpt-6.1-terra", label: "GPT-6.1-Terra", current: true, supportsReasoning: true }],
    });
    let nextThreadNumber = 0;
    vi.spyOn(codexClient, "startThread").mockImplementation(async () => ({
      threadId: `codex-fallback-thread-${++nextThreadNumber}`,
    }));
    const overlayStore = createOverlayStoreMock();
    const upsertReview = vi.spyOn(overlayStore, "upsertManagedReviewEntry");
    const registry = createDesktopBackendRegistry({
      codexClient,
      acpAgentStore: new AcpAgentStore(stateDb),
      acpSessionStore: new AcpSessionStore(stateDb),
      overlayStore,
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
      await codexClient.emit({
        method: "turn/completed",
        params: {
          threadId: review.reviewThreadId,
          turnId: review.turnId,
          turn: { id: review.turnId, status: "completed", output: [{ type: "text", text }] },
        },
      });
      expect(upsertReview).toHaveBeenCalledWith(expect.objectContaining({
        threadId: parent.threadId,
        entry: expect.objectContaining({ id: `managed-review:${review.turnId}:result`, review: published }),
      }));
      expect(registryLogInfo).toHaveBeenCalledWith("managed review artifact published", expect.objectContaining({
        turnId: review.turnId,
        structured: false,
        outputSource: source,
      }));
    } finally {
      await registry.close();
    }
  });

  it.each([
    {
      name: "recovers kept findings from the checkout root when final review JSON has a syntax error",
      output: '{"findings":[{"title":"Broken","body":"Scans `["main", "master"]` directly"}],"overall_correctness":"patch is incorrect"}',
      recovered: true,
    },
    {
      name: "preserves a readable plain-text final review when the ledger has kept findings",
      output: [
        "The final review corrected the first finding and found a second issue.",
        "",
        "Review comments:",
        "",
        "- [P1] Keep the merge guard — /repo/src/a.ts:14-16",
        "  The retry path bypasses the merge guard.",
        "",
        "- [P2] Flush the queue — /repo/src/e.ts:4",
        "  The queue never flushes after the retry.",
      ].join("\n"),
      recovered: false,
    },
  ])("$name", async ({ output, recovered }) => {
    const codexClient = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
      models: [{ id: "gpt-6.1-terra", label: "GPT-6.1-Terra", current: true, supportsReasoning: true }],
    });
    let nextThreadNumber = 0;
    vi.spyOn(codexClient, "startThread").mockImplementation(async () => ({
      threadId: `codex-thread-${++nextThreadNumber}`,
    }));
    const registry = createDesktopBackendRegistry({
      codexClient,
      acpAgentStore: new AcpAgentStore(stateDb),
      acpSessionStore: new AcpSessionStore(stateDb),
      overlayStore: createOverlayStoreMock(),
      threadTitleGenerationService: null,
    });
    const events: Array<{ notification: { method: string; params: Record<string, unknown> } }> = [];
    const unsubscribe = registry.onEvent((event) => {
      events.push(event as unknown as { notification: { method: string; params: Record<string, unknown> } });
    });

    try {
      const repo = await mkdtemp(path.join(tmpdir(), "pwragent-managed-review-ledger-"));
      onTestFinished(() => rm(repo, { recursive: true, force: true }));
      await git(repo, ["init", "-b", "main"]);
      const cwd = path.join(repo, "packages", "ui");
      await mkdir(cwd, { recursive: true });
      const checkoutRoot = await git(cwd, ["rev-parse", "--show-toplevel"]);
      const parent = await registry.startThread({ backend: "codex", cwd });
      const review = await registry.startReview({
        backend: "codex",
        threadId: parent.threadId,
        target: { type: "uncommittedChanges" },
        runMode: "pwragent-sub-agent",
      });

      const callLedgerTool = async (
        requestId: string,
        tool: string,
        args: Record<string, unknown>,
      ) =>
        (await codexClient.emitRequest({
          method: "item/tool/call",
          params: {
            threadId: review.reviewThreadId,
            turnId: review.turnId,
            requestId,
            callId: `call-${requestId}`,
            namespace: PWRAGENT_TOOL_NAMESPACE,
            tool,
            arguments: args,
          },
        })) as { success: boolean };

      expect(
        (await callLedgerTool("r1", "record_review_candidate", {
          file: "packages/ui/src/b.ts",
          start_line: 20,
          end_line: 24,
          category: "parity",
          summary: "Lower priority parity bug",
          mechanism: "Live transcript drops line bounds.",
        })).success,
      ).toBe(true);
      expect(
        (await callLedgerTool("r2", "record_review_candidate", {
          file: "/repo/src/a.ts",
          start_line: 10,
          end_line: 12,
          category: "correctness",
          summary: "Higher priority safety bug",
          mechanism: "Merge runner skips neverMerge guard.",
        })).success,
      ).toBe(true);
      expect(
        (await callLedgerTool("r3", "record_review_candidate", {
          file: "src/c.ts",
          start_line: 5,
          end_line: 5,
          category: "standards",
          summary: "Dropped nitpick",
          mechanism: "Already guarded by caller.",
        })).success,
      ).toBe(true);
      expect(
        (await callLedgerTool("r4", "record_review_candidate", {
          file: "src/d.ts",
          start_line: 1,
          end_line: 1,
          category: "testing",
          summary: "Unsettled pending candidate",
          mechanism: "Never dispositioned.",
        })).success,
      ).toBe(true);

      expect(
        (await callLedgerTool("d1", "dispose_review_candidate", {
          id: "C1",
          disposition: "keep",
          priority: 2,
          reason: "Verified live/replay divergence.",
        })).success,
      ).toBe(true);
      expect(
        (await callLedgerTool("d2", "dispose_review_candidate", {
          id: "C2",
          disposition: "keep",
          priority: 1,
          reason: "Verified bypass path.",
        })).success,
      ).toBe(true);
      expect(
        (await callLedgerTool("d3", "dispose_review_candidate", {
          id: "C3",
          disposition: "drop",
          reason: "Caller guard verified.",
        })).success,
      ).toBe(true);

      await codexClient.emit({
        method: "item/completed",
        params: {
          threadId: review.reviewThreadId,
          turnId: review.turnId,
          item: {
            id: "assistant-final",
            type: "agentMessage",
            text: output,
          },
        },
      });
      await codexClient.emit({
        method: "turn/completed",
        params: {
          threadId: review.reviewThreadId,
          turnId: review.turnId,
          turn: { id: review.turnId, status: "completed", output: [] },
        },
      });

      await vi.waitFor(() => {
        const exited = events.find(
          (e) =>
            e.notification.method === "item/completed"
            && e.notification.params.threadId === parent.threadId
            && (e.notification.params.item as { type?: string } | undefined)?.type === "exitedReviewMode",
        );
        expect(exited).toBeDefined();
        const item = exited!.notification.params.item as {
          review: string;
          data?: {
            reviewOutput?: {
              overall_correctness: string;
              findings: Array<{
                title: string;
                priority: number;
                code_location: { absolute_file_path: string; line_range: { start: number; end: number } };
              }>;
            };
          };
        };
        // A final report the transcript can read owns its own text and findings.
        if (!recovered) {
          expect(item.review).toBe(output);
          expect(item.data?.reviewOutput).toBeUndefined();
          expect(reviewEntryFindings(item).map((finding) => finding.title)).toEqual([
            "Keep the merge guard",
            "Flush the queue",
          ]);
          return;
        }
        expect(item.data?.reviewOutput?.overall_correctness).toBe("patch is incorrect");
        expect(item.data?.reviewOutput?.findings).toHaveLength(2);
        expect(item.data?.reviewOutput?.findings[0]).toMatchObject({
          title: "Higher priority safety bug",
          priority: 1,
          code_location: {
            absolute_file_path: "/repo/src/a.ts",
            line_range: { start: 10, end: 12 },
          },
        });
        expect(item.data?.reviewOutput?.findings[1]).toMatchObject({
          title: "Lower priority parity bug",
          priority: 2,
          code_location: {
            absolute_file_path: path.join(checkoutRoot, "packages", "ui", "src", "b.ts"),
            line_range: { start: 20, end: 24 },
          },
        });
      });
      expect(
        registryModules(registry).managedReviewService.candidateLedger.activeTurnCount,
      ).toBe(0);
    } finally {
      unsubscribe();
      await registry.close();
    }
  });
});
