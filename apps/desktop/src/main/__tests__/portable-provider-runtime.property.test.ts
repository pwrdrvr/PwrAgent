import { readFile, stat } from "node:fs/promises";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { type CodexModelProviderSettings, validateCodexModelProviders } from "@pwragent/shared";
import { desktopSettingsPatchToEdits, parseDesktopSettingsToml } from "../settings/desktop-config";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";
import { prepareProviderModelRuntime } from "../codex-app-server/provider-model-runtime";
import { preparePortableProviderRuntime } from "../codex-app-server/portable-provider-runtime";
import { portableThreadRequest } from "../codex-app-server/portable-code-mode-transport.mjs";
import { CodexModelProviderCatalog } from "../app-server/codex-model-provider-catalog";

const provider: CodexModelProviderSettings = {
  id: "flint", name: "Flint", baseUrl: "https://fixture.example/v1", models: ["fixture"], toolDiscovery: "portable",
};

it("round-trips portable selection and its verification independently of native support", () => {
  fc.assert(fc.property(fc.boolean(), fc.boolean(), (native, portable) => {
    const configured = { ...provider, modelMetadata: [{ id: "fixture", supportsSearchTool: native, supportsPortableDiscovery: portable }] };
    const text = '# Keep this comment\n[models.codex]\nprofile = "work"\n';
    const written = applyTomlEdits(text, desktopSettingsPatchToEdits({ models: { codex: { providers: [configured] } } }, parseTomlTables(text, "test")));
    expect(parseDesktopSettingsToml(written, "test").models?.codex?.providers).toEqual([configured]);
    expect(written).toContain("# Keep this comment");
    expect(written).toContain('profile = "work"');
    expect(validateCodexModelProviders([configured])).toEqual([configured]);
  }));
});

it("sets only the private adapter catalog's search capability and preserves native metadata", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async native => {
    const configured = { ...provider, modelMetadata: [{ id: "fixture", supportsSearchTool: native }] };
    const runtime = await prepareProviderModelRuntime(configured);
    const file = JSON.parse(runtime.overrides.find(value => value.startsWith("model_catalog_json="))!.slice("model_catalog_json=".length)) as string;
    try {
      expect(JSON.parse(await readFile(file, "utf8")).models[0]).toMatchObject({ tool_mode: "code_mode_only", supports_search_tool: true });
      expect(configured.modelMetadata[0].supportsSearchTool).toBe(native);
      expect(runtime.overrides.some(value => /mcp_servers|apps=false|plugins=false/.test(value))).toBe(false);
    } finally { await runtime.close(); }
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  }), { numRuns: 10 });
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
