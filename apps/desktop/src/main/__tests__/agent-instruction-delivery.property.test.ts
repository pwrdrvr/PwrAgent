import { ProfileThreadOwnerAdmission } from "@pwragent/owner-core/thread-owner-admission";
import { RuntimeLeaseManager } from "@pwragent/owner-core/runtime-lease-manager";
import { AppRuntimeInstanceStore } from "@pwragent/sqlite-storage/app-runtime-instance-store";
import type { Query, SDKMessage, SDKUserMessage, query } from "@anthropic-ai/claude-agent-sdk";
import fc from "fast-check";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildAgentMemoryContext } from "@pwragent/shared/contracts/agent-memory";
import { buildThreadIdentityKey } from "@pwragent/shared/contracts/navigation";
import { STAR_MAP_MANAGER_AGENT_INSTRUCTIONS } from "@pwragent/shared/contracts/star-map";
import { type AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpAgentClient } from "../acp/acp-client";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import {
  ACP_AGENT_INSTRUCTIONS_CLOSE_MARKER,
  ACP_AGENT_INSTRUCTIONS_OPEN_MARKER,
  buildAcpAgentInstructionBlock,
  stripAcpAgentInstructionBlock,
  stripAcpAgentInstructionChunk,
} from "../../shared/agent-instruction-delivery";
import { openStarMapManagerThread } from "../star-map/star-map-manager-thread";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { StateDb } from "../state/state-db";
import { AcpAgentStore } from "../storage/acp-agent-store";
import { AcpSessionStore } from "../storage/acp-session-store";
import { createAcpPromptSettlement } from "./fixtures/acp-prompt-settlement";
import { AgentInstructionCodexTransport } from "./fixtures/agent-instruction-transport";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, openInMemoryStateDb } from "./sqlite-test-utils";

// Rule: a turn on a designated Agent carries the Agent's current instruction
// text to the provider, on every backend. An edit reaches the next turn and
// not the one that is running. A thread whose instructions live in a file in
// its own workspace receives them from that file and from nowhere else.
//
// Every assertion reads the request the provider was sent: the Codex App
// Server JSON-RPC frames, the ACP `session/new` and `session/prompt` frames,
// and the options the Claude Agent SDK query was started with.

vi.mock("../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock("../codex-app-server/stdio-transport", async () => ({
  StdioJsonRpcTransport: (await import("./fixtures/agent-instruction-transport")).AgentInstructionCodexTransport,
}));

const ACP = "acp:fixture" as const;
const FIRST = "FIRST-INSTRUCTIONS answer only in haiku";
const SECOND = "SECOND-INSTRUCTIONS answer only in limericks";
const agent = (instructions: string) => ({ name: "Fixture Agent", instructions });
const text = (value: string) => [{ type: "text" as const, text: value }];

const registries: DesktopBackendRegistry[] = [];
const databases: StateDb[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  for (const db of databases.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  AgentInstructionCodexTransport.reset();
  vi.unstubAllEnvs();
});

/** An ACP agent whose prompt stays open until the test finishes the turn. */
class HeldPromptTransport extends FakeAcpAgentTransport {
  hold = false;
  private readonly finishers: Array<() => void> = [];

  constructor() {
    super({ initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  }

  override async request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (method !== "session/prompt") return await super.request(method, params, timeoutMs);
    this.requests.push({ method, params });
    if (this.hold) await new Promise<void>((resolve) => { this.finishers.push(resolve); });
    return { stopReason: "end_turn" };
  }

  finishTurn(): void {
    this.finishers.shift()?.();
  }

  prompts(): string[] {
    return this.requests
      .filter((request) => request.method === "session/prompt")
      .map((request) => JSON.stringify(request.params?.prompt));
  }
}

type ClaudeLaunch = { systemPrompt: unknown; prompts: number; resume?: string; memory: unknown[] };

/** A Claude Code process that records the options it was launched with. */
function recordingClaudeQuery(launches: ClaudeLaunch[]) {
  return vi.fn((args: Parameters<typeof query>[0]) => {
    const launch: ClaudeLaunch = { systemPrompt: args.options?.systemPrompt, prompts: 0, resume: args.options?.resume, memory: [] };
    launches.push(launch);
    const prompt = args.prompt as AsyncIterable<SDKUserMessage>;
    async function* run(): AsyncGenerator<SDKMessage> {
      yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd" } as SDKMessage;
      for await (const message of prompt) {
        launch.prompts += 1;
        for (const matcher of args.options?.hooks?.UserPromptSubmit ?? []) {
          for (const hook of matcher.hooks) {
            const result = await hook({
              hook_event_name: "UserPromptSubmit", session_id: "fixture", transcript_path: "", cwd: "/", prompt: "fixture",
            }, undefined, { signal: AbortSignal.abort() });
            if ("hookSpecificOutput" in result && result.hookSpecificOutput?.hookEventName === "UserPromptSubmit") {
              launch.memory.push(result.hookSpecificOutput.additionalContext);
            }
          }
        }
        yield { type: "assistant", parent_tool_use_id: null, message: { id: `answer-${launch.prompts}`, content: [{ type: "text", text: "OK" }] } } as SDKMessage;
        yield { type: "result", subtype: "success", is_error: false, result: "OK",
          ...(message.uuid ? { user_message_uuids: [message.uuid] } : {}) } as unknown as SDKMessage;
      }
    }
    return Object.assign(run(), {
      close: vi.fn(),
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
      setMcpServers: vi.fn().mockResolvedValue({ added: [], removed: [], errors: {} }),
    }) as unknown as Query;
  });
}

async function createFixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-agent-instructions-")));
  roots.push(root);
  vi.stubEnv("PWRAGENT_HOME", path.join(root, "profile-root"));
  const { dbPath, tempDir } = createTempStateDb("pwragent-agent-instructions-db-");
  roots.push(tempDir);
  const acpTransport = new HeldPromptTransport();
  const claudeLaunches: ClaudeLaunch[] = [];
  const completedClaudeTurns = { count: 0 };
  /** A registry over the same profile database, as after an app restart. */
  const open = (ownerId?: string) => {
    const db = StateDb.open(dbPath);
    databases.push(db);
    const overlayStore = new SqliteOverlayStore(db);
    const acpAgentStore = new AcpAgentStore(db);
    acpAgentStore.upsertInstalledAgent({ backendId: ACP, registryId: "fixture", name: "Fixture ACP",
      distributionKind: "local", distributionSource: "fixture", installStatus: "installed", authStatus: "not-required",
      verificationStatus: "not-applicable", allowlistRuleId: "fixture", installedAt: 1, updatedAt: 1,
      launchDescriptor: { backendId: ACP, registryId: "fixture", distributionKind: "local", command: process.execPath, args: [], env: {}, cwd: root },
      runtimeCapabilities: { schemaVersion: 1, status: "discovered", checkedAt: 1, agentCapabilities: { loadSession: true } } });
    const registry = createDesktopBackendRegistry({
      codexClient: new CodexAppServerClient({ directoryResolver: async () => [] }),
      overlayStore, messagingStore: null, threadTitleGenerationService: null,
      ...(ownerId ? { ownerAdmission: new ProfileThreadOwnerAdmission(new RuntimeLeaseManager({
        instanceId: ownerId, profileName: "default", processId: process.pid, startedAt: 1000,
        cwd: root, now: () => 2000, systemBootedAt: 0, runtimeIdentityIsAlive: () => true,
        store: new AppRuntimeInstanceStore(db),
      })) } : {}),
      runtimeInstanceId: `agent-instructions-${registries.length}`, resolveLiveProfileRuntimeInstanceIds: () => [],
      claudeBackendOptions: {
        store: new ClaudeSessionStore(path.join(root, "claude")),
        query: recordingClaudeQuery(claudeLaunches),
        getSessionInfo: vi.fn().mockResolvedValue(undefined),
        discoverModels: vi.fn().mockResolvedValue([]),
        inspectInstallation: vi.fn(async () => ({ executable: "/fixture/claude", authStatus: "signed-in" as const })),
        resolveEnv: async () => ({ PATH: "/fixture" }),
      },
      acpAgentStore, acpSessionStore: new AcpSessionStore(db),
      createAcpTransport: () => acpTransport, discoverLocalAcpAgents: async () => [],
    });
    registry.onEvent((event) => {
      if (event.backend === "claude" && event.notification.method === "turn/completed") completedClaudeTurns.count += 1;
    });
    registries.push(registry);
    return { registry, overlayStore };
  };
  return { root, open, acpTransport, claudeLaunches, completedClaudeTurns };
}

const codexFrames = (method: string) => AgentInstructionCodexTransport.sent(method);
const codexWire = () => JSON.stringify(AgentInstructionCodexTransport.requests);

/** End the running Codex turn the way the App Server reports it. */
function completeCodexTurn(threadId: string, turnId: string): void {
  AgentInstructionCodexTransport.notify("turn/completed", {
    threadId, turn: { id: turnId, status: "completed", items: [] },
  });
}

describe("a turn on a designated Agent carries its instructions to the provider", () => {
  it("Codex: as developer instructions when the thread starts and on every resume", async () => {
    const { root, open } = await createFixture();
    const first = open();
    const started = await first.registry.startThread({ backend: "codex", cwd: root, agent: agent(FIRST) });
    await first.registry.startTurn({ backend: "codex", threadId: started.threadId, input: text("hello") });
    expect(codexFrames("thread/start").map((frame) => frame.developerInstructions)).toEqual([FIRST]);
    // Codex shows them to the model itself: the turn adds no second copy.
    expect(JSON.stringify(codexFrames("turn/start"))).not.toContain("FIRST-INSTRUCTIONS");

    // After a restart the thread is loaded again by whichever resume comes
    // first. Codex keeps what that resume carries until the session ends, and
    // re-sends it to the model after each compaction.
    await first.registry.close();
    registries.splice(registries.indexOf(first.registry), 1);
    AgentInstructionCodexTransport.requests = [];
    const second = open();
    await second.registry.startTurn({ backend: "codex", threadId: started.threadId, input: text("again") });
    const methods = AgentInstructionCodexTransport.requests.map((request) => request.method);
    expect(methods.indexOf("thread/resume")).toBeGreaterThan(-1);
    expect(methods.indexOf("thread/resume")).toBeLessThan(methods.indexOf("turn/start"));
    expect(codexFrames("thread/resume").map((frame) => [frame.threadId, frame.developerInstructions]))
      .toEqual(codexFrames("thread/resume").map(() => [started.threadId, FIRST]));
  });

  it("Codex: on a resume sent for compaction, which can be the one that loads the thread", async () => {
    const { root, open } = await createFixture();
    const first = open();
    const started = await first.registry.startThread({ backend: "codex", cwd: root, agent: agent(FIRST) });
    await first.registry.startTurn({ backend: "codex", threadId: started.threadId, input: text("hello") });
    await first.registry.close();
    registries.splice(registries.indexOf(first.registry), 1);
    AgentInstructionCodexTransport.requests = [];
    const second = open();
    await second.registry.compactThread({ backend: "codex", threadId: started.threadId });
    expect(codexFrames("thread/resume").map((frame) => frame.developerInstructions)).toEqual([FIRST]);
  });

  it("ACP: at the front of the prompt, once per agent session", async () => {
    const { root, open, acpTransport } = await createFixture();
    const { registry } = open();
    const started = await registry.startThread({ backend: ACP, cwd: root, agent: agent(FIRST) });
    await registry.startTurn({ backend: ACP, threadId: started.threadId, input: text("hello") });
    await vi.waitFor(() => expect(acpTransport.prompts()).toHaveLength(1));
    // ACP has no instruction field: session/new cannot carry them.
    expect(JSON.stringify(acpTransport.requests.filter((request) => request.method === "session/new")))
      .not.toContain("FIRST-INSTRUCTIONS");
    const prompt = acpTransport.requests.find((request) => request.method === "session/prompt")!.params!.prompt as Array<{ type: string; text: string }>;
    expect(prompt).toEqual([
      { type: "text", text: buildAcpAgentInstructionBlock(FIRST) },
      { type: "text", text: "hello" },
      { type: "text", text: buildAgentMemoryContext("") },
    ]);
    expect(prompt[0]!.text).toContain(FIRST);

    await vi.waitFor(() => expect(registry.getThreadInfo({ backend: ACP, threadId: started.threadId })).toBeDefined());
    await vi.waitFor(async () => {
      await registry.startTurn({ backend: ACP, threadId: started.threadId, input: text("second") });
    });
    await vi.waitFor(() => expect(acpTransport.prompts()).toHaveLength(2));
    // The session already holds them: a second copy would only spend context.
    expect(acpTransport.prompts()[1]).not.toContain("FIRST-INSTRUCTIONS");
  });

  it("Claude: appended to the system prompt", async () => {
    const { root, open, claudeLaunches, completedClaudeTurns } = await createFixture();
    const { registry } = open();
    const started = await registry.startThread({ backend: "claude", cwd: root, agent: agent(FIRST) });
    await registry.startTurn({ backend: "claude", threadId: started.threadId, input: text("hello") });
    await vi.waitFor(() => expect(completedClaudeTurns.count).toBe(1));
    expect(claudeLaunches).toHaveLength(1);
    expect(claudeLaunches[0]!.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: FIRST });
  });
});

describe("an instruction edit reaches the next turn and not the running one", () => {
  it("Codex: a reload owed since before the first turn stays owed when its resume fails", async () => {
    AgentInstructionCodexTransport.capabilities = {
      codeModeOutputReducer: { protocolVersion: 1, dynamicToolsResumeField: "dynamicTools" },
    };
    const { root, open } = await createFixture();
    const { registry } = open();
    const started = await registry.startThread({ backend: "codex", cwd: root, agent: agent(FIRST) });
    const identity = { backend: "codex" as const, threadId: started.threadId };
    // Removed before the first turn: the thread has no rollout to reload from.
    await registry.setThreadAgent({ ...identity, agent: agent("") });
    const first = await registry.startTurn({ ...identity, input: text("one") });
    completeCodexTurn(started.threadId, first.turnId);

    AgentInstructionCodexTransport.failNext = "thread/resume";
    await vi.waitFor(async () => {
      await expect(registry.startTurn({ ...identity, input: text("two") })).rejects.toThrow();
      expect(AgentInstructionCodexTransport.failNext).toBeUndefined();
    });
    AgentInstructionCodexTransport.requests = [];
    await vi.waitFor(async () => {
      await registry.startTurn({ ...identity, input: text("three") });
    });
    // An empty override is what makes Codex load the thread without the old text.
    expect(codexFrames("thread/resume").map((frame) => frame.developerInstructions)).toContain("");
  });

  it("Codex: the change waits for the turn to end, then reloads the thread and tells the model", async () => {
    AgentInstructionCodexTransport.capabilities = {
      codeModeOutputReducer: { protocolVersion: 1, dynamicToolsResumeField: "dynamicTools" },
    };
    const { root, open } = await createFixture();
    const { registry } = open();
    const started = await registry.startThread({ backend: "codex", cwd: root, agent: agent(FIRST) });
    const identity = { backend: "codex" as const, threadId: started.threadId };
    const running = await registry.startTurn({ ...identity, input: text("hello") });

    const queued = await registry.setThreadAgent({ ...identity, agent: agent(SECOND) });
    expect(queued.queuedAgentChange?.agent).toMatchObject({ instructions: SECOND });
    // Nothing reaches the provider while the turn runs.
    expect(codexWire()).not.toContain("SECOND-INSTRUCTIONS");
    expect(await registry.getThreadAgentMetadata(identity)).toMatchObject({ instructions: FIRST });

    completeCodexTurn(started.threadId, running.turnId);
    await vi.waitFor(async () => {
      expect(await registry.getThreadAgentMetadata(identity)).toMatchObject({ instructions: SECOND });
    });
    const methods = AgentInstructionCodexTransport.requests.map((request) => request.method);
    const unsubscribed = methods.indexOf("thread/unsubscribe");
    const reloaded = methods.lastIndexOf("thread/resume");
    const told = methods.indexOf("thread/inject_items");
    // Codex applies new developer instructions only to a thread it loads, and
    // loads an idle thread again only when nobody is subscribed to it.
    expect(unsubscribed).toBeGreaterThan(methods.indexOf("turn/start"));
    expect(reloaded).toBeGreaterThan(unsubscribed);
    expect(told).toBeGreaterThan(reloaded);
    expect(codexFrames("thread/resume").at(-1)?.developerInstructions).toBe(SECOND);
    const injected = JSON.stringify(codexFrames("thread/inject_items"));
    expect(codexFrames("thread/inject_items")).toHaveLength(1);
    expect(codexFrames("thread/inject_items")[0]).toMatchObject({
      threadId: started.threadId, items: [{ type: "message", role: "developer" }],
    });
    expect(injected).toContain(SECOND);
    expect(injected).not.toContain("FIRST-INSTRUCTIONS");

    await registry.startTurn({ ...identity, input: text("next") });
    const after = AgentInstructionCodexTransport.requests.map((request) => request.method);
    expect(after.lastIndexOf("turn/start")).toBeGreaterThan(after.indexOf("thread/inject_items"));
    // Every resume since the change carries the new text, never the old one.
    const since = AgentInstructionCodexTransport.requests.slice(unsubscribed)
      .filter((request) => request.method === "thread/resume");
    expect(since.length).toBeGreaterThan(1);
    expect(since.map((resume) => resume.params.developerInstructions)).toEqual(since.map(() => SECOND));
  });

  it("ACP: the running prompt keeps its text and the next prompt carries the new one", async () => {
    const { root, open, acpTransport } = await createFixture();
    const { registry } = open();
    const started = await registry.startThread({ backend: ACP, cwd: root, agent: agent(FIRST) });
    const identity = { backend: ACP, threadId: started.threadId };
    acpTransport.hold = true;
    await registry.startTurn({ ...identity, input: text("hello") });
    await vi.waitFor(() => expect(acpTransport.prompts()).toHaveLength(1));

    await registry.setThreadAgent({ ...identity, agent: agent(SECOND) });
    expect(acpTransport.prompts()).toHaveLength(1);
    expect(acpTransport.prompts()[0]).toContain("FIRST-INSTRUCTIONS");
    expect(acpTransport.prompts()[0]).not.toContain("SECOND-INSTRUCTIONS");

    acpTransport.hold = false;
    acpTransport.finishTurn();
    await vi.waitFor(async () => {
      await registry.startTurn({ ...identity, input: text("next") });
    });
    await vi.waitFor(() => expect(acpTransport.prompts()).toHaveLength(2));
    expect(acpTransport.prompts()[1]).toContain(JSON.stringify(buildAcpAgentInstructionBlock(SECOND)).slice(1, -1));
    expect(acpTransport.prompts()[1]).not.toContain("FIRST-INSTRUCTIONS");
  });

  it("Claude: the next turn relaunches the session with the new system prompt", async () => {
    const { root, open, claudeLaunches, completedClaudeTurns } = await createFixture();
    const { registry } = open();
    const started = await registry.startThread({ backend: "claude", cwd: root, agent: agent(FIRST) });
    const identity = { backend: "claude" as const, threadId: started.threadId };
    await registry.startTurn({ ...identity, input: text("hello") });
    await vi.waitFor(() => expect(completedClaudeTurns.count).toBe(1));
    await registry.setThreadAgent({ ...identity, agent: agent(SECOND) });
    // The system prompt is fixed for a running process, so nothing changes yet.
    expect(claudeLaunches.map((launch) => launch.systemPrompt)).toEqual([
      { type: "preset", preset: "claude_code", append: FIRST },
    ]);
    await vi.waitFor(async () => {
      await registry.startTurn({ ...identity, input: text("next") });
    });
    await vi.waitFor(() => expect(completedClaudeTurns.count).toBe(2));
    expect(claudeLaunches.at(-1)!.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: SECOND });
    expect(claudeLaunches.at(-1)!.prompts).toBe(1);
  });
});

describe("a manager thread receives its persona exactly once", () => {
  const PERSONA = STAR_MAP_MANAGER_AGENT_INSTRUCTIONS.split("\n")[0]!;
  /** The instruction file each backend reads from its working directory. */
  const FILE: Record<string, string> = { codex: "AGENTS.md", claude: "CLAUDE.md", [ACP]: "GEMINI.md" };
  const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  async function openManager(backend: AppServerBackendKind, fixture: Awaited<ReturnType<typeof createFixture>>,
    opened: ReturnType<Awaited<ReturnType<typeof createFixture>>["open"]>, known: string[] = []) {
    const workspace = path.join(fixture.root, "star-map-manager");
    const result = await openStarMapManagerThread({}, {
      registry: opened.registry,
      overlayStore: {
        getStarMapManagerThread: () => opened.overlayStore.getStarMapManagerThread(),
        setStarMapManagerThread: (thread) => opened.overlayStore.setStarMapManagerThread(thread),
        getLaunchpadDefaults: async () => ({ ...(await opened.overlayStore.getLaunchpadDefaults()), backend, model: undefined, executionMode: "default" as const }),
        getThreadOverlayState: (params) => opened.overlayStore.getThreadOverlayState(params),
        setThreadAgent: (params) => opened.overlayStore.setThreadAgent(params),
      },
      listThreadKeys: async () => new Set(known),
      workspaceDir: () => workspace,
    });
    if (result.status !== "ready") throw new Error(`manager did not open: ${JSON.stringify(result)}`);
    return { workspace, threadId: result.threadId };
  }

  /** Everything the provider was sent for the backend's turn. */
  async function providerRequests(backend: AppServerBackendKind, fixture: Awaited<ReturnType<typeof createFixture>>): Promise<string> {
    if (backend === "codex") return codexWire();
    if (backend === "claude") {
      await vi.waitFor(() => expect(fixture.completedClaudeTurns.count).toBeGreaterThan(0));
      return JSON.stringify(fixture.claudeLaunches.map((launch) => launch.systemPrompt));
    }
    await vi.waitFor(() => expect(fixture.acpTransport.prompts().length).toBeGreaterThan(0));
    return JSON.stringify(fixture.acpTransport.requests);
  }

  it.each(["codex", "claude", ACP] as const)("%s: from its workspace file and not from the provider request", async (backend) => {
    const fixture = await createFixture();
    const opened = fixture.open();
    const { workspace, threadId } = await openManager(backend, fixture, opened);
    await opened.registry.startTurn({ backend, threadId, input: text("hello") });
    const file = await readFile(path.join(workspace, FILE[backend]!), "utf8");
    const sent = await providerRequests(backend, fixture);
    expect(occurrences(file, PERSONA)).toBe(1);
    expect(occurrences(sent, PERSONA.slice(0, 40))).toBe(0);
    expect(occurrences(file, PERSONA) + occurrences(sent, PERSONA.slice(0, 40))).toBe(1);
    // The thread is still a persona thread for search and the Agents browser.
    expect(await opened.registry.getThreadAgentMetadata({ backend, threadId })).toMatchObject({
      instructions: STAR_MAP_MANAGER_AGENT_INSTRUCTIONS, instructionsDelivery: "workspace-file",
    });
  });

  it.each(["claude", ACP] as const)("%s: a manager created before the marker existed stops being sent a second copy", async (backend) => {
    const fixture = await createFixture();
    const opened = fixture.open();
    const workspace = path.join(fixture.root, "star-map-manager");
    const started = await opened.registry.startThread({
      backend, cwd: fixture.root,
      agent: { name: "Star Map manager", instructions: STAR_MAP_MANAGER_AGENT_INSTRUCTIONS },
    });
    opened.overlayStore.setStarMapManagerThread({ backend, threadId: started.threadId });
    const reopened = await openManager(backend, fixture, opened, [buildThreadIdentityKey(backend, started.threadId)]);
    expect(reopened).toEqual({ workspace, threadId: started.threadId });
    await opened.registry.startTurn({ backend, threadId: started.threadId, input: text("hello") });
    expect(occurrences(await providerRequests(backend, fixture), PERSONA.slice(0, 40))).toBe(0);
  });
});

describe("the ACP instruction block", () => {
  // Model: an agent session holds the instructions it was last sent in a
  // prompt, and keeps them in its history when it is loaded again, after an
  // idle close or an app restart. A prompt must carry the block exactly when
  // the session does not hold the current text, and a prompt the agent
  // rejected changed nothing. A compaction may summarize the block away, so
  // the session holds no instructions after it, even when the block came in
  // that same prompt. The client knows of one when Grok reports it
  // (`auto_compact_completed`), or when the context fill an agent reports in
  // `usage_update` falls below half the last one this client saw. A smaller
  // dip is not a compaction. A client that has not seen a live fill since it
  // started cannot see a fall. Anything `session/load` replays is old and
  // changes nothing.
  type Compaction = "none" | "reported" | "halved" | "dipped";
  type Step =
    | { kind: "turn"; fails: boolean; compaction: Compaction }
    | { kind: "edit"; instructions: string }
    | { kind: "reload"; replaysCompaction: boolean }
    | { kind: "restart"; replaysCompaction: boolean };
  const compaction = fc.constantFrom<Compaction>("none", "none", "reported", "halved", "dipped");
  const step: fc.Arbitrary<Step> = fc.oneof(
    { weight: 4, arbitrary: fc.record({ kind: fc.constant("turn" as const), fails: fc.constant(false), compaction }) },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant("turn" as const), fails: fc.constant(true), compaction }) },
    { weight: 3, arbitrary: fc.constantFrom("", "alpha", "beta\nsecond line").map((instructions) => ({ kind: "edit" as const, instructions })) },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant("reload" as const), replaysCompaction: fc.boolean() }) },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant("restart" as const), replaysCompaction: fc.boolean() }) },
  );
  const compactionNotice = (sessionId: string) => ({
    method: "_x.ai/session_notification",
    sessionId,
    update: { sessionUpdate: "auto_compact_completed", tokens_before: 206562, tokens_after: 16989 },
  });
  const fillUpdate = (used: number) => ({ sessionUpdate: "usage_update", used, size: 1_000_000 });

  it("is sent exactly when the loaded agent session does not hold the current instructions", async () => {
    await fc.assert(fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 16 }), async (steps) => {
      const db = openInMemoryStateDb();
      const settlement = createAcpPromptSettlement();
      const store = new AcpSessionStore(db);
      let failNext = false;
      let compactNext: Compaction = "none";
      let replayCompaction = false;
      let fill = 40_000;
      const connect = async () => {
        const transport = new FakeAcpAgentTransport({
          initialize: { protocolVersion: 1, agentCapabilities: {
            loadSession: true, sessionCapabilities: { close: {} },
          } },
        });
        const request = transport.request.bind(transport);
        vi.spyOn(transport, "request").mockImplementation(async (method, params, timeoutMs) => {
          const protocolSessionId = String(params?.sessionId);
          if (method === "session/prompt") {
            transport.requests.push({ method, params });
            if (compactNext === "reported") transport.emitVendorNotification(compactionNotice(protocolSessionId));
            fill = compactNext === "halved" ? Math.floor(fill / 4)
              : compactNext === "dipped" ? Math.floor(fill * 0.8)
              : fill + 5_000;
            transport.emitSessionUpdate(protocolSessionId, fillUpdate(fill));
            if (failNext) throw new Error("JSON-RPC -32000 fixture prompt failure");
            return { stopReason: "end_turn" };
          }
          if (method === "session/load" && replayCompaction) {
            transport.emitVendorNotification(compactionNotice(protocolSessionId));
            transport.emitSessionUpdate(protocolSessionId, fillUpdate(1));
          }
          return await request(method, params, timeoutMs);
        });
        const client = new AcpAgentClient({ backendId: ACP, store, transport, ...settlement.callbacks });
        await client.initialize();
        return { client, transport };
      };
      let { client, transport } = await connect();
      try {
        const { sessionId } = await client.startSession({ cwd: "/repo", executionMode: "default" });
        let current = "";
        let held = "";
        let fillSeen = false;
        for (const next of steps) {
          if (next.kind === "edit") {
            current = next.instructions;
          } else if (next.kind === "reload") {
            replayCompaction = next.replaysCompaction;
            // An idle close releases the session; the next prompt loads it again.
            // A session that is already released stays released.
            await client.closeIdleSessions({ idleMs: 0 });
          } else if (next.kind === "restart") {
            // A new app process: a new client over the same stored sessions.
            replayCompaction = next.replaysCompaction;
            await client.dispose();
            ({ client, transport } = await connect());
            fillSeen = false;
            await client.ensureSession(store.getSession(ACP, sessionId)!);
          } else {
            failNext = next.fails;
            compactNext = next.compaction;
            const sent = transport.requests.length;
            await settlement.finish(client, { sessionId, prompt: "operator text", agentInstructions: current });
            expect(client.hasActiveTurns()).toBe(false);
            expect(transport.requests.length).toBeGreaterThan(sent);
            const prompt = transport.requests.at(-1)!.params!.prompt as Array<{ type: string; text: string }>;
            expect(prompt.at(-1)).toEqual({ type: "text", text: "operator text" });
            expect(prompt.slice(0, -1)).toEqual(current === held
              ? []
              : [{ type: "text", text: buildAcpAgentInstructionBlock(current) }]);
            const compacted = next.compaction === "reported" || (next.compaction === "halved" && fillSeen);
            fillSeen = true;
            if (compacted) held = "";
            else if (!next.fails) held = current;
          }
        }
      } finally {
        await client.dispose();
        db.close();
      }
    }), { numRuns: 8, examples: [[[
      { kind: "edit", instructions: "alpha" }, { kind: "turn", fails: true, compaction: "none" },
      { kind: "turn", fails: false, compaction: "none" }, { kind: "turn", fails: false, compaction: "none" },
      { kind: "reload", replaysCompaction: false }, { kind: "turn", fails: false, compaction: "none" },
      { kind: "restart", replaysCompaction: false }, { kind: "turn", fails: false, compaction: "none" },
      { kind: "edit", instructions: "" }, { kind: "restart", replaysCompaction: false },
      { kind: "turn", fails: false, compaction: "none" },
    ]], [[
      // The block arrives in the prompt that compacts, so the next one
      // carries it again; a compaction replayed on load does not.
      { kind: "edit", instructions: "alpha" }, { kind: "turn", fails: false, compaction: "reported" },
      { kind: "turn", fails: false, compaction: "none" }, { kind: "turn", fails: false, compaction: "reported" },
      { kind: "reload", replaysCompaction: true }, { kind: "turn", fails: false, compaction: "none" },
      { kind: "turn", fails: false, compaction: "none" },
      { kind: "restart", replaysCompaction: true }, { kind: "turn", fails: false, compaction: "none" },
    ]], [[
      // An agent that only reports its context fill: a halving is a
      // compaction, a dip is not, and a replayed low fill is not.
      { kind: "edit", instructions: "alpha" }, { kind: "turn", fails: false, compaction: "none" },
      { kind: "turn", fails: false, compaction: "halved" }, { kind: "turn", fails: false, compaction: "none" },
      { kind: "turn", fails: false, compaction: "dipped" }, { kind: "turn", fails: false, compaction: "none" },
      { kind: "reload", replaysCompaction: true }, { kind: "turn", fails: false, compaction: "none" },
      { kind: "turn", fails: false, compaction: "halved" }, { kind: "turn", fails: false, compaction: "none" },
    ]]] });
  }, 60_000);

  it("is not sent twice when a thread moves to a new agent session with a smaller context", async () => {
    const db = openInMemoryStateDb();
    const store = new AcpSessionStore(db);
    const transport = new FakeAcpAgentTransport({
      initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
    });
    const request = transport.request.bind(transport);
    let agentSessions = 0;
    const fills = [150_000, 20_000, 25_000];
    vi.spyOn(transport, "request").mockImplementation(async (method, params, timeoutMs) => {
      if (method === "session/new") {
        transport.requests.push({ method, params });
        agentSessions += 1;
        return { sessionId: `agent-${agentSessions}` };
      }
      if (method === "session/prompt") {
        transport.requests.push({ method, params });
        transport.emitSessionUpdate(String(params!.sessionId), { sessionUpdate: "usage_update", used: fills.shift(), size: 1_000_000 });
        return { stopReason: "end_turn" };
      }
      return await request(method, params, timeoutMs);
    });
    const settlement = createAcpPromptSettlement();
    const client = new AcpAgentClient({ backendId: ACP, store, transport, ...settlement.callbacks });
    try {
      await client.initialize();
      const { sessionId } = await client.startSession({ cwd: "/repo", executionMode: "default" });
      const blocks: boolean[] = [];
      const turn = async () => {
        await settlement.finish(client, { sessionId, prompt: "operator text", agentInstructions: "alpha" });
        expect(client.hasActiveTurns()).toBe(false);
        blocks.push(JSON.stringify(transport.requests.at(-1)!.params).includes(ACP_AGENT_INSTRUCTIONS_OPEN_MARKER));
      };
      await turn();
      // The thread is bound to a new agent session, which starts small.
      await client.startSession({ sessionId, cwd: "/repo", executionMode: "default" });
      await turn();
      await turn();
      expect(blocks).toEqual([true, true, false]);
    } finally {
      await client.dispose();
      db.close();
    }
  });

  it("costs one write per reported compaction, and none for a repeated report", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const { dbPath, tempDir } = createTempStateDb("pwragent-agent-instructions-budget-");
    roots.push(tempDir);
    const db = StateDb.open(dbPath);
    const store = new AcpSessionStore(db);
    const transport = new FakeAcpAgentTransport({
      initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
      "session/prompt": { stopReason: "end_turn" },
    });
    const settlement = createAcpPromptSettlement();
    const client = new AcpAgentClient({ backendId: ACP, store, transport, ...settlement.callbacks });
    try {
      await client.initialize();
      const { sessionId } = await client.startSession({ cwd: "/repo", executionMode: "default" });
      const protocolSessionId = store.getSession(ACP, sessionId)!.agentSessionId ?? sessionId;
      const turn = async () => {
        await settlement.finish(client, { sessionId, prompt: "operator text", agentInstructions: "alpha" });
        expect(client.hasActiveTurns()).toBe(false);
      };
      await turn();
      const { writes } = await measureSqliteWrites(() => {
        for (let report = 0; report < 2; report += 1) {
          transport.emitVendorNotification({
            method: "_x.ai/session_notification",
            sessionId: protocolSessionId,
            update: { sessionUpdate: "auto_compact_completed", tokens_before: 206562, tokens_after: 16989 },
          });
        }
      });
      // The prompt after it carries the block and records it with the write
      // every delivery already makes.
      await turn();
      expect(transport.requests.filter((request) => request.method === "session/prompt")
        .map((request) => JSON.stringify(request.params)).at(-1)).toContain(ACP_AGENT_INSTRUCTIONS_OPEN_MARKER);
      expectSqliteWriteBudget({
        budgetFile: "acp-agent-instruction-write-budgets.json",
        note: "Two reports of one Grok compaction: the first clears the session's delivery record, the second finds nothing to clear; one commit (~12 KB WAL) per compaction, ~0.12 MB/day at 10 compactions a day",
        scenario: "acp-compaction-instruction-redelivery",
        writes,
      });
    } finally {
      await client.dispose();
      db.close();
    }
  });

  it("never reaches the transcript, however the agent echoes the prompt", () => {
    const marker = (value: string) => value.includes(ACP_AGENT_INSTRUCTIONS_OPEN_MARKER)
      || value.includes(ACP_AGENT_INSTRUCTIONS_CLOSE_MARKER);
    fc.assert(fc.property(
      fc.string().filter((value) => !marker(value)),
      fc.string().filter((value) => !marker(value)),
      fc.nat(),
      (instructions, operatorText, cut) => {
        const block = buildAcpAgentInstructionBlock(instructions);
        // Echoed whole, in one chunk with the operator's text after it.
        expect(stripAcpAgentInstructionBlock(`${block}\n\n${operatorText}`)).toBe(operatorText.trim());
        // Echoed in two chunks, split inside the block.
        const at = cut % block.length;
        const head = stripAcpAgentInstructionBlock(block.slice(0, Math.max(at, ACP_AGENT_INSTRUCTIONS_OPEN_MARKER.length)));
        const tail = stripAcpAgentInstructionBlock(
          `${block.slice(Math.max(at, ACP_AGENT_INSTRUCTIONS_OPEN_MARKER.length))}${operatorText}`,
        );
        expect(head).toBe("");
        if (at <= block.length - ACP_AGENT_INSTRUCTIONS_CLOSE_MARKER.length) expect(tail).toBe(operatorText.trim());
        // Text with no block is the operator's own and is left alone.
        expect(stripAcpAgentInstructionBlock(operatorText)).toBe(operatorText);
      },
    ));
  });

  it("never reaches the transcript when the echo is cut into any number of chunks", () => {
    // Oracle: whatever the chunking, the displayed text is the operator's.
    // Cuts fall between the markers, which an agent echoes whole.
    const instructionLine = fc.string({ unit: fc.constantFrom("§", "¶", " ", "x") });
    const operator = fc.string({ unit: fc.constantFrom("a", "b", " ") });
    fc.assert(fc.property(
      fc.array(instructionLine, { minLength: 1, maxLength: 6 }),
      operator,
      fc.array(fc.nat(), { maxLength: 6 }),
      (lines, operatorText, cuts) => {
        const block = buildAcpAgentInstructionBlock(lines.join("\n") || "§");
        const bodyStart = ACP_AGENT_INSTRUCTIONS_OPEN_MARKER.length;
        const bodyEnd = block.length - ACP_AGENT_INSTRUCTIONS_CLOSE_MARKER.length;
        const points = [...new Set(cuts.map((cut) => bodyStart + (cut % (bodyEnd - bodyStart + 1))))]
          .sort((left, right) => left - right);
        const echoed = `${block}${operatorText}`;
        const chunks = [0, ...points].map((from, index) => echoed.slice(from, points[index] ?? echoed.length));
        let insideBlock = false;
        let shown = "";
        for (const chunk of chunks) {
          const stripped = stripAcpAgentInstructionChunk(chunk, insideBlock);
          insideBlock = stripped.insideBlock;
          shown += stripped.text;
        }
        expect(insideBlock).toBe(false);
        expect(shown.trim()).toBe(operatorText.trim());
      },
    ));
  });

  it("is not sent again when a caller reloads the session with metadata captured before it was sent", async () => {
    const db = openInMemoryStateDb();
    const store = new AcpSessionStore(db);
    const transport = new FakeAcpAgentTransport({
      initialize: { protocolVersion: 1, agentCapabilities: {
        loadSession: true, sessionCapabilities: { close: {} },
      } },
    });
    const settlement = createAcpPromptSettlement();
    const client = new AcpAgentClient({ backendId: ACP, store, transport, ...settlement.callbacks });
    const prompts = () => transport.requests.filter((request) => request.method === "session/prompt");
    const turn = async () => {
      const sent = prompts().length;
      await settlement.finish(client, { sessionId, prompt: "operator text", agentInstructions: "alpha" });
      expect(client.hasActiveTurns()).toBe(false);
      expect(prompts().length).toBeGreaterThan(sent);
      return JSON.stringify(prompts().at(-1)!.params);
    };
    await client.initialize();
    const { sessionId } = await client.startSession({ cwd: "/repo", executionMode: "default" });
    try {
      const captured = store.getSession(ACP, sessionId)!;
      expect(await turn()).toContain(ACP_AGENT_INSTRUCTIONS_OPEN_MARKER);
      await client.closeIdleSessions({ idleMs: 0 });
      await client.ensureSession(captured);
      expect(await turn()).not.toContain(ACP_AGENT_INSTRUCTIONS_OPEN_MARKER);
    } finally {
      await client.dispose();
      db.close();
    }
  });
});

describe("Agent memory at the provider boundary", () => {
  it.each(["codex", "claude", ACP] as const)("%s sends the current index on start and resume", async (backend) => {
    const { root, open, acpTransport, claudeLaunches } = await createFixture();
    const first = open();
    const started = await first.registry.startThread({ backend, cwd: root, agent: agent(FIRST) });
    const identity = { backend, threadId: started.threadId };
    const input = text("next work");
    const observe = () => backend === "codex"
      ? JSON.stringify(codexFrames("turn/start").at(-1))
      : backend === "claude"
        ? JSON.stringify(claudeLaunches.at(-1)?.memory.at(-1)
          ? { memory: claudeLaunches.at(-1)?.memory.at(-1) }
          : {})
        : acpTransport.prompts().at(-1) ?? "";
    await first.registry.accessAgentMemory(identity, { action: "write_index", content: "first-memory-fixture" });
    const turn = await first.registry.startTurn({ ...identity, input });
    await vi.waitFor(() => expect(observe()).toContain("first-memory-fixture"));
    if (backend === "codex") completeCodexTurn(turn.threadId, turn.turnId);
    await first.registry.accessAgentMemory(identity, { action: "write_index", content: "resumed-memory-fixture" });
    if (backend === ACP) {
      await vi.waitFor(() => expect(acpTransport.prompts()).toHaveLength(1));
    }
    await first.registry.close();
    registries.splice(registries.indexOf(first.registry), 1);
    const second = open();
    await second.registry.startTurn({ ...identity, input });
    await vi.waitFor(() => expect(observe()).toContain("resumed-memory-fixture"));
    expect(observe()).not.toContain("first-memory-fixture");
    if (backend === "codex") expect(codexFrames("thread/resume").at(-1)?.threadId).toBe(started.threadId);
    if (backend === "claude") expect(claudeLaunches.at(-1)?.resume).toBeDefined();
    if (backend === ACP) expect(acpTransport.requests.some((request) => request.method === "session/load")).toBe(true);
  });

  it("reads a note written before compaction after restarting the owner", async () => {
    const { root, open } = await createFixture();
    const first = open();
    const started = await first.registry.startThread({ backend: "codex", cwd: root, agent: agent(FIRST) });
    const identity = { backend: "codex" as const, threadId: started.threadId };
    const turn = await first.registry.startTurn({ ...identity, input: text("record progress") });
    await first.registry.accessAgentMemory(identity, { action: "write_note", noteId: "progress", content: "Already reported the review." });
    const completed = new Promise<void>((resolve) => {
      const unsubscribe = first.registry.onEvent((event) => {
        if (event.backend === "codex" && event.notification.method === "turn/completed"
          && event.notification.params.turnId === turn.turnId) {
          unsubscribe();
          resolve();
        }
      });
    });
    completeCodexTurn(turn.threadId, turn.turnId);
    await completed;
    await first.registry.compactThread(identity);
    expect(codexFrames("thread/compact/start")).toHaveLength(1);
    AgentInstructionCodexTransport.notify("thread/compacted", { threadId: turn.threadId, turnId: `compact:${turn.threadId}` });
    await first.registry.close();
    registries.splice(registries.indexOf(first.registry), 1);
    const second = open();
    expect(await second.registry.accessAgentMemory(identity, { action: "read_note", noteId: "progress" }))
      .toMatchObject({ exists: true, content: "Already reported the review." });
  });
});

it("gates memory mutations on the profile owner across independent database connections", async () => {
  const { root, open } = await createFixture();
  const first = open("memory-owner").registry;
  const started = await first.startThread({ backend: "claude", cwd: root, agent: agent(FIRST) });
  const identity = { backend: "claude", threadId: started.threadId } as const;
  const second = open("memory-viewer").registry;
  const initial = await second.accessAgentMemorySettings({ ...identity, operation: { action: "read_index" } });
  if (!("revision" in initial)) throw new Error("Expected the index");
  const edit = { action: "write_index", revision: initial.revision } as const;
  await expect(second.accessAgentMemorySettings({ ...identity, operation: { ...edit, content: "viewer" } }))
    .rejects.toThrow("Profile thread ownership is held by another PwrAgent runtime");
  await expect(second.accessAgentMemory(identity, { action: "write_note", noteId: "progress", content: "viewer" }))
    .rejects.toThrow("Profile thread ownership is held by another PwrAgent runtime");
  await first.accessAgentMemorySettings({ ...identity, operation: { ...edit, content: "winner" } });
  await first.close();
  registries.splice(registries.indexOf(first), 1);
  await expect(second.accessAgentMemorySettings({ ...identity, operation: { ...edit, content: "stale" } }))
    .rejects.toThrow("Agent memory changed");
  await expect(second.accessAgentMemorySettings({ ...identity, operation: { action: "read_index" } }))
    .resolves.toMatchObject({ content: "winner" });
});
