import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AcpBackendId } from "@pwragent/shared";
import { AcpAgentStore } from "../../src/main/acp/acp-agent-store";
import { AcpSessionStore } from "../../src/main/acp/acp-session-store";
import { StateDb } from "../../src/main/state/state-db";

/**
 * Durable executable-backed fakes for desktop E2E.
 *
 * Codex is configured through production settings (`[models.codex].path`) and
 * discovery — never through `PWRAGENT_REPLAY_FIXTURE_PATH`. Kimi is configured
 * through `[acp_agents.kimi].cli_path` plus an installed-agent / session seed
 * when a parent ACP thread must already exist.
 *
 * The fake Codex app-server appends every JSON-RPC request to a durable
 * protocol log so specs can assert exact materialization order (environment
 * setup marker before thread/start, review/start, etc.).
 */

export const FAKE_CODEX_PROTOCOL_LOG_ENV = "PWRAGENT_FAKE_CODEX_PROTOCOL_LOG";
export const FAKE_CODEX_LAUNCH_MARKER_ENV = "PWRAGENT_FAKE_CODEX_LAUNCH_MARKER";
// Stay below the generated model/list contract (0.144.0) so the minimal
// legacy list shape is accepted. Discovery still requires >= 0.125.0.
export const FAKE_CODEX_VERSION = "0.130.0";
export const FEDERATION_CHILD_ENVIRONMENT_MARKER =
  ".federation-child-environment-ran";

export type FakeCodexProtocolRequest = {
  at: number;
  method: string;
  id?: string | number | null;
  params?: unknown;
  /** Present on `thread/start` when the fake can inspect the requested cwd. */
  setupMarkerPresent?: boolean;
  setupMarkerPath?: string;
};

export async function writeFakeKimiExecutable(
  targetPath: string,
): Promise<string> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  // Major 0.x so discovery does not treat this as legacy Python kimi-cli (1.x).
  await writeFile(
    targetPath,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("kimi-code 0.1.0\\n");
  process.exit(0);
}
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request == null || request.id === undefined) {
    return;
  }
  let result = {};
  if (request.method === "initialize") {
    result = { protocolVersion: 1 };
  } else if (request.method === "session/new") {
    result = { sessionId: "fake-kimi-session" };
  } else if (request.method === "session/load") {
    result = { updates: [] };
  } else if (request.method === "session/prompt") {
    result = { turnId: "fake-kimi-turn" };
  } else if (request.method === "session/cancel") {
    result = {};
  }
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n",
  );
});
`,
    "utf8",
  );
  await chmod(targetPath, 0o755);
  return targetPath;
}

export async function writeFakeCodexExecutable(params: {
  targetPath: string;
  protocolLogPath: string;
  launchMarkerPath: string;
}): Promise<string> {
  await mkdir(path.dirname(params.targetPath), { recursive: true });
  await mkdir(path.dirname(params.protocolLogPath), { recursive: true });
  await mkdir(path.dirname(params.launchMarkerPath), { recursive: true });

  // Bake absolute paths into the script so protocol capture still works if the
  // spawn path only partially inherits the Electron process env.
  const protocolLogLiteral = JSON.stringify(params.protocolLogPath);
  const launchMarkerLiteral = JSON.stringify(params.launchMarkerPath);
  const setupMarkerNameLiteral = JSON.stringify(
    FEDERATION_CHILD_ENVIRONMENT_MARKER,
  );
  const versionLiteral = JSON.stringify(FAKE_CODEX_VERSION);
  const protocolLogEnvLiteral = JSON.stringify(FAKE_CODEX_PROTOCOL_LOG_ENV);
  const launchMarkerEnvLiteral = JSON.stringify(FAKE_CODEX_LAUNCH_MARKER_ENV);

  await writeFile(
    params.targetPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const os = require("node:os");

const BAKED_PROTOCOL_LOG = ${protocolLogLiteral};
const BAKED_LAUNCH_MARKER = ${launchMarkerLiteral};
const PROTOCOL_LOG =
  process.env[${protocolLogEnvLiteral}] || BAKED_PROTOCOL_LOG;
const LAUNCH_MARKER =
  process.env[${launchMarkerEnvLiteral}] || BAKED_LAUNCH_MARKER;
const SETUP_MARKER_NAME = ${setupMarkerNameLiteral};
const VERSION = ${versionLiteral};

function appendProtocol(entry) {
  try {
    fs.mkdirSync(path.dirname(PROTOCOL_LOG), { recursive: true });
    fs.appendFileSync(PROTOCOL_LOG, JSON.stringify(entry) + "\\n");
  } catch {
    // Best-effort; the E2E will fail if assertions cannot read the log.
  }
}

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli " + VERSION + "\\n");
  process.exit(0);
}

if (!process.argv.includes("app-server")) {
  process.stderr.write("fake-codex: expected app-server mode\\n");
  process.exit(2);
}

try {
  fs.mkdirSync(path.dirname(LAUNCH_MARKER), { recursive: true });
  fs.writeFileSync(
    LAUNCH_MARKER,
    JSON.stringify({ at: Date.now(), pid: process.pid, argv: process.argv }) + "\\n",
  );
} catch {
  // ignore
}
appendProtocol({
  at: Date.now(),
  method: "__launch__",
  params: { argv: process.argv.slice(1), pid: process.pid },
});

let threadCounter = 0;
let turnCounter = 0;

function platformFamily() {
  return process.platform === "win32" ? "windows" : "unix";
}

function platformOs() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

function nextThreadId() {
  threadCounter += 1;
  return "fake-codex-thread-" + threadCounter;
}

function nextTurnId() {
  turnCounter += 1;
  return "fake-codex-turn-" + turnCounter;
}

function minimalThread(id, params) {
  const now = Math.floor(Date.now() / 1000);
  const cwd =
    typeof params?.cwd === "string" && params.cwd.trim()
      ? params.cwd.trim()
      : process.cwd();
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    historyMode: "default",
    modelProvider: "openai",
    createdAt: now,
    updatedAt: now,
    recencyAt: now,
    status: { type: "idle" },
    path: null,
    cwd,
    cliVersion: VERSION,
    source: { type: "cli" },
    gitInfo: null,
    extra: null,
    turns: [],
  };
}

function minimalTurn(id) {
  return {
    id,
    items: [],
    itemsView: "complete",
    status: "completed",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}

function handleRequest(request) {
  const method = request.method;
  const params = request.params ?? {};
  if (method === "initialize") {
    const codexHome =
      process.env.CODEX_HOME
      || path.join(process.env.HOME || os.tmpdir(), ".codex");
    return {
      userAgent: "codex_app_server_fake/" + VERSION,
      codexHome,
      platformFamily: platformFamily(),
      platformOs: platformOs(),
    };
  }
  if (method === "thread/list") {
    return { data: [], nextCursor: null, backwardsCursor: null };
  }
  if (method === "thread/read") {
    const threadId =
      typeof params.threadId === "string" ? params.threadId : nextThreadId();
    return { thread: minimalThread(threadId, params) };
  }
  if (method === "thread/start") {
    const threadId = nextThreadId();
    return {
      thread: minimalThread(threadId, params),
      model: "gpt-5",
      modelProvider: "openai",
      serviceTier: null,
      cwd:
        typeof params.cwd === "string" && params.cwd.trim()
          ? params.cwd.trim()
          : process.cwd(),
      runtimeWorkspaceRoots: [],
      instructionSources: [],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: { type: "danger-full-access" },
      activePermissionProfile: null,
      reasoningEffort: null,
      multiAgentMode: "explicitRequestOnly",
    };
  }
  if (method === "thread/resume" || method === "thread/fork") {
    const threadId =
      typeof params.threadId === "string" ? params.threadId : nextThreadId();
    return { thread: minimalThread(threadId, params) };
  }
  if (method === "thread/name/set" || method === "thread/settings/update") {
    return {};
  }
  if (method === "turn/start") {
    return { turn: minimalTurn(nextTurnId()) };
  }
  if (method === "review/start") {
    const threadId =
      typeof params.threadId === "string" ? params.threadId : nextThreadId();
    return {
      turn: minimalTurn(nextTurnId()),
      reviewThreadId: threadId,
    };
  }
  if (method === "skills/list") {
    return { data: [] };
  }
  if (method === "model/list") {
    return {
      data: [
        {
          id: "gpt-5",
          model: "gpt-5",
          isDefault: true,
          default: true,
          supportsReasoning: true,
        },
      ],
      nextCursor: null,
    };
  }
  if (method === "account/read") {
    return {
      account: {
        type: "apiKey",
        email: "fake-codex@example.invalid",
        planType: "plus",
      },
      requiresOpenaiAuth: false,
    };
  }
  if (method === "account/rateLimits/read") {
    return { rateLimits: [] };
  }
  if (method === "config/read") {
    return { config: {}, origins: {}, layers: null };
  }
  if (method === "config/value/write" || method === "thread/inject_items") {
    return {};
  }
  return {};
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request == null || typeof request !== "object") {
    return;
  }
  if (request.id === undefined) {
    appendProtocol({
      at: Date.now(),
      method: request.method ?? "notification",
      params: request.params,
    });
    return;
  }
  const entry = {
    at: Date.now(),
    method: request.method,
    id: request.id,
    params: request.params,
  };
  if (request.method === "thread/start") {
    const cwd =
      typeof request.params?.cwd === "string" ? request.params.cwd.trim() : "";
    if (cwd) {
      const markerPath = path.join(cwd, SETUP_MARKER_NAME);
      entry.setupMarkerPath = markerPath;
      try {
        entry.setupMarkerPresent = fs.existsSync(markerPath);
      } catch {
        entry.setupMarkerPresent = false;
      }
    }
  }
  appendProtocol(entry);
  let result;
  try {
    result = handleRequest(request);
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      }) + "\\n",
    );
    return;
  }
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n",
  );
});
`,
    "utf8",
  );
  await chmod(params.targetPath, 0o755);
  return params.targetPath;
}

export async function readFakeCodexProtocolLog(
  protocolLogPath: string,
): Promise<FakeCodexProtocolRequest[]> {
  try {
    const raw = await readFile(protocolLogPath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as FakeCodexProtocolRequest];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function findFakeCodexRequests(
  log: readonly FakeCodexProtocolRequest[],
  method: string,
): FakeCodexProtocolRequest[] {
  return log.filter((entry) => entry.method === method);
}

/**
 * Seed production config so discovery resolves the fake binaries the same
 * way a real operator path override would.
 */
export function buildFakeAgentConfigToml(params: {
  fakeKimiPath: string;
  fakeCodexPath: string;
  extraSections?: string[];
  extraToml?: string;
}): string {
  const extra =
    params.extraToml?.trim()
    || (params.extraSections?.length
      ? params.extraSections.join("\n").trim()
      : "");
  return [
    "[models.codex]",
    `path = ${JSON.stringify(params.fakeCodexPath)}`,
    "",
    "[acp_agents.kimi]",
    `cli_path = ${JSON.stringify(params.fakeKimiPath)}`,
    "",
    extra ? `${extra}\n` : "",
  ].join("\n");
}

export async function writeOwnerProfileConfig(params: {
  homeRoot: string;
  contents: string;
}): Promise<string> {
  const configPath = path.join(
    params.homeRoot,
    ".pwragent",
    "profiles",
    "default",
    "config.toml",
  );
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, params.contents, "utf8");
  return configPath;
}

/**
 * Persist a Kimi parent session + installed-agent row so the owner already
 * has the managed-worktree parent the Remote Viewer right-clicks.
 */
export async function seedKimiParentSession(params: {
  directoryPath: string;
  homeRoot: string;
  fakeKimiPath: string;
  sessionId?: string;
  title?: string;
}): Promise<{ backendId: AcpBackendId; sessionId: string }> {
  const backendId = "acp:kimi" as AcpBackendId;
  const sessionId = params.sessionId ?? "federated-kimi-parent";
  const seededAt = Date.now();
  const dbPath = path.join(
    params.homeRoot,
    ".pwragent",
    "profiles",
    "default",
    "state",
    "state.db",
  );
  await mkdir(path.dirname(dbPath), { recursive: true });
  const stateDb = StateDb.open(dbPath, { profileName: "default" });
  try {
    new AcpAgentStore(stateDb).upsertInstalledAgent({
      backendId,
      registryId: "kimi",
      name: "Kimi Code CLI",
      distributionKind: "local",
      distributionSource: params.fakeKimiPath,
      installStatus: "installed",
      authStatus: "not-required",
      verificationStatus: "not-applicable",
      allowlistRuleId: "e2e-kimi",
      installedAt: seededAt,
      updatedAt: seededAt,
      launchDescriptor: {
        backendId,
        registryId: "kimi",
        distributionKind: "local",
        command: params.fakeKimiPath,
        args: [],
        env: {},
      },
    });
    new AcpSessionStore(stateDb).upsertSession({
      backendId,
      sessionId,
      agentSessionId: "fake-kimi-session",
      title: params.title ?? "Remote Kimi parent",
      titleSource: "explicit",
      cwd: params.directoryPath,
      createdAt: seededAt,
      updatedAt: seededAt,
      executionMode: "full-access",
      status: "idle",
      hasConversationHistory: true,
    });
  } finally {
    stateDb.close();
  }
  return { backendId, sessionId };
}

export async function installOwnerFakeAgents(params: {
  homeRoot: string;
  binDir?: string;
}): Promise<{
  fakeKimiPath: string;
  fakeCodexPath: string;
  protocolLogPath: string;
  launchMarkerPath: string;
}> {
  const binDir = params.binDir ?? path.join(params.homeRoot, "bin");
  const fakeKimiPath = path.join(binDir, "fake-kimi");
  const fakeCodexPath = path.join(binDir, "fake-codex");
  const protocolLogPath = path.join(binDir, "fake-codex.protocol.jsonl");
  const launchMarkerPath = path.join(binDir, "fake-codex.launched");
  await writeFakeKimiExecutable(fakeKimiPath);
  await writeFakeCodexExecutable({
    targetPath: fakeCodexPath,
    protocolLogPath,
    launchMarkerPath,
  });
  return {
    fakeKimiPath,
    fakeCodexPath,
    protocolLogPath,
    launchMarkerPath,
  };
}

// ---------------------------------------------------------------------------
// Aliases kept for call-site clarity / future fixtures
// ---------------------------------------------------------------------------

export const seedFakeKimiExecutable = async (
  homeRoot: string,
): Promise<{ executablePath: string }> => ({
  executablePath: await writeFakeKimiExecutable(
    path.join(homeRoot, "bin", "fake-kimi"),
  ),
});

export async function seedFakeCodexExecutable(params: {
  homeRoot: string;
  requestLogPath: string;
  launchMarkerPath: string;
}): Promise<{ executablePath: string }> {
  const executablePath = path.join(params.homeRoot, "bin", "fake-codex");
  await writeFakeCodexExecutable({
    targetPath: executablePath,
    protocolLogPath: params.requestLogPath,
    launchMarkerPath: params.launchMarkerPath,
  });
  return { executablePath };
}

export const seedInstalledKimiParent = seedKimiParentSession;

export const readFakeCodexRequestLog = readFakeCodexProtocolLog;

export function findFakeCodexRequest(
  entries: readonly FakeCodexProtocolRequest[],
  method: string,
): FakeCodexProtocolRequest | undefined {
  return findFakeCodexRequests(entries, method)[0];
}

export const findAllFakeCodexRequests = findFakeCodexRequests;

export function fakeCodexEnv(params: {
  requestLogPath: string;
  launchMarkerPath: string;
}): Record<string, string> {
  return {
    [FAKE_CODEX_PROTOCOL_LOG_ENV]: params.requestLogPath,
    [FAKE_CODEX_LAUNCH_MARKER_ENV]: params.launchMarkerPath,
  };
}
