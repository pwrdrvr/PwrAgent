import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForgeCiClient } from "../pr-status/forge-ci-client";
import { ForgeReadService } from "../pr-status/forge-read-service";
import { FORGE_ARTIFACT_MAX_BYTES } from "../pr-status/forge-read-limits";
import { buildForgeReadToolDefinitions } from "../agent-tools/pwragent-forge-agent-tools";
import { resolveAgentToolCatalogs } from "../agent-tools/agent-tool-catalog-registry";
import { searchPwrAgentTools } from "../agent-tools/pwragent-tool-search";
import type { ForgeRepository } from "../pr-status/forge-tool-contract";
import { resetCachedActiveProfileNameForTests } from "../profile";

// Keep the same boundary tests small enough to exercise the streamed limit on disk.
vi.mock("../pr-status/forge-read-limits", async (original) => ({
  ...await original<typeof import("../pr-status/forge-read-limits")>(),
  FORGE_ARTIFACT_MAX_BYTES: 64,
}));

const repository: ForgeRepository = { provider: "github", host: "github.com", owner: "fixture", repo: "project" };
const context = { backend: "codex" as const, threadId: "fixture", transport: "mcp" as const };
const metadata = { id: 12, name: "../../outside", size_in_bytes: 22, expired: false, workflow_run: { id: 9 } };
const zip = Buffer.from("504b0506000000000000000000000000000000000000", "hex");
const signedUrl = "https://artifacts.example.test/archive.zip?signature=fixture-secret";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
type Download = { archivePath: string; sha256: string; sizeBytes: number };

describe("CI artifact downloads", () => {
  let directory: string;
  let root: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "pwragent-ci-artifact-test-"));
    root = path.join(directory, "artifacts");
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
    resetCachedActiveProfileNameForTests();
  });

  function fixture(options: { response?: () => Response; data?: unknown; enabled?: () => boolean; takeToken?: () => boolean } = {}) {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).endsWith("/artifacts/12") ? json(options.data ?? metadata)
      : String(url).endsWith("/zip") ? new Response(null, { status: 302, headers: { location: signedUrl } })
        : options.response?.() ?? new Response(zip));
    const githubToken = vi.fn(async (_host: string) => "fixture-token");
    const ci = new ForgeCiClient({ fetch: fetcher, githubToken, gitlab: { readApi: vi.fn() },
      enabled: options.enabled ?? (() => true), takeToken: options.takeToken ?? (() => true), artifactRoot: () => root,
    });
    const service = new ForgeReadService({ enabled: options.enabled ?? (() => true), ci, refresh: vi.fn() });
    const scope = { remotes: [repository], attached: [], observations: [] };
    return { fetcher, githubToken, ci, service, scope, download: (signal?: AbortSignal) => service.execute("download_ci_artifact", { runId: 9, artifactId: 12 }, scope, signal) as Promise<Download> };
  }

  it.each(["download CI artifact", "GitHub workflow archive download", "Playwright trace artifacts"])("discovers %s", (query) => {
    const found = searchPwrAgentTools(resolveAgentToolCatalogs({}).flatMap((c) => c.dynamicTools), query);
    expect(found.find((tool) => tool.name === "download_ci_artifact")?.inputSchema).toMatchObject({ required: ["runId", "artifactId"], additionalProperties: false });
  });

  it.each(["mcp", "native"])("downloads through %s dispatch with scoped authentication and no signed URL disclosure", async (transport) => {
    const h = fixture();
    const catalog = resolveAgentToolCatalogs({ forgeReadHandler: (operation, args) => h.service.execute(operation, args, h.scope) }).find((c) => c.id === "forge")!;
    const args = { runId: 9, artifactId: 12 };
    const result = transport === "mcp"
      ? await catalog.router.handleMcpToolCall({ backend: "acp:fixture", threadId: "fixture", tool: "download_ci_artifact", args })
      : await catalog.router.handleDynamicToolCall({ backend: "codex", call: { namespace: "pwragent", tool: "download_ci_artifact", arguments: args, threadId: "fixture", turnId: "turn", callId: "call" } });
    const payload = "contentItems" in result ? JSON.parse(result.contentItems.find((item) => item.type === "inputText")!.text) : result.structuredContent;
    expect(payload).toMatchObject({ runId: 9, artifactId: 12, providerRequests: 2, sizeBytes: zip.length, sha256: createHash("sha256").update(zip).digest("hex"), format: "zip", extracted: false, pathOwner: "thread_owner", trust: "untrusted" });
    expect(await readFile(payload.archivePath)).toEqual(zip);
    expect(path.dirname(path.dirname(payload.archivePath))).toBe(root);
    expect(await readdir(path.dirname(payload.archivePath))).toEqual(["artifact.zip"]);
    expect(await readdir(directory)).toEqual(["artifacts"]);
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(h.fetcher.mock.calls[0]![1]?.headers).toMatchObject({ Authorization: "Bearer fixture-token" });
    expect(h.fetcher.mock.calls[2]![1]).toMatchObject({ redirect: "error" });
    expect(h.fetcher.mock.calls[2]![1]).not.toHaveProperty("headers");
    if (process.platform !== "win32") expect((await stat(payload.archivePath)).mode & 0o777).toBe(0o600);
  });

  it("does not overwrite an earlier download or use an artifact name as a path", async () => {
    const h = fixture();
    const first = await h.download();
    const second = await h.download();
    expect(first.archivePath).not.toBe(second.archivePath);
    expect(await readFile(first.archivePath)).toEqual(zip);
    expect(await readFile(second.archivePath)).toEqual(zip);
    expect(await readdir(root)).toHaveLength(2);
  });

  it("uses the Enterprise API root and host-specific authentication", async () => {
    const h = fixture();
    const r = { ...repository, host: "ghe.example.test" };
    await h.service.execute("download_ci_artifact", { runId: 9, artifactId: 12, repository: r }, { ...h.scope, remotes: [r] });
    expect(h.fetcher.mock.calls.slice(0, 2).map(([url]) => String(url))).toEqual([
      "https://ghe.example.test/api/v3/repos/fixture/project/actions/artifacts/12",
      "https://ghe.example.test/api/v3/repos/fixture/project/actions/artifacts/12/zip",
    ]);
    expect(h.githubToken).toHaveBeenCalledWith("ghe.example.test");
  });

  it("stores downloads in the selected PwrAgent home and profile", async () => {
    vi.stubEnv("PWRAGENT_HOME", directory);
    vi.stubEnv("PWRAGENT_PROFILE", "artifact-fixture");
    resetCachedActiveProfileNameForTests();
    const h = fixture();
    const ci = new ForgeCiClient({ fetch: h.fetcher, githubToken: h.githubToken, gitlab: { readApi: vi.fn() }, enabled: () => true, takeToken: () => true });
    const result = await ci.execute("download_ci_artifact", repository, { runId: 9, artifactId: 12 }) as Download;
    expect(path.dirname(path.dirname(result.archivePath))).toBe(path.join(directory, "profiles", "artifact-fixture", "artifacts", "ci"));
    expect(await readFile(result.archivePath)).toEqual(zip);
  });

  it.each([
    [{ ...metadata, id: 13 }, "invalid_response"],
    [{ ...metadata, workflow_run: { id: 10 } }, "invalid_response"],
    [{ ...metadata, workflow_run: null }, "invalid_response"],
    [{ ...metadata, expired: true }, "artifact_expired"],
    [{ ...metadata, size_in_bytes: FORGE_ARTIFACT_MAX_BYTES + 1 }, "response_too_large"],
  ])("rejects invalid, expired or oversized metadata before downloading", async (data, code) => {
    const h = fixture({ data });
    await expect(h.download()).rejects.toMatchObject({ code });
    expect(h.fetcher).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(["http://artifacts.example.test/file", "https://user:password@artifacts.example.test/file", "bad location"])("refuses unsafe redirect %s", async (location) => {
    const h = fixture();
    h.fetcher.mockImplementationOnce(async () => json(metadata)).mockImplementationOnce(async () => new Response(null, { status: 302, headers: { location } }));
    await expect(h.download()).rejects.toMatchObject({ code: "invalid_response" });
    expect(h.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 404, 410, 429])("returns a safe error for HTTP %s without a partial file", async (status) => {
    const h = fixture({ response: () => json({ message: signedUrl }, status) });
    await expect(h.download()).rejects.toMatchObject({ code: status === 401 ? "unauthenticated" : status === 403 ? "forbidden" : status === 404 ? "not_found" : status === 410 ? "artifact_expired" : "rate_limited", message: expect.not.stringContaining("fixture-secret") });
    expect(await readdir(directory)).toEqual([]);
  });

  it("enforces advertised and actual streamed sizes without publishing partial archives", async () => {
    const cancelled = vi.fn();
    const advertised = fixture({ response: () => new Response(new ReadableStream({ cancel: cancelled }), { headers: { "content-length": String(FORGE_ARTIFACT_MAX_BYTES + 1) } }) });
    await expect(advertised.download()).rejects.toMatchObject({ code: "response_too_large" });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(await readdir(directory)).toEqual([]);
    const streamed = fixture({ response: () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(zip);
      controller.enqueue(new Uint8Array(FORGE_ARTIFACT_MAX_BYTES));
      controller.close();
    } })) });
    await expect(streamed.download()).rejects.toMatchObject({ code: "response_too_large" });
    expect(await readdir(root)).toEqual([]);
  });

  it.each(["not a zip", "", "PK"])("removes invalid ZIP response %j", async (body) => {
    const h = fixture({ response: () => new Response(body) });
    await expect(h.download()).rejects.toMatchObject({ code: "invalid_response" });
    expect(await readdir(root)).toEqual([]);
  });

  it("cancels a blocked stream and removes its partial archive", async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();
    let pulls = 0;
    const h = fixture({ response: () => new Response(new ReadableStream({ pull(stream) {
      if (pulls++ === 0) stream.enqueue(zip.subarray(0, 2));
      else controller.abort();
    }, cancel: cancelled })) });
    await expect(h.download(controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(cancelled).toHaveBeenCalled();
    expect(await readdir(root).catch(() => [])).toEqual([]);
  });

  it("cleans up when a stream fails and reports disk errors without transport secrets", async () => {
    const h = fixture({ response: () => new Response(new ReadableStream({ start(stream) { stream.error(new Error(signedUrl)); } })) });
    await expect(h.download()).rejects.toMatchObject({ code: "download_failed", message: expect.not.stringContaining("fixture-secret") });
    expect(await readdir(root)).toEqual([]);
    await rm(root, { recursive: true });
    await writeFile(root, "existing file");
    const disk = fixture();
    await expect(disk.download()).rejects.toMatchObject({ code: "download_failed" });
    expect(await readFile(root, "utf8")).toBe("existing file");
  });

  it("rechecks provider enablement and shares request admission", async () => {
    let enabled = true;
    let remaining = 1;
    const h = fixture({ enabled: () => enabled, takeToken: () => remaining-- > 0 });
    await expect(h.download()).rejects.toMatchObject({ code: "rate_limited" });
    expect(h.fetcher).toHaveBeenCalledOnce();
    enabled = false;
    await expect(h.download()).rejects.toMatchObject({ code: "provider_disabled" });
    expect(h.fetcher).toHaveBeenCalledOnce();
  });

  it("stops before following the signed redirect when GitHub is disabled", async () => {
    let enabled = true;
    const h = fixture({ enabled: () => enabled });
    h.fetcher.mockImplementationOnce(async () => json(metadata)).mockImplementationOnce(async () => {
      enabled = false;
      return new Response(null, { status: 302, headers: { location: signedUrl } });
    });
    await expect(h.download()).rejects.toMatchObject({ code: "provider_disabled" });
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect(await readdir(directory)).toEqual([]);
  });

  it("fails a missing GitHub login before fetching or writing files", async () => {
    const h = fixture();
    const ci = new ForgeCiClient({ fetch: h.fetcher, githubToken: async () => null, gitlab: { readApi: vi.fn() }, enabled: () => true, takeToken: () => true, artifactRoot: () => root });
    await expect(ci.execute("download_ci_artifact", repository, { runId: 9, artifactId: 12 })).rejects.toMatchObject({ code: "unauthenticated" });
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it("does not download from an unrelated repository or GitLab", async () => {
    const h = fixture();
    await expect(h.service.execute("download_ci_artifact", { runId: 9, artifactId: 12, repository: { ...repository, repo: "unlinked" } }, h.scope)).rejects.toMatchObject({ code: "forbidden" });
    const gitlab = { ...repository, provider: "gitlab" as const, host: "gitlab.com" };
    await expect(h.service.execute("download_ci_artifact", { runId: 9, artifactId: 12 }, { ...h.scope, remotes: [gitlab] })).rejects.toMatchObject({ code: "unsupported_provider" });
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it.each([{}, { runId: 9 }, { runId: 9, artifactId: -1 }, { runId: 9, artifactId: 1.5 }, { runId: 9, artifactId: 12, destination: "../outside" }, { runId: 9, artifactId: 12, url: signedUrl }])("rejects malformed identities and destination injection", async (args) => {
    const handler = vi.fn();
    const tool = buildForgeReadToolDefinitions(handler).find((definition) => definition.name === "download_ci_artifact")!;
    expect(await tool.dispatch(args, context)).toMatchObject({ ok: false, code: "invalid_arguments" });
    expect(handler).not.toHaveBeenCalled();
  });
});
