import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildCodexModelProviderConfigOverrides,
  buildCodexModelProviderShellEnvOverrides,
  codexModelProviderApiKeyEnv,
  type CodexModelProviderSettings,
} from "@pwragent/shared/codex-model-providers";
import { CodexAppServerClient } from "./desktop-client";
import { preparePortableProviderRuntime } from "./portable-provider-runtime";

/** A fresh Codex home; credentials stay in the owning process and transport. */
export async function verifyPortableProvider(
  provider: CodexModelProviderSettings,
  apiKey: string | undefined,
  command: string,
): Promise<{ requests: number; initialToolBytes?: number; initialRequestBytes?: number }> {
  const home = await mkdtemp(path.join(tmpdir(), "pwragent-portable-check-"));
  const model = provider.models?.[0];
  if (!model) { await rm(home, { recursive: true, force: true }); throw new Error("Choose a model to test portable discovery."); }
  const marker = `PWRAGENT_PORTABLE_${randomUUID()}`;
  const tool = `read_marker_${randomUUID().replaceAll("-", "")}`;
  let requests = 0;
  let invocations = 0;
  let initialToolBytes: number | undefined;
  let initialRequestBytes: number | undefined;
  let failureStage = "execution";
  let finalText = "";
  let client: CodexAppServerClient | undefined;
  let runtime: Awaited<ReturnType<typeof preparePortableProviderRuntime>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    runtime = await preparePortableProviderRuntime({ ...provider, toolDiscovery: "portable" }, apiKey, {
      maxRequests: 6,
      onDiagnostic: event => {
        if (event.stage === "upstream_error") failureStage = `upstream request (HTTP ${event.status})`;
        if (event.stage === "transport_error") failureStage = event.phase ?? "transport";
        if (event.stage !== "request") return;
        if (++requests === 1) { initialToolBytes = event.toolBytes; initialRequestBytes = event.outputBytes; }
      },
    });
    client = new CodexAppServerClient({
      command, portableDiscovery: true, authenticationRecovery: false,
      args: [...buildCodexModelProviderConfigOverrides([provider], new Set(apiKey ? [provider.id] : [])),
        ...buildCodexModelProviderShellEnvOverrides([provider.id]), ...runtime.overrides].flatMap(value => ["-c", value]),
      env: { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, CODEX_HOME: home,
        ...(apiKey ? { [codexModelProviderApiKeyEnv(provider.id)]: apiKey } : {}) },
      resolveModelProviderIds: () => new Set([provider.id]),
    });
    let complete!: () => void;
    let fail!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    void done.catch(() => {});
    timer = setTimeout(() => fail(new Error("Portable discovery check timed out.")), 120_000);
    client.onAppServerUnexpectedExit(() => fail(new Error("The portable discovery check's Codex process exited.")));
    let threadId: string | undefined;
    client.onRequest(request => {
      if (request.method !== "item/tool/call" || request.params.threadId !== threadId
        || request.params.namespace !== "portable_probe" || request.params.tool !== tool
        || !request.params.arguments || typeof request.params.arguments !== "object"
        || Object.keys(request.params.arguments).length || invocations) {
        return { success: false, contentItems: [{ type: "inputText", text: "Only the read-only marker fixture may be called once." }] };
      }
      invocations++;
      return { success: true, contentItems: [{ type: "inputText", text: marker }] };
    });
    client.onNotification(event => {
      if (!("threadId" in event.params) || event.params.threadId !== threadId) return;
      if (event.method === "item/completed") {
        const item = event.params.item;
        if (item && typeof item === "object" && "type" in item && item.type === "agentMessage"
          && "text" in item && typeof item.text === "string") finalText = item.text;
      }
      if (event.method === "turn/failed") fail(new Error(`Portable discovery failed during ${failureStage}.`));
      if (event.method === "turn/completed" && event.params.threadId === threadId) {
        const turn = event.params.turn;
        if (!turn || typeof turn !== "object" || !("status" in turn) || turn.status !== "completed") fail(new Error("The portable discovery check did not complete."));
        else complete();
      }
    });
    const started = await client.startThread({
      model: `@${provider.id}/${model}`, cwd: home, ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
      config: { project_doc_max_bytes: 0, notify: [],
        features: { apps: false, plugins: false, goals: false, hooks: false, multi_agent: false,
          shell_tool: false, view_image: false, image_generation: false }, mcp_servers: {} },
      dynamicTools: [{ type: "namespace", name: "portable_probe", description: "Read-only compatibility fixture", tools: [{ type: "function", name: tool, deferLoading: true,
        description: "Read-only compatibility fixture: return a unique marker. Takes no arguments.",
        inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } }] }],
    });
    threadId = started.threadId;
    await client.startTurn({ threadId, model: `@${provider.id}/${model}`, approvalPolicy: "never", sandbox: "read-only",
      input: [{ type: "text", text: "Use Code Mode tool_search to discover the read-only marker fixture. Print the returned declaration, call the selected fixture once, then return only its exact output. Do not invent a marker." }] });
    await done;
    if (invocations !== 1 || finalText.trim() !== marker || requests < 3) throw new Error("Portable discovery did not finish search, one fixture invocation, and an exact marker reply.");
    return { requests, initialToolBytes, initialRequestBytes };
  } finally {
    clearTimeout(timer);
    try { await client?.close(); }
    finally {
      try { await runtime?.close(); }
      finally { await rm(home, { recursive: true, force: true }); }
    }
  }
}
