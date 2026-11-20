import { readFile, stat } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import {
  type CodexModelProviderSettings,
  validateCodexModelProviders,
} from "@pwragent/shared/codex-model-providers";
import { desktopSettingsPatchToEdits, parseDesktopSettingsToml } from "../settings/desktop-config";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";
import { prepareProviderModelRuntime } from "../codex-app-server/provider-model-runtime";
import { preparePortableProviderRuntime } from "../codex-app-server/portable-provider-runtime";
import { portableThreadRequest } from "../codex-app-server/portable-code-mode-transport.mjs";
import { CodexModelProviderCatalog } from "../app-server/codex-model-provider-catalog";
import { normalizeConfigDomains } from "../settings/config-store/config-domains";

const provider: CodexModelProviderSettings = {
  id: "flint", name: "Flint", baseUrl: "https://fixture.example/v1", models: ["fixture"], toolDiscovery: "portable",
};

it("invalidates the launch in both discovery-mode directions without invalidating executable discovery", () => {
  fc.assert(fc.property(fc.boolean(), fc.boolean(), (native, verified) => {
    const configured = { ...provider, modelMetadata: [{ id: "fixture", supportsSearchTool: native, supportsPortableDiscovery: verified }] };
    const project = (entry: CodexModelProviderSettings) => normalizeConfigDomains({ config: { models: { codex: { providers: [entry] } } } }).providers;
    const portable = project(configured);
    const direct = project({ ...configured, toolDiscovery: undefined });
    expect(portable.codex.runtimeFingerprint).not.toBe(direct.codex.runtimeFingerprint);
    expect(portable.codex.dependencyFingerprint).toBe(direct.codex.dependencyFingerprint);
    expect(project({ ...configured, toolDiscovery: "portable" })).toEqual(portable);
    expect(portable.gemini).toEqual(direct.gemini);
  }));
});

it("forwards configured provider headers while rebuilding HTTP framing after translation", async () => {
  await fc.assert(fc.asyncProperty(fc.uuid(), fc.uuid(), async (project, token) => {
    const send = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({ status: "completed", output: [] }));
    });
    const runtime = await preparePortableProviderRuntime(provider, "fixture-key", { fetch: send });
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(`${runtime.baseUrl}/responses`, { method: "POST", headers: {
          Authorization: "Bearer fixture-key", "OpenAI-Project": project, "X-API-Key": token,
          "X-Account": "fixture-account", Connection: "x-local-only", "X-Local-Only": "private",
        } }, response => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
          response.on("error", reject);
        });
        request.on("error", reject);
        request.end(JSON.stringify({ tools: [{ type: "custom", name: "exec", format: { type: "grammar", syntax: "lark" } }] }));
      });
      expect(status).toBe(200);
      expect(send).toHaveBeenCalledOnce();
      const headers = new Headers(send.mock.calls[0][1]?.headers);
      expect(headers.get("openai-project")).toBe(project);
      expect(headers.get("x-api-key")).toBe(token);
      expect(headers.get("x-account")).toBe("fixture-account");
      expect(headers.get("authorization")).toBe("Bearer fixture-key");
      expect(headers.get("host")).toBeNull();
      expect(headers.get("connection")).toBeNull();
      expect(headers.get("x-local-only")).toBeNull();
      expect(headers.get("content-length")).toBeNull();
      expect(headers.get("content-type")).toBe("application/json");
    } finally { await runtime.close(); }
  }), { numRuns: 5 });
});

it("preserves header authentication and account selection through the real Responses and Bonsai forwarding paths", async () => {
  for (const compatibility of [undefined, "bonsai"] as const) for (const streaming of [false, true]) {
    const received: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
    const upstream = createServer(async (request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url !== "/v1/responses") {
        response.end(JSON.stringify(request.url === "/v1/models" ? { data: [{ id: "fixture" }] }
          : { model_alias: "fixture", modalities: { vision: false } }));
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      received.push({ headers: request.headers, body });
      const value = { status: "completed", output: [] };
      if (streaming) {
        response.setHeader("Content-Type", "text/event-stream");
        response.end(`data: ${JSON.stringify({ type: "response.completed", response: value })}\n\n`);
      } else response.end(JSON.stringify(value));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    let runtime: Awaited<ReturnType<typeof preparePortableProviderRuntime>> | undefined;
    try {
      runtime = await preparePortableProviderRuntime({ ...provider, compatibility, baseUrl: `http://127.0.0.1:${address.port}/v1` });
      const result = await fetch(`${runtime.baseUrl}/responses`, { method: "POST", headers: {
        Authorization: "Bearer configured-header", "X-API-Key": "fixture-header-key", "OpenAI-Project": "fixture-project",
      }, body: JSON.stringify({ stream: streaming, tools: [{ type: "custom", name: "exec", format: { type: "grammar", syntax: "lark" } }] }) });
      expect(result.status).toBe(200);
      expect(await result.text()).toContain("completed");
      expect(received).toHaveLength(1);
      expect(received[0].headers).toMatchObject({ authorization: "Bearer configured-header", "x-api-key": "fixture-header-key", "openai-project": "fixture-project" });
      expect(Number(received[0].headers["content-length"])).toBe(Buffer.byteLength(received[0].body));
      expect(received[0].headers.host).toBe(`127.0.0.1:${address.port}`);
    } finally {
      await runtime?.close();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  }
});

it("round-trips portable selection and its verification independently of native support", () => {
  fc.assert(fc.property(fc.boolean(), fc.boolean(), fc.integer({ min: 1024, max: 2_000_000 }), (native, portable, contextWindowCap) => {
    const configured = { ...provider, contextWindowCap, modelMetadata: [{ id: "fixture", supportsSearchTool: native, supportsPortableDiscovery: portable }] };
    const text = '# Keep this comment\n[models.codex]\nprofile = "work"\n';
    const written = applyTomlEdits(text, desktopSettingsPatchToEdits({ models: { codex: { providers: [configured] } } }, parseTomlTables(text, "test")));
    expect(parseDesktopSettingsToml(written, "test").models?.codex?.providers).toEqual([configured]);
    expect(written).toContain("# Keep this comment");
    expect(written).toContain('profile = "work"');
    expect(validateCodexModelProviders([configured])).toEqual([configured]);
  }));
});

it("preserves portable discovery and native metadata while applying provider context budgets", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.integer({ min: 1024, max: 2_000_000 }), fc.integer({ min: 1024, max: 2_000_000 }), async (native, contextWindow, contextWindowCap) => {
    const configured = { ...provider, contextWindowCap, modelMetadata: [{ id: "fixture", contextWindow, supportsSearchTool: native }] };
    const budget = Math.min(contextWindow, contextWindowCap);
    const runtime = await prepareProviderModelRuntime(configured);
    const file = JSON.parse(runtime.overrides.find(value => value.startsWith("model_catalog_json="))!.slice("model_catalog_json=".length)) as string;
    try {
      expect(JSON.parse(await readFile(file, "utf8")).models[0]).toMatchObject({
        tool_mode: "code_mode_only", supports_search_tool: true,
        context_window: budget, max_context_window: budget, auto_compact_token_limit: Math.floor(budget * 0.75),
      });
      expect(runtime.overrides).toContain(`model_context_window=${budget}`);
      expect(runtime.overrides).toContain(`model_auto_compact_token_limit=${Math.floor(budget * 0.75)}`);
      expect(configured.modelMetadata[0].supportsSearchTool).toBe(native);
      expect(configured.modelMetadata[0].contextWindow).toBe(contextWindow);
      expect(runtime.overrides.some(value => /mcp_servers|apps=false|plugins=false/.test(value))).toBe(false);
    } finally { await runtime.close(); }
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  }), { numRuns: 10, examples: [[false, 1048576, 32768], [true, 32768, 1048576]] });
});

it("retains whole-table request policy while supplying required Code Mode features on every admission path", () => {
  fc.assert(fc.property(fc.constantFrom("thread/start", "thread/resume", "thread/fork"), fc.boolean(), (method, apps) => {
    const config = { features: { apps, hooks: false }, mcp_servers: { private_fixture: { enabled: false } }, notify: [] };
    const request = { id: 17, method, params: { config, model: "fixture" } };
    const result = JSON.parse(portableThreadRequest(JSON.stringify(request)));
    expect(result).toEqual({ ...request, params: { ...request.params, config: { ...config,
      features: { ...config.features, code_mode: true, code_mode_only: true, code_mode_tool_search: true } } } });
  }));
  const configured = JSON.parse(portableThreadRequest(JSON.stringify({ method: "thread/start", params: {
    config: { features: { code_mode: { enabled: false, max_output_tokens_ceiling: 500 } } },
  } })));
  expect(configured.params.config.features.code_mode).toEqual({ enabled: true, max_output_tokens_ceiling: 500 });
});

it("uses the owner's scoped credential and Responses endpoint, then disposes the local transport", async () => {
  const send = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-key");
    expect(init?.redirect).toBe("error");
    const body = JSON.parse(init?.body as string);
    return new Response(JSON.stringify({ status: "completed", output: [{ type: "function_call", name: body.tools[0].name,
      call_id: "fixture-call", arguments: JSON.stringify({ code: "text(1);" }) }] }), { headers: { "Content-Type": "application/json" } });
  });
  const runtime = await preparePortableProviderRuntime(provider, "fixture-key", { fetch: send });
  try {
    expect(runtime.overrides.join(" ")).not.toContain("fixture-key");
    const denied = await fetch(`${runtime.baseUrl}/responses`, { method: "POST", body: "{}" });
    expect(denied.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
    const result = await fetch(`${runtime.baseUrl}/responses`, { method: "POST", headers: { Authorization: "Bearer fixture-key" }, body: JSON.stringify({ model: "fixture", tools: [{
      type: "custom", name: "exec", description: "Run Code Mode", format: { type: "grammar", syntax: "lark" },
    }] }) });
    expect(await result.json()).toMatchObject({ output: [{ type: "custom_tool_call", name: "exec", input: "text(1);", call_id: "fixture-call" }] });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toBe("https://fixture.example/v1/responses");
  } finally { await runtime.close(); }
  await expect(fetch(`${runtime.baseUrl}/responses`)).rejects.toThrow();
});

it("reports portable success independently when the native discovery route rejects tool_search", async () => {
  const verifyPortable = vi.fn(async () => ({ requests: 3 }));
  const catalog = new CodexModelProviderCatalog({ resolveProviders: () => [], resolveKeys: async () => ({}), verifyPortable,
    fetch: async (url, init) => {
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "fixture" }] }));
      const body = JSON.parse(init?.body as string);
      return body.tools[0].type === "tool_search"
        ? new Response("unsupported tool_search", { status: 404 })
        : new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] }));
    },
  });
  expect(await catalog.test(provider, "fixture-key")).toMatchObject({
    responses: { ok: true }, discovery: { ok: false }, portableDiscovery: { ok: true, model: "fixture", requests: 3 },
  });
  expect(verifyPortable).toHaveBeenCalledWith(expect.objectContaining({ toolDiscovery: "portable", models: ["fixture"] }), "fixture-key");
});

it("refuses eager third-party catalogs and an oversized core bootstrap before contacting the provider", async () => {
  const send = vi.fn<typeof fetch>();
  const runtime = await preparePortableProviderRuntime(provider, undefined, { fetch: send });
  try {
    const exec = { type: "custom", name: "exec", description: "Run Code Mode", format: { type: "grammar", syntax: "lark" } };
    for (const tools of [[exec, { type: "namespace", name: "mcp__private", tools: [{ type: "function", name: "read" }] }],
      [{ ...exec, description: "x".repeat(32 * 1024) }]]) {
      const result = await fetch(`${runtime.baseUrl}/responses`, { method: "POST", body: JSON.stringify({ tools }) });
      expect(result.status).toBe(400);
    }
    expect(send).not.toHaveBeenCalled();
  } finally { await runtime.close(); }
});
