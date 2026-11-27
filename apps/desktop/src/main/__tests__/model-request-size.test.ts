import { execFile } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { AcpStdioJsonRpcTransport } from "../acp/acp-stdio-transport";
import { MANAGED_ANTIGRAVITY_ENV } from "../acp/antigravity-runtime-retention";
import type { BackendRegistryMcpConnectionService } from "../app-server/backend-registry-types";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { resolveBundledClaudeExecutable } from "../claude/claude-bundled-executable";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { AcpAgentStore } from "../storage/acp-agent-store";
import { AcpSessionStore } from "../storage/acp-session-store";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

vi.mock("@pwrdrvr/codex-discovery", async (importOriginal) => {
  const { stubbedCodexDiscovery } = await import("./helpers/codex-discovery-stub");
  return stubbedCodexDiscovery(await importOriginal());
});

const instructions = "Keep state changes in one transaction. Use the existing checkout test helpers.";
const initialPrompt = "Inspect the sample checkout tests and explain which wait condition is wrong.";
const nextPrompt = "Summarize the proposed fix for the checkout test in one sentence.";
const answer = "Wait for the hydrated rows.";
const replyUsage = { input_tokens: 200, output_tokens: 8 };
const codexModel = "gpt-5.5";

function codexResponse(index: number) {
  const item = {
    id: `msg_fixture_${index}`, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: answer, annotations: [] }],
  };
  const response = {
    id: `resp_fixture_${index}`, object: "response", status: "completed", output: [item],
    usage: { ...replyUsage, total_tokens: 208 },
  };
  return [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function claudeResponse(index: number, model: string | undefined) {
  if (!model) throw new Error("Missing model in Claude fixture request");
  return [
    { type: "message_start", message: {
      id: `msg_fixture_${index}`, type: "message", role: "assistant", model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 200, output_tokens: 0 },
    } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 8 } },
    { type: "message_stop" },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const antigravity = "acp:antigravity";
const providers = ["codex", "claude", antigravity] as const;
type Provider = typeof providers[number];
type RequestBody = {
  model?: string;
  input?: unknown[];
  messages?: unknown[];
  system?: unknown;
  instructions?: unknown;
  tools?: unknown[];
  contents?: unknown[];
  systemInstruction?: unknown;
};
type Sample = { bytes: number; route: string; body: RequestBody };
type TurnMetrics = { bytes: number; calls: number; primaryBytes: number; inputBytes: number; instructionBytes: number; toolBytes: number };
type Metrics = { [K in keyof TurnMetrics as `first${Capitalize<K>}` | `next${Capitalize<K>}`]: number };

function turnMetrics(samples: Sample[], prompt: string, agentInstructions?: string): TurnMetrics {
  const largestBodyBytes = Math.max(...samples.map(({ bytes }) => bytes));
  const primary = samples.findLast(({ bytes, body }) =>
    bytes === largestBodyBytes && JSON.stringify(body).includes(prompt)
    && (agentInstructions === undefined || JSON.stringify(body).includes(agentInstructions)));
  expect(primary, "largest model request carries the configured prompt and instructions").toBeDefined();
  const { body, bytes } = primary!;
  const input = body.input ?? body.messages ?? body.contents ?? [];
  const messageRole = (item: unknown): unknown =>
    item && typeof item === "object" && "role" in item ? item.role : undefined;
  const isInstruction = (item: unknown): boolean => ["developer", "system"].includes(String(messageRole(item)));
  const isToolInventory = (item: unknown): item is { tools?: unknown[] } =>
    Boolean(item && typeof item === "object" && "type" in item && item.type === "additional_tools");
  const measure = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const instructionBlocks = [body.instructions, body.system, body.systemInstruction, ...input.filter(isInstruction)]
    .filter((value) => value !== undefined);
  expect.soft(JSON.stringify(input).split(prompt)).toHaveLength(2);
  if (agentInstructions !== undefined) expect.soft(JSON.stringify(body).split(agentInstructions)).toHaveLength(2);
  return {
    bytes: samples.reduce((total, sample) => total + sample.bytes, 0),
    calls: samples.length,
    primaryBytes: bytes,
    inputBytes: measure(input.filter((item) => !isInstruction(item) && !isToolInventory(item))),
    instructionBytes: measure(instructionBlocks),
    toolBytes: measure([...(body.tools ?? []), ...input.filter(isToolInventory).flatMap(({ tools }) => tools ?? [])]),
  };
}

function antigravityResponse() {
  return `data: ${JSON.stringify({
    candidates: [{ content: { role: "model", parts: [{ text: answer }] }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 8, totalTokenCount: 208 },
  })}\n\n`;
}

async function startModelEndpoint(provider: Provider) {
  const requests: Sample[] = [];
  const paths: string[] = [];
  const server = createServer(async (request, response) => {
    const route = request.url?.split("?")[0] ?? "";
    paths.push(route);
    const isModelRequest = provider === "codex" ? route === "/v1/responses"
      : provider === "claude" ? route === "/v1/messages"
        : /^\/v1beta\/models\/[^/]+:streamGenerateContent$/.test(route);
    if (request.method !== "POST" || !isModelRequest) {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RequestBody;
      requests.push({ bytes, route, body });
      const reply = provider === "codex" ? codexResponse(requests.length)
        : provider === "claude" ? claudeResponse(requests.length, body.model)
          : antigravityResponse();
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(reply);
    } catch {
      response.writeHead(400).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fake model endpoint address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests, paths,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

type Comparison = { cwd: string; mode: "desktop" | "cli" };
type Capture = { metrics: TurnMetrics; requests: Sample[] };
type BenchmarkOptions = { comparison?: Comparison; largeMcpCatalog?: boolean };

const catalogMarker = "full-model-request-mcp-catalog-fixture";
const toolsPerConnection = 80;
const mcpServerPath = fileURLToPath(new URL("./fixtures/model-request-mcp-server.cjs", import.meta.url));

async function createLargeMcpCatalog(home: string) {
  const catalogs = await Promise.all(["inventory", "reviews", "support"].map(async (id) => {
    const tools = Array.from({ length: toolsPerConnection }, (_, index) => ({
      name: `fixture_${id}_lookup_${index}`,
      description: `Look up synthetic ${id} records of type ${index}.`,
      inputSchema: {
        type: "object" as const,
        properties: Object.fromEntries(Array.from({ length: 16 }, (_, field) => [`field_${field}`, {
          type: "string", description: `${catalogMarker}: field ${field} for ${id} lookup ${index}`,
        }])),
        additionalProperties: false,
      },
    }));
    const catalogPath = path.join(home, `${id}.json`);
    const listingLog = path.join(home, `${id}.listed`);
    await writeFile(catalogPath, JSON.stringify(tools));
    return { id, tools, catalogPath, listingLog };
  }));

  const catalogFor = (id: string) => {
    const catalog = catalogs.find((candidate) => candidate.id === id);
    if (!catalog) throw new Error(`Unexpected benchmark MCP connection ${id}`);
    return catalog;
  };
  const service: BackendRegistryMcpConnectionService = {
    listConnections: async () => catalogs.map(({ id }) => ({
      id, displayName: id, serverUrl: `https://${id}.example.test/mcp`, kind: "remote",
      authMode: "oauth", enabled: true, configured: true, state: "ready", selectForNewThreads: false,
      createdAt: 0, updatedAt: 0,
    })),
    registerBridge: async (id) => {
      const { catalogPath, listingLog } = catalogFor(id);
      return {
        server: { name: id, command: process.execPath, args: [mcpServerPath, catalogPath, listingLog], env: {} },
        bindThread: () => {}, revoke: () => {},
      };
    },
    requestGatewayToolOperation: async ({ connectionId, operation }) => {
      if (operation !== "gateway/tools/list") throw new Error(`Unexpected benchmark MCP operation ${operation}`);
      const { tools } = catalogFor(connectionId);
      return tools.map((definition) => ({
        connectionId, serverName: connectionId, toolName: definition.name, schemaRevision: "fixture", definition,
      }));
    },
  };
  return { catalogs, connectionIds: catalogs.map(({ id }) => id), service };
}

async function captureModelRequests(
  provider: Provider,
  codexExecutable: string,
  antigravityExecutable: string,
  { comparison, largeMcpCatalog }: BenchmarkOptions = {},
): Promise<Capture[]> {
  const home = await mkdtemp(path.join(os.tmpdir(), "pwragent-model-request-"));
  const cwd = comparison?.cwd ?? home;
  const codexPolicy = comparison && provider === "codex"
    ? { approvalPolicy: "never", sandbox: "workspace-write" }
    : {};
  const endpoint = await startModelEndpoint(provider);
  const db = openInMemoryStateDb();
  // Use empty credential/config directories and route HTTP clients only to loopback.
  const env = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODEX_HOME: home, CLAUDE_CONFIG_DIR: path.join(home, "claude-home"),
    XDG_CONFIG_HOME: path.join(home, "config"), XDG_STATE_HOME: path.join(home, "state"),
    NO_PROXY: "127.0.0.1", HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1",
    ANTHROPIC_BASE_URL: endpoint.origin, DISABLE_NONESSENTIAL_MODEL_CALLS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
    GEMINI_API_KEY: "fixture-key", GOOGLE_GEMINI_BASE_URL: endpoint.origin,
    ...MANAGED_ANTIGRAVITY_ENV,
  };
  let registry: ReturnType<typeof createDesktopBackendRegistry> | undefined;
  try {
    await writeFile(path.join(home, "config.toml"), [
      `model = "${codexModel}"`, 'model_provider = "fixture"', 'web_search = "disabled"',
      `approval_policy = "${codexPolicy.approvalPolicy ?? "never"}"`,
      `sandbox_mode = "${codexPolicy.sandbox ?? "read-only"}"`,
      "[features]", "apps = false", "plugins = false",
      "[model_providers.fixture]", 'name = "Synthetic model endpoint"', `base_url = "${endpoint.origin}/v1"`,
      'wire_api = "responses"', "requires_openai_auth = false",
    ].join("\n"));
    const claude = path.join(home, "claude");
    if (provider === "claude") {
      const bundled = await resolveBundledClaudeExecutable();
      if (!bundled) throw new Error("The benchmark requires the pinned Claude SDK binary");
      await copyFile(bundled, claude);
      await chmod(claude, 0o755);
    }
    if (provider === antigravity) {
      const settingsDirectory = path.join(home, ".gemini", "antigravity-cli");
      await mkdir(settingsDirectory, { recursive: true });
      await writeFile(path.join(settingsDirectory, "settings.json"), JSON.stringify({ modelProvider: "gemini", autoUpdate: false }));
    }
    if (comparison?.mode === "cli") {
      const cli = {
        codex: { executable: codexExecutable, args: ["exec", "--skip-git-repo-check", "--json", initialPrompt] },
        claude: { executable: claude, args: ["--print", "--output-format", "json", "--model", "sonnet", initialPrompt] },
        [antigravity]: { executable: antigravityExecutable, args: ["--output-format", "json", `--print=${initialPrompt}`] },
      }[provider];
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = execFile(cli.executable, cli.args, {
          cwd, env: { ...env, ANTHROPIC_API_KEY: "fixture-key" },
          timeout: 25_000, maxBuffer: 256 * 1024,
        }, (error, output) => error ? reject(error) : resolve(output));
        child.stdin?.end();
      });
      expect(stdout).toContain(answer);
      return [{ metrics: turnMetrics(endpoint.requests, initialPrompt), requests: endpoint.requests }];
    }

    const acpAgentStore = new AcpAgentStore(db);
    if (provider === antigravity) {
      acpAgentStore.upsertInstalledAgent({
        backendId: antigravity, registryId: "antigravity", name: "Antigravity",
        distributionKind: "local", distributionSource: "agy", installStatus: "installed", authStatus: "not-required",
        verificationStatus: "not-applicable", allowlistRuleId: "local-antigravity-cli", installedAt: 1, updatedAt: 1,
        launchDescriptor: {
          backendId: antigravity, registryId: "antigravity", distributionKind: "local",
          command: antigravityExecutable, args: ["acp", "--disable-telemetry", "--cloud_code_endpoint", endpoint.origin],
          cwd, env: {},
        },
      });
    }
    const codexClient = new CodexAppServerClient({
      command: codexExecutable, env, directoryResolver: async () => [],
      resolveCommand: async () => ({ command: codexExecutable, source: "config" }),
    });
    const mcp = largeMcpCatalog ? await createLargeMcpCatalog(home) : undefined;
    registry = createDesktopBackendRegistry({
      codexClient, overlayStore: new SqliteOverlayStore(db), messagingStore: null,
      mcpConnectionService: mcp?.service ?? null,
      threadTitleGenerationService: null, discoverLocalAcpAgents: async () => [],
      acpAgentStore, acpSessionStore: new AcpSessionStore(db),
      createAcpTransport: (agent) => {
        if (!agent.launchDescriptor) throw new Error("Missing benchmark ACP launch descriptor.");
        return new AcpStdioJsonRpcTransport({ launchDescriptor: agent.launchDescriptor, baseEnv: env });
      },
      claudeBackendOptions: {
        store: new ClaudeSessionStore(path.join(home, "claude-store")),
        inspectInstallation: async () => ({ executable: claude, authStatus: "signed-in" }),
        discoverModels: async () => [],
        resolveEnv: async () => env,
        // Production strips inherited API keys. Inject this dummy only at the
        // SDK boundary so the real CLI can authenticate to the local endpoint.
        query: (args) => query({ ...args, options: {
          ...args.options, env: { ...args.options?.env, ANTHROPIC_API_KEY: "fixture-key" },
        } }),
      },
    });
    const terminal: Array<{ method: string; params: unknown }> = [];
    registry.onEvent(({ backend, notification }) => {
      if (backend === provider && (notification.method === "turn/completed" || notification.method === "turn/failed")) {
        terminal.push(notification);
      }
    });
    const { threadId } = await registry.startThread({
      backend: provider, cwd, ...codexPolicy,
      ...(mcp ? { mcpConnectionIds: mcp.connectionIds } : {}),
      ...(provider === "codex" ? { model: codexModel } : provider === "claude" ? { model: "sonnet" } : {}),
      ...(comparison ? {} : { agent: { name: "Checkout test fixture", instructions } }),
    });
    async function measureTurn(index: number, text: string): Promise<Capture> {
      const start = endpoint.requests.length;
      await registry!.startTurn({ backend: provider, threadId, ...codexPolicy, input: [{ type: "text", text }] });
      await vi.waitFor(() => expect(terminal[index]).toBeDefined(), { timeout: 15_000 });
      expect(terminal[index]!.method, JSON.stringify({ terminal: terminal[index], paths: endpoint.paths })).toBe("turn/completed");
      const requests = endpoint.requests.slice(start);
      return { metrics: turnMetrics(requests, text, comparison ? undefined : instructions), requests };
    }
    const first = await measureTurn(0, initialPrompt);
    const next = await measureTurn(1, nextPrompt);
    if (mcp) {
      const acpReport = provider === antigravity
        ? await registry.describeThreadMcpConnections({ backend: provider, threadId }) : undefined;
      if (acpReport?.managedConnectionsViaGateway) {
        expect(acpReport.connections.map(({ connectionId }) => connectionId)).toEqual(mcp.connectionIds);
        expect(first.requests.some(({ body }) => JSON.stringify(body).includes("search_mcp_tools")),
          "the model must be able to search the configured connections").toBe(true);
        expect.soft([first, next].some(hasFullMcpSchemas), "Antigravity gateway exposed a full MCP schema").toBe(false);
      } else {
        for (const { id, listingLog } of mcp.catalogs) {
          const listings = await readFile(listingLog, "utf8").catch(() => "");
          expect(listings.trim().split("\n"), `${provider} lists the ${id} fixture over MCP`).toContain(String(toolsPerConnection));
        }
      }
    }
    return [first, next];
  } finally {
    try {
      await registry?.close();
    } finally {
      db.close();
      await endpoint.close();
      await rm(home, { recursive: true, force: true });
    }
  }
}

// Byte ceilings leave headroom for native runtime and OS metadata. Call
// ceilings track the actual fixture, including Antigravity's title request.
const ceilings: Record<Provider, Metrics> = {
  codex: {
    firstBytes: 58_000, firstCalls: 1, nextBytes: 59_000, nextCalls: 1,
    firstPrimaryBytes: 58_000, firstInputBytes: 2_600, firstInstructionBytes: 38_000, firstToolBytes: 16_500,
    nextPrimaryBytes: 59_000, nextInputBytes: 3_500, nextInstructionBytes: 38_000, nextToolBytes: 16_500,
  },
  claude: {
    firstBytes: 74_000, firstCalls: 1, nextBytes: 75_000, nextCalls: 1,
    firstPrimaryBytes: 74_000, firstInputBytes: 1_250, firstInstructionBytes: 28_000, firstToolBytes: 44_000,
    nextPrimaryBytes: 75_000, nextInputBytes: 1_600, nextInstructionBytes: 29_000, nextToolBytes: 44_000,
  },
  [antigravity]: {
    firstBytes: 58_000, firstCalls: 2, nextBytes: 57_000, nextCalls: 1,
    firstPrimaryBytes: 55_000, firstInputBytes: 1_650, firstInstructionBytes: 21_000, firstToolBytes: 32_000,
    nextPrimaryBytes: 56_000, nextInputBytes: 2_500, nextInstructionBytes: 21_000, nextToolBytes: 32_000,
  },
};

const mcpCeilings = {
  codex: { firstBytes: 60_000, nextBytes: 62_000, firstToolBytes: 19_000, nextToolBytes: 19_000 },
  claude: { firstBytes: 90_000, nextBytes: 92_000, firstToolBytes: 45_000, nextToolBytes: 45_000 },
  // The pinned Antigravity runtime uses stdio MCP and advertises a subset of
  // the catalog up front. Budget that path separately until it can defer tools.
  [antigravity]: { firstBytes: 125_000, nextBytes: 124_000, firstToolBytes: 100_000, nextToolBytes: 100_000 },
} satisfies Record<Provider, Pick<Metrics, "firstBytes" | "nextBytes" | "firstToolBytes" | "nextToolBytes">>;

function hasFullMcpSchemas({ requests }: Capture): boolean {
  return requests.some(({ body }) => JSON.stringify(body).includes(catalogMarker));
}

const codexExecutable = process.env.PWRAGENT_MODEL_BENCH_CODEX;
const antigravityExecutable = process.env.PWRAGENT_MODEL_BENCH_AGY;
const artifactPath = process.env.PWRAGENT_MODEL_BENCH_RESULT;
const mcpArtifactPath = process.env.PWRAGENT_MODEL_BENCH_MCP_RESULT;
it.runIf(Boolean(artifactPath || (codexExecutable && antigravityExecutable)))(
  "keeps outbound model requests bounded on first turns and follow-ups",
  async () => {
    if (!codexExecutable || !antigravityExecutable) throw new Error("Set both pinned agent executable paths.");
    const results = [];
    for (const provider of providers) {
      const [firstCapture, nextCapture] = await captureModelRequests(provider, codexExecutable, antigravityExecutable);
      const first = firstCapture!.metrics;
      const next = nextCapture!.metrics;
      const observed = {
        firstBytes: first.bytes, firstCalls: first.calls, firstPrimaryBytes: first.primaryBytes,
        firstInputBytes: first.inputBytes, firstInstructionBytes: first.instructionBytes, firstToolBytes: first.toolBytes,
        nextBytes: next.bytes, nextCalls: next.calls, nextPrimaryBytes: next.primaryBytes,
        nextInputBytes: next.inputBytes, nextInstructionBytes: next.instructionBytes, nextToolBytes: next.toolBytes,
      };
      results.push({ provider, observed, ceilings: ceilings[provider] });
    }
    if (artifactPath) await writeFile(artifactPath, JSON.stringify({ version: 1, results }) + "\n");
    for (const { provider, observed, ceilings: limits } of results) {
      for (const key of Object.keys(limits) as Array<keyof Metrics>) {
        expect.soft(observed[key], `${provider} ${key}`).toBeLessThanOrEqual(limits[key]);
      }
    }
  },
  80_000,
);

it.runIf(Boolean(artifactPath || mcpArtifactPath || (codexExecutable && antigravityExecutable)))(
  "keeps first turns and follow-ups bounded with 240 configured MCP tools",
  async () => {
    if (!codexExecutable || !antigravityExecutable) throw new Error("Set both pinned agent executable paths.");
    const results = [];
    for (const provider of providers) {
      const captures = await captureModelRequests(provider, codexExecutable, antigravityExecutable, { largeMcpCatalog: true });
      const [first, next] = captures.map(({ metrics }) => metrics);
      const { firstCalls, nextCalls } = ceilings[provider];
      const limits = { ...mcpCeilings[provider], firstCalls, nextCalls };
      const fullSchemasAdvertised = captures.map(hasFullMcpSchemas);
      const observed = {
        firstBytes: first!.bytes, firstToolBytes: first!.toolBytes, firstCalls: first!.calls,
        nextBytes: next!.bytes, nextToolBytes: next!.toolBytes, nextCalls: next!.calls,
      };
      results.push({ provider, first, next, ceilings: limits, fullSchemasAdvertised });
      for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
        expect.soft(observed[key], `${provider} large MCP catalog ${key}`).toBeLessThanOrEqual(limits[key]);
      }
      for (const [index, advertised] of fullSchemasAdvertised.entries()) {
        if (provider !== antigravity) {
          expect.soft(advertised, `${provider} sent a full MCP schema on turn ${index + 1}`).toBe(false);
        }
      }
    }
    if (mcpArtifactPath) {
      await writeFile(mcpArtifactPath, JSON.stringify({ version: 1, results }) + "\n");
    }
  },
  80_000,
);
const comparisonPath = process.env.PWRAGENT_MODEL_BENCH_COMPARISON;
it.runIf(Boolean(comparisonPath))("compares Desktop first turns and follow-ups with fresh CLI turns", async () => {
  if (!codexExecutable || !antigravityExecutable) throw new Error("Set both pinned agent executable paths.");
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-model-workspace-")));
  try {
    await writeFile(path.join(cwd, "checkout.test.ts"), "// Synthetic checkout test for the model request comparison.\n");
    const results = [];
    for (const provider of providers) {
      const [desktop, desktopFollowUp] = await captureModelRequests(provider, codexExecutable, antigravityExecutable, { comparison: { cwd, mode: "desktop" } });
      const [cli] = await captureModelRequests(provider, codexExecutable, antigravityExecutable, { comparison: { cwd, mode: "cli" } });
      const modelFor = (capture: Capture) => {
        const mainRequest = capture.requests.find(({ bytes }) => bytes === capture.metrics.primaryBytes)!;
        return mainRequest.body.model ?? mainRequest.route;
      };
      const model = modelFor(desktop!);
      expect(modelFor(desktopFollowUp!)).toBe(model);
      expect(modelFor(cli!)).toBe(model);
      results.push({ provider, model, desktop, desktopFollowUp, cli });
    }
    // This local opt-in contains synthetic request bodies. CI uploads only sizes.
    await writeFile(comparisonPath!, JSON.stringify({
      version: 1, prompt: initialPrompt, followUpPrompt: nextPrompt, results,
    }) + "\n", { mode: 0o600, flag: "wx" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 120_000);
