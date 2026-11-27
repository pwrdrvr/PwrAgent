// Run with the desktop package's tsx. Only the generated local fixture is approved.
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

// Same raw skill imports as the desktop bundle.
registerHooks({ load(url, context, next) {
  return url.endsWith("?raw")
    ? { shortCircuit: true, format: "module", source: "export default " + JSON.stringify(readFileSync(new URL(url), "utf8")) }
    : next(url, context);
} });
const { AgentToolMcpServer } = await import("../src/main/agent-tools/agent-tool-mcp-server.ts");
const { AgentToolRouter, toMcpToolResponse } = await import("../src/main/agent-tools/agent-tool-router.ts");
const { boundedCommandTools } = await import("../src/main/agent-tools/bounded-command-tool.ts");
const { buildPwrAgentToolSearchDefinition, withPwrAgentToolDiscovery } = await import("../src/main/agent-tools/pwragent-tool-search.ts");
const { BoundedCommandCapture } = await import("../src/main/token-miser/bounded-command.ts");
const { acpToolUpdateNotifications } = await import("../src/main/acp/acp-live-notifications.ts");

const [provider, variant, executable] = process.argv.slice(2);
if (!["agy", "codex", "claude"].includes(provider) || !["raw", "bounded", "capture", "deny", "cancel", "interrupt", "interrupt-raw", "readonly", "readonly-raw", "code-mode", "code-mode-raw", "code-mode-reducer", "code-mode-helper", "code-mode-batch", "code-mode-raw-batch", "code-mode-discovery"].includes(variant)) {
  throw new Error("Usage: benchmark-bounded-command.mjs agy|codex|claude raw|bounded|capture|deny|cancel|interrupt|interrupt-raw|readonly|readonly-raw|code-mode|code-mode-raw|code-mode-reducer|code-mode-helper|code-mode-batch|code-mode-raw-batch|code-mode-discovery [binary]");
}
const desktop = fileURLToPath(new URL("../", import.meta.url));
const codeMode = variant.startsWith("code-mode") || process.env.PWRAGENT_BENCHMARK_CODE_MODE === "1";
const raw = ["raw", "code-mode-raw", "code-mode-raw-batch"].includes(variant);
const discovery = variant === "code-mode-discovery";
const readonly = variant === "readonly" || variant === "readonly-raw";
if (readonly && provider !== "codex") throw new Error("This control uses the App Server read-only sandbox.");
const fixtureRoot = readonly ? path.join(desktop, ".local") : tmpdir();
await mkdir(fixtureRoot, { recursive: true });
const cwd = path.join(await mkdtemp(path.join(fixtureRoot, "pwragent-output-benchmark-")), "work");
const outputRoot = path.join(desktop, ".local/protocol-captures");
await mkdir(outputRoot, { recursive: true });
const artifact = await mkdtemp(path.join(outputRoot, `bounded-${provider}-${variant}-`));
const trace = createWriteStream(path.join(artifact, "frames.jsonl"), { mode: 0o600 });
const record = (type, data) => trace.write(JSON.stringify({ type, data }) + "\n");
const fixture = path.resolve(desktop, "../../scripts/token-miser-benchmark/fixture.py");
const workflow = execFileSync("python3", [fixture, cwd, ...(variant === "bounded" ? ["--bounded"] : [])], { encoding: "utf8" });
const helperMode = variant === "code-mode-helper";
let helperClient;
let helper;
const helperRuns = [];
if (helperMode) {
  const file = path.join(cwd, "headers.css");
  const previous = execFileSync("git", ["show", ":headers.css"], { cwd, encoding: "utf8" });
  const current = readFileSync(file, "utf8");
  const unchanged = "/* unchanged rule */\n".repeat(10);
  await writeFile(file, previous + unchanged + "tfoot { top: 0; }\n");
  execFileSync("git", ["add", "--", "headers.css"], { cwd });
  await writeFile(file, current + unchanged + "tfoot { top: 7px; }\n");
  const { CodexAppServerClient } = await import("../src/main/codex-app-server/desktop-client.ts");
  const { installOwnerHostServices } = await import("../src/main/owner-host.ts");
  const { boundedCommandHelper } = await import("../src/main/token-miser/bounded-command-helper.ts");
  installOwnerHostServices({ application: { getVersion: () => "1", isPackaged: false, getPath: () => artifact } });
  helperClient = new CodexAppServerClient({ command: executable || "codex" });
  helperClient.onRequest(() => ({ decision: "decline" }));
  helper = boundedCommandHelper({ resolveTokenMiserBoundedHelper: () => "codex" }, {
    generateStructuredObject: async (params) => {
      const started = Date.now();
      const result = await helperClient.generateStructuredObject(params);
      helperRuns.push({ status: result.status, model: result.model, usage: result.tokenUsage, reason: result.reason,
        evidenceBytes: Buffer.byteLength(params.prompt), elapsedMs: Date.now() - started });
      return result;
    },
  });
}
const original = ["git diff", "node --test passing.test.cjs", "node --test sticky.test.cjs"];
const captureMode = !raw && variant !== "bounded";
const negative = variant === "deny" || variant === "cancel";
const interrupt = variant === "interrupt" || variant === "interrupt-raw";
if (negative) {
  await writeFile(path.join(cwd, "passing.test.cjs"), 'require("node:fs").writeFileSync("executed", "yes");\n');
}
if (interrupt) {
  await writeFile(path.join(cwd, "passing.test.cjs"), [
    'const fs = require("node:fs");', 'fs.writeFileSync("started", "yes");',
    'setTimeout(() => fs.writeFileSync("finished", "yes"), 5000);',
  ].join("\n"));
}
if (readonly) {
  await writeFile(path.join(cwd, "passing.test.cjs"), 'require("node:fs").writeFileSync("disallowed-by-readonly", "fixture");\n');
}
const task = readonly ? (variant === "readonly-raw"
  ? "Run node --test passing.test.cjs. Report its exit status. No escalation or other commands."
  : "Prepare node --test passing.test.cjs with capture_token_miser_command. Execute its exact returned shell command once. Report exit status. No escalation or other commands.")
  : variant === "interrupt-raw" ? "Run node --test passing.test.cjs directly in your native shell once. Stop on interruption."
  : negative || interrupt
  ? "Prepare node --test passing.test.cjs with capture_token_miser_command. Run only its returned command once. If denied or cancelled stop."
  : captureMode
  ? "Run sed -n '1,3p' headers.css. Then for each of git diff, node --test passing.test.cjs, node --test sticky.test.cjs, call capture_token_miser_command with command, execute the returned command verbatim in the native foreground shell, then call capture_token_miser_command with only objectId. On Antigravity use call_pwragent_tool with toolName and arguments. Report changed filename, header position and offset, pass and failure names, expected/actual and final exit status. Do not edit files or run other commands."
  : workflow + "\nRun these commands directly. Do not use the capture tool or any extra commands.";

const workflowProbe = [
  'for name, params in [("mcp_pwragent_call_pwragent_tool", {"toolName": "capture_token_miser_command", "arguments": {"command": "git diff"}}), ("run_command", {"CommandLine": "git diff --stat", "WaitMsBeforeAsync": 10000})]:',
  '    try:',
  '        print(name, (await call_tool(name, **params))[:600])',
  '    except Exception as e:',
  '        print(name, type(e).__name__, str(e)[:400])',
].join("\n");
const prompt = codeMode && provider === "agy"
  ? "Test your native run_workflow's direct tool support. Call run_workflow exactly once with WaitMsBeforeAsync=10000 and this exact inline Script. Report each result or denial, then stop.\n\n" + workflowProbe
  : variant === "code-mode-raw-batch" ? task + " Call the four tools serially inside one native JavaScript Code Mode cell and emit their results."
  : discovery ? "Discover capture_token_miser_command with pwragent.tool_search. Then run the task in one native JavaScript Code Mode cell, emitting only the summaries and retrieval handles. " + task
  : variant === "code-mode-batch"
  ? task + " Use one native JavaScript Code Mode cell. Keep the preparation response inside the cell (parse JSON text if needed), await the returned command to completion, inspect by objectId, and emit only the summary and objectId for each command. Do not print the prepared commands."
  : codeMode ? "Use only native Code Mode (JavaScript tool cells or REPL) to call the tools for the following task. If your harness does not offer native tool orchestration in code, answer CODE_MODE_UNAVAILABLE and stop. Do not emulate it in a shell or use direct calls. " + task : task;
let codeCells = 0;
let workflowApproved = false;
let workflowCompleted = false;
let workflowAnswer = "";
let claudeTools;
let claudeResult;
const backend = provider === "agy" ? "acp:antigravity" : provider;
let caller;
const capture = new BoundedCommandCapture(async (ctx) => !!caller
  && ctx.backend === caller.backend && ctx.threadId === caller.threadId && ctx.turnId === caller.turnId,
  async (_ctx, command) => original.includes(command), () => helper);
let [definition] = boundedCommandTools(capture);
const issues = [];
const results = [];

async function verifyRetrieval(context, issue, summary) {
  const hash = createHash("sha256");
  const chunks = [];
  let offset = 0;
  for (;;) {
    const page = (await definition.dispatch({ objectId: issue.objectId, byteOffset: offset }, context)).data;
    const bytes = Buffer.from(page.base64, "base64");
    hash.update(bytes);
    chunks.push(bytes);
    offset += bytes.length;
    if (offset === page.totalBytes) break;
  }
  const full = Buffer.concat(chunks);
  const failing = issue.original.includes("sticky.test");
  const lines = full.toString("utf8").split("\n");
  const needle = issue.original === "git diff" ? "diff --git" : failing ? "Expected sticky header, got static" : "passing table header";
  const lineNumber = 1 + lines.findIndex((line) => line.includes(needle));
  const range = await definition.dispatch({ objectId: issue.objectId, startLine: lineNumber, endLine: lineNumber }, context);
  const search = await definition.dispatch({ objectId: issue.objectId, query: needle }, context);
  if (!lineNumber || range.data !== lines[lineNumber - 1].replace(/\r$/u, "")
    || !search.data?.includes(`${lineNumber}: ${range.data}`)) throw new Error("Search or line-range retrieval differed from the original bytes.");
  if (!summary.startsWith(`${issue.original} exited ${failing ? 1 : 0}.`)) throw new Error("Incorrect exit status.");
  if (issue.original === "git diff") {
    if (!full.equals(execFileSync("git", ["diff"], { cwd }))) throw new Error("Retrieved diff differs from Git.");
  } else if ((full.toString().match(/Rendering table preview frame/g) ?? []).length !== 1100
    || !summary.includes(failing ? "Expected sticky header, got static" : "passing table header")) {
    throw new Error("Retrieved test output or deterministic diagnostics differ from the fixture.");
  }
  results.push({ objectId: issue.objectId, command: issue.original, bytes: offset, sha256: hash.digest("hex"), summary });
}

const router = new AgentToolRouter([{ ...definition, dispatch: async (args, context) => {
  const result = await definition.dispatch(args, context);
  if (result.ok && args.command) issues.push({ original: args.command, ...result.data });
  if (!readonly && result.ok && args.objectId && Object.keys(args).length === 1 && !results.some((r) => r.objectId === args.objectId)) {
    const issue = issues.find((i) => i.objectId === args.objectId);
    await verifyRetrieval(context, issue, result.data);
  }
  record("owner_tool_output", { bytes: toMcpToolResponse(result).content.reduce((n, c) => n + Buffer.byteLength(c.text ?? ""), 0) });
  return result;
} }]);
const specs = withPwrAgentToolDiscovery(router.buildDynamicToolSpecs(), discovery);
let managedStore;
let searches = 0;
const server = new AgentToolMcpServer({ resolveCallContext: () => caller,
  resolveCatalogs: () => [{ id: "token_miser", router }] });
const registration = await server.registerClient({ backend });
const exact = new Set(raw ? ["cat headers.css", ...original] : ["sed -n '1,3p' headers.css"]);
if (variant === "bounded") for (const command of workflow.trim().split("\n").slice(-4)) exact.add(command);
const allow = (command) => !negative && (exact.has(command) || issues.some((i) => i.command === command));
let startedAt;
function interruptWhenRunning(stop) {
  if (!interrupt) return;
  const poll = setInterval(() => {
    if (existsSync(path.join(cwd, "started"))) {
      clearInterval(poll);
      startedAt = Date.now();
      stop();
    }
  }, 25);
  poll.unref();
  return poll;
}
async function verifyInterruption() {
  if (!interrupt) return;
  if (!startedAt || (variant !== "interrupt-raw" && !issues.length)) throw new Error("Native command did not reach the interruption point.");
  // Keep the harness alive past the child's deadline. Teardown must not make cancellation pass.
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, startedAt + 5500 - Date.now())));
  const survived = existsSync(path.join(cwd, "finished"));
  record("interrupted_child", { survived });
  if (survived && variant !== "interrupt-raw") throw new Error("Native child continued after interruption.");
}
const activate = (threadId, turnId) => {
  registration.bindThread(threadId);
  caller = { backend, threadId, turnId, transport: "mcp" };
  managedStore?.startTurn(threadId, turnId);
};
function observe(notification) {
  const item = notification.params.item;
  if (caller && item?.type === "commandExecution") {
    capture.observe(caller, { id: item.id, processId: item.processId, command: item.commandSource === "tool" ? undefined : item.command,
      completed: notification.method === "item/completed" && !["declined", "interrupted", "cancelled"].includes(item.status),
      output: item.aggregatedOutput ?? item.data?.output });
  }
}

async function runRpc() {
  const acp = provider === "agy";
  let bridge;
  let db;
  let reducer;
  let reducerObservations = 0;
  const evaluations = [];
  const cells = new AsyncLocalStorage();
  if (variant === "code-mode-reducer" || (provider === "codex" && codeMode && process.env.PWRAGENT_BENCHMARK_MANAGED_REDUCER === "1")) {
    const { TokenMiserHookBridge } = await import("../src/main/token-miser/token-miser-hook-bridge.ts");
    const { TokenMiserService } = await import("../src/main/token-miser/token-miser-service.ts");
    const { TokenMiserStore } = await import("../src/main/token-miser/token-miser-store.ts");
    const { StateDb } = await import("../src/main/state/state-db.ts");
    const { SqliteTokenMiserStorage } = await import("../src/main/storage/token-miser-storage-sqlite.ts");
    const { buildCodexTokenMiserConfig } = await import("../src/main/app-server/codex-thread-config.ts");
    db = StateDb.open(path.join(artifact, "state.db"));
    managedStore = new TokenMiserStore(artifact, { storage: new SqliteTokenMiserStorage(db),
      onCodeModeObservationUpdated: () => { reducerObservations++; } });
    [definition] = boundedCommandTools(capture, managedStore);
    class ObservedService extends TokenMiserService {
      prepareCodeModeOutput(payload, options) {
        return cells.run({ cellId: payload.cell_id, discovery: payload.script?.includes("tool_search") === true,
          size: payload.content_items.reduce((n, item) => n + Buffer.byteLength(item.text), 0) },
        () => super.prepareCodeModeOutput(payload, options));
      }
    }
    const service = new ObservedService({ store: managedStore, isEnabled: () => true, generateSummary: async () => {
      evaluations.push(cells.getStore());
      return { status: "unavailable", reason: "Benchmark records evaluation requests without starting another provider." };
    } });
    bridge = new TokenMiserHookBridge({ service, stateDir: artifact });
    await bridge.start();
    reducer = buildCodexTokenMiserConfig(bridge.codeModeReducerDescriptorPath).features.code_mode;
  }
  const searchRouter = new AgentToolRouter([buildPwrAgentToolSearchDefinition(specs, managedStore)]);
  const child = spawn(executable || (acp ? "agy" : "codex"), acp ? ["acp", "--process-per-session"]
    : ["app-server", "-c", 'model_reasoning_effort="low"'], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const errors = createWriteStream(path.join(artifact, "stderr"), { mode: 0o600 });
  child.stderr.pipe(errors);
  const frames = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const timer = setTimeout(() => child.kill(), 180_000);
  const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  let id = 0;
  const poll = interruptWhenRunning(() => send(acp
    ? { method: "session/cancel", params: { sessionId: caller.threadId } }
    : { id: ++id, method: "turn/interrupt", params: { threadId: caller.threadId, turnId: caller.turnId } }));
  async function next() {
    const { value, done } = await frames.next();
    if (done) throw new Error("Harness closed before completion");
    const m = JSON.parse(value);
    record("frame", m);
    const p = m.params;
    if (m.method === "rawResponseItem/completed" && p.item?.type === "custom_tool_call" && p.item.name === "exec") codeCells++;
    if (m.method === "turn/started") activate(p.threadId, p.turn.id);
    if (m.method === "item/started" || m.method === "item/completed") observe(m);
    if (m.method === "session/update" && caller) {
      if (p.update.name === "run_workflow" && p.update.status === "completed") workflowCompleted = true;
      if (p.update.sessionUpdate === "agent_message_chunk") workflowAnswer += p.update.content?.text ?? "";
      for (const n of acpToolUpdateNotifications({ backendId: backend, ...caller, cwd, update: p.update })) observe(n);
    }
    if (m.method === "item/tool/call") {
      const isSearch = discovery && p.tool === "tool_search";
      if (isSearch) searches++;
      send({ id: m.id, result: await (isSearch ? searchRouter : router).handleDynamicToolCall({ backend, call: p }) });
    } else if (m.method === "session/request_permission") {
      const tool = p.toolCall;
      const exactWorkflow = codeMode && tool.name === "run_workflow" && tool.rawInput?.Script?.trim() === workflowProbe
        && Object.keys(tool.rawInput).every((key) => ["Script", "Description", "WaitMsBeforeAsync", "toolSummary"].includes(key));
      if (exactWorkflow) workflowApproved = true;
      const eligible = exactWorkflow || ["mcp_pwragent_call_pwragent_tool", "mcp_pwragent_tool_search"].includes(tool.name)
        || allow(tool.rawInput?.CommandLine);
      const option = p.options.find((candidate) => candidate.kind === (eligible ? "allow_once" : "reject_once"));
      const outcome = !option || (!eligible && variant === "cancel") ? { outcome: "cancelled" }
        : { outcome: "selected", optionId: option.optionId };
      send({ id: m.id, result: { outcome } });
    } else if (m.id !== undefined && m.method) {
      if (m.method.endsWith("/requestApproval")) send({ id: m.id, result: { decision: "decline" } });
      else send({ id: m.id, error: { code: -32601, message: "Unsupported benchmark client request." } });
    }
    return m;
  }
  async function call(method, params) {
    const request = ++id;
    send({ id: request, method, params });
    for (;;) {
      const m = await next();
      if (m.id === request && !m.method) {
        if (m.error) throw new Error(String(m.error.message).slice(0, 240));
        return m.result;
      }
    }
  }
  try {
    const clientInfo = { name: "pwragent", version: "1" };
    await call("initialize", acp ? { protocolVersion: 1, clientInfo, clientCapabilities: { terminal: false, fs: { readTextFile: false, writeTextFile: false } } }
      : { clientInfo, capabilities: { experimentalApi: true } });
    if (acp) {
      const { sessionId } = await call("session/new", { cwd, mcpServers: [registration.server] });
      activate(sessionId, randomUUID());
      await call("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
    } else {
      send({ method: "initialized", params: {} });
      const { thread } = await call("thread/start", { cwd, ephemeral: true, sandbox: readonly ? "read-only" : "workspace-write",
        ...(codeMode ? { experimentalRawEvents: true, config: { features: { code_mode: reducer ? { ...reducer, enabled: true } : true, code_mode_only: true, code_mode_tool_search: true } } } : {}),
        approvalPolicy: negative ? "untrusted" : "never", dynamicTools: specs });
      await call("turn/start", { threadId: thread.id, input: [{ type: "text", text: prompt }] });
      while ((await next()).method !== "turn/completed") { /* drain the live turn */ }
      if (variant === "interrupt") {
        await capture.endTurn(caller, async (matches) => {
          const list = await call("thread/backgroundTerminals/list", { threadId: thread.id });
          for (const terminal of list.data.filter(matches)) {
            record("terminal_stop", await call("thread/backgroundTerminals/terminate", { threadId: thread.id, processId: terminal.processId }));
          }
        });
      }
      if (readonly) {
        const command = variant === "readonly-raw" ? original[1] : issues[0]?.command;
        if (!command) throw new Error("No exact command for the read-only control.");
        const result = await call("command/exec", { command: ["/bin/zsh", "-lc", command], cwd,
          sandboxPolicy: { type: "readOnly" }, outputBytesCap: 4096 });
        record("readonly_oracle", { exitCode: result.exitCode, denied: /permitted|denied|read-only/iu.test(result.stdout + result.stderr) });
        if (result.exitCode === 0 || (variant === "readonly" && /pwragent-[a-f0-9-]+:0/u.test(result.stdout))) {
          throw new Error("Read-only execution succeeded unexpectedly.");
        }
      }
    }
    await verifyInterruption();
    if (bridge) {
      record("managed_reducer", { reducerObservations, evaluations });
      if (!reducerObservations || evaluations.some((cell) => !discovery || !cell?.discovery || cell.size < 5000)) {
        throw new Error("Expected managed cell observations and no second evaluation of bounded command results.");
      }
    }
  } finally {
    clearInterval(poll);
    clearTimeout(timer);
    child.kill();
    await bridge?.close();
    db?.close();
    errors.end();
  }
}

async function runClaude() {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const { claudeHarnessOptions } = await import("../src/main/claude/claude-models.ts");
  const { createClaudePermissionHandler } = await import("../src/main/claude/claude-permissions.ts");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  activate(randomUUID(), randomUUID());
  const gate = Promise.withResolvers();
  async function* input() {
    await gate.promise;
    yield { type: "user", session_id: caller.threadId, parent_tool_use_id: null, message: { role: "user", content: prompt } };
    if (!controller.signal.aborted) await new Promise((r) => controller.signal.addEventListener("abort", r, { once: true }));
  }
  const session = query({ prompt: input(), options: {
    ...claudeHarnessOptions(executable || "claude", process.env), cwd, sessionId: caller.threadId, persistSession: false,
    permissionMode: "default", abortController: controller, ...(codeMode ? {} : { tools: ["Bash"] }), strictMcpConfig: true,
    canUseTool: createClaudePermissionHandler({ threadId: caller.threadId, turnId: () => caller.turnId,
      request: async (request) => {
        record("approval", request.params);
        return { decision: request.params.toolName === "mcp__pwragent__capture_token_miser_command"
          || allow(request.params.arguments?.command) ? "accept" : "decline" };
      }, cancelRequest: async () => {} }),
  } });
  const poll = interruptWhenRunning(() => { void session.interrupt().catch(() => controller.abort()); });
  try {
    const { url, headers } = registration.server;
    const result = await session.setMcpServers({ pwragent: { type: "http", url, headers: Object.fromEntries(headers.map((h) => [h.name, h.value])) } });
    if (Object.keys(result.errors).length) throw new Error("Claude rejected the fixture MCP server.");
    gate.resolve();
    for await (const message of session) {
      record(message.type, message);
      if (message.type === "system" && message.subtype === "init") claudeTools = message.tools;
      if (message.type === "result") claudeResult = message.result;
      for (const block of message.message?.content ?? []) {
        if (block.type === "tool_use" && block.name === "REPL") codeCells++;
        if (block.type === "tool_use" && block.name === "Bash") capture.observe(caller, { id: block.id, command: block.input.command, completed: false });
        if (block.type === "tool_result") capture.observe(caller, { id: block.tool_use_id, completed: true,
          output: typeof block.content === "string" ? block.content : block.content?.map((c) => c.text).join("\n") });
      }
      if (message.type === "result") break;
    }
    await verifyInterruption();
  } finally {
    clearInterval(poll);
    clearTimeout(timer);
    controller.abort();
    session.close();
  }
}

try {
  if (provider === "claude") await runClaude();
  else await runRpc();
  if (readonly) {
    if (existsSync(path.join(cwd, "disallowed-by-readonly"))) throw new Error("Native read-only sandbox allowed a workspace write.");
    if (variant === "readonly" && !issues.length) throw new Error("Missing captured read-only attempt.");
  }
  if (negative || interrupt) {
    for (const issue of issues) {
      try {
        await capture.inspect(caller, issue.objectId);
        throw new Error("A denied command produced a completion receipt.");
      } catch (error) {
        if (!/No native completion receipt|Output expired or unavailable/u.test(String(error))) throw error;
      }
    }
  }
  if (negative && (!issues.length || existsSync(path.join(cwd, "executed")))) throw new Error("Negative control failed.");
  if (codeMode && provider === "agy" && !(workflowApproved && workflowCompleted && /call_tool.*not defined/su.test(workflowAnswer))) {
    throw new Error("Antigravity workflow capability changed or the exact probe did not complete. Inspect the synthetic frames.");
  }
  if (codeMode && provider === "claude" && (!Array.isArray(claudeTools)
    || (claudeTools.includes("REPL") ? !codeCells || results.length < 3 : !claudeResult?.includes("CODE_MODE_UNAVAILABLE")))) {
    throw new Error("Claude Code Mode capability changed or the fixture did not complete.");
  }
  if (discovery && !searches) throw new Error("The fixture did not search the deferred catalog.");
  if (provider === "codex" && codeMode && codeCells < 1) throw new Error("No native Code Mode cell observed.");
  if ((variant === "capture" || (provider === "codex" && variant.startsWith("code-mode") && !raw)) && !original.every((cmd) => results.some((r) => r.command === cmd && r.bytes > 0))) throw new Error("Missing captured fixture output.");
  await writeFile(path.join(artifact, "result.json"), JSON.stringify({ cwd, provider, executable, variant, codeMode, codeCells, results, helperRuns }, null, 2), { mode: 0o600 });
  console.log(artifact);
  if (helperMode && (helperRuns.length !== 1 || helperRuns[0].status !== "ok")) throw new Error("Expected one successful isolated Codex helper call.");
} finally {
  caller = undefined;
  await capture.close();
  await helperClient?.close();
  await server.close();
  trace.end();
  await finished(trace);
}
