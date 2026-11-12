import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The key-proxy container starts model-key-proxy.mjs with the key in a Compose
// secret file. The proxy must read the key from that file at start, send it
// only upstream, and refuse to start without exactly one usable key.
const SCRIPT = path.resolve(
  __dirname,
  "../agent-tools/skills/outpost-security-research/scripts/model-key-proxy.mjs",
);
const PLACEHOLDER = "ph_launch0123456789";
const KEY = "key-from-the-secret-file";

let dir = "";
let upstream: http.Server;
let upstreamOrigin = "";
const authorizations: (string | undefined)[] = [];

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "outpost-key-launch-"));
  writeFileSync(path.join(dir, "key"), `${KEY}\n`);
  writeFileSync(path.join(dir, "empty"), "\n");
  upstream = http.createServer((req, res) => {
    authorizations.push(req.headers.authorization);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  rmSync(dir, { force: true, recursive: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

type Run = { exitCode: number | null; output: string; status?: number };

async function runWith(keyEnv: Record<string, string>): Promise<Run> {
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT], {
    env: {
      MODEL_PROXY_UPSTREAM: `${upstreamOrigin}/v1`,
      MODEL_PROXY_PLACEHOLDER: PLACEHOLDER,
      MODEL_PROXY_LISTEN: `127.0.0.1:${port}`,
      ...keyEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const listening = new Promise<boolean>((resolve) => {
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("\"event\":\"listening\"")) resolve(true);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    void exited.then(() => resolve(false));
  });
  if (!(await listening)) return { exitCode: await exited, output };
  try {
    const status = await new Promise<number>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: `/${PLACEHOLDER}/v1/models`, agent: false }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      }).on("error", reject);
    });
    return { exitCode: null, output, status };
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
}

describe("model-key-proxy.mjs key at start", () => {
  it.each([
    { name: "a secret file", keyEnv: () => ({ MODEL_PROXY_API_KEY_FILE: path.join(dir, "key") }) },
    { name: "the environment", keyEnv: () => ({ MODEL_PROXY_API_KEY: KEY }) },
  ])("reads the key from $name and sends it only upstream", async ({ keyEnv }) => {
    const before = authorizations.length;
    const run = await runWith(keyEnv());
    expect(run.status).toBe(200);
    expect(authorizations.slice(before)).toEqual([`Bearer ${KEY}`]);
    expect(run.output).not.toContain(KEY);
    expect(run.output).not.toContain(PLACEHOLDER);
  });

  it.each([
    { name: "no key", keyEnv: () => ({}) },
    { name: "a missing file", keyEnv: () => ({ MODEL_PROXY_API_KEY_FILE: path.join(dir, "absent") }) },
    { name: "an empty file", keyEnv: () => ({ MODEL_PROXY_API_KEY_FILE: path.join(dir, "empty") }) },
    { name: "a file and a key", keyEnv: () => ({ MODEL_PROXY_API_KEY_FILE: path.join(dir, "key"), MODEL_PROXY_API_KEY: KEY }) },
  ])("refuses to start with $name", async ({ keyEnv }) => {
    const before = authorizations.length;
    const run = await runWith(keyEnv());
    expect(run.status).toBeUndefined();
    expect(run.exitCode).toBe(2);
    expect(authorizations).toHaveLength(before);
    expect(run.output).not.toContain(KEY);
  });
});
