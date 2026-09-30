import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { configureElectronE2eReleaseEnv } from "../../../e2e/fixtures/electron-app";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../../../e2e/fixtures/github-release-stubs.cjs", import.meta.url), "utf8");

function preload(enabled = true) {
  const nativeFetch = vi.fn<typeof fetch>(async () => new Response("local fixture"));
  const http = { request: vi.fn(), get: vi.fn() };
  const https = { request: vi.fn(), get: vi.fn() };
  const net = { request: vi.fn() };
  const nativeNetRequest = net.request;
  const nativeHttp = { ...http };
  const nativeHttps = { ...https };
  const context = {
    process: { type: "browser", env: { PWRAGENT_E2E: enabled ? "1" : "0" } },
    URL, Request, Response,
    fetch: nativeFetch,
    require: (name: string) => name === "node:http" ? http
      : name === "node:https" ? https
      : name === "electron" ? { net } : { syncBuiltinESMExports: vi.fn() },
  };
  runInNewContext(source, context);
  return { context, nativeFetch, nativeHttp, nativeHttps, net, nativeNetRequest };
}

describe("E2E GitHub release preload", () => {
  it("loads before application code and survives an inherited helper launch", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "release stubs "));
    try {
      // Fail closed even if the preload regresses: this test must never use
      // the real network while verifying process-start ordering.
      const trap = path.join(root, "native-trap.cjs");
      writeFileSync(trap, 'globalThis.fetch = () => { throw new Error("native fetch reached"); };');
      const env = { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(trap)}` } as Record<string, string>;
      configureElectronE2eReleaseEnv(env);
      const helper = `fetch("https://api.github.com/repos/pwrdrvr/PwrGit/releases/latest")
        .then(response => console.log(response.headers.get("x-pwragent-e2e")));`;
      const parent = `const { execFileSync } = require("node:child_process");
        ${helper}
        console.log(execFileSync(process.execPath, ["-e", ${JSON.stringify(helper)}], { encoding: "utf8" }).trim());`;
      const { stdout } = await promisify(execFile)(process.execPath, ["-e", parent], { env, timeout: 10_000 });
      expect(stdout.trim().split(/\r?\n/)).toEqual(["release-stub", "release-stub"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stubs every release consumer before it can reach native fetch", async () => {
    const { context, nativeFetch } = preload();
    for (const repository of ["pwrdrvr/PwrAgent", "pwrdrvr/PwrGit", "pwrdrvr/PwrSnap", "cloudflare/cloudflared", "pwrdrvr/codex", "xai-org/grok-code"]) {
      const base = `https://api.github.com/repos/${repository}/releases`;
      expect(await (await context.fetch(`${base}?per_page=30`)).json()).toEqual([]);
      for (const input of [new URL(`${base}/latest`), new Request(`${base}/tags/v1`)]) {
        const response = await context.fetch(input);
        expect(response.status).toBe(404);
        expect(response.headers.get("x-pwragent-e2e")).toBe("release-stub");
      }
    }
    expect(nativeFetch).not.toHaveBeenCalled();
  });

  it("blocks both Node HTTP APIs before a release request opens a socket", () => {
    const { context, nativeHttp, nativeHttps } = preload();
    for (const protocol of ["http", "https"]) {
      const transport = context.require(`node:${protocol}`) as typeof nativeHttp;
      for (const method of ["request", "get"] as const) {
        for (const input of [
          `${protocol}://api.github.com/repos/pwrdrvr/PwrAgent/releases/latest`,
          { hostname: "api.github.com", path: "/repos/pwrdrvr/PwrAgent/releases?per_page=30" },
        ]) {
          expect(() => (transport[method] as (...args: unknown[]) => unknown)(input)).toThrow("must be stubbed");
        }
      }
    }
    for (const native of [nativeHttp, nativeHttps]) {
      expect(native.request).not.toHaveBeenCalled();
      expect(native.get).not.toHaveBeenCalled();
    }
  });

  it("blocks electron-updater's Electron net transport", () => {
    const { net, nativeNetRequest } = preload();
    for (const input of [
      "https://api.github.com/repos/pwrdrvr/PwrAgent/releases",
      { url: "https://api.github.com/repos/pwrdrvr/PwrAgent/releases/latest" },
      { hostname: "api.github.com", path: "/repos/pwrdrvr/PwrAgent/releases/latest" },
    ]) {
      expect(() => (net.request as (...args: unknown[]) => unknown)(input)).toThrow("must be stubbed");
    }
    expect(nativeNetRequest).not.toHaveBeenCalled();
  });

  it("leaves unrelated traffic and non-E2E processes alone", async () => {
    const active = preload();
    await active.context.fetch("http://127.0.0.1:1234/fixture");
    await active.context.fetch("https://api.github.com/repos/pwrdrvr/PwrAgent/pulls");
    expect(active.nativeFetch).toHaveBeenCalledTimes(2);
    const inactive = preload(false);
    expect(inactive.context.fetch).toBe(inactive.nativeFetch);
  });
});
