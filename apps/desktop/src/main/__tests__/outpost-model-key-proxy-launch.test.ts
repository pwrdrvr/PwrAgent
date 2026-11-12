import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// run-model-key-proxy.sh is what launchd, systemd and start-model-key-proxy.sh
// start. It must read the key from the named source at start, pass it only to
// the proxy, and refuse an env file that could leak or shadow it.
const SCRIPT = path.resolve(
  __dirname,
  "../agent-tools/skills/outpost-security-research/scripts/run-model-key-proxy.sh",
);
const PLACEHOLDER = "ph_launch0123456789";
const KEY = "key-from-the-secret-store";
const OP_REF = "op://vault/item/credential";
const KEYCHAIN_SERVICE = "outpost-model-test";

let dir = "";
let upstream: http.Server;
let upstreamOrigin = "";
const authorizations: (string | undefined)[] = [];

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "outpost-key-launch-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  // Fakes answer only the exact reference the env file names.
  const fakes: Record<string, string> = {
    op: `[ "$1" = read ] && [ "$2" = "${OP_REF}" ] && { echo "${KEY}"; exit 0; }\necho "op: no item" >&2; exit 1`,
    security: `[ "$1" = find-generic-password ] && [ "$3" = "$(id -un)" ] && [ "$5" = "${KEYCHAIN_SERVICE}" ] && [ "$6" = -w ] && { echo "${KEY}"; exit 0; }\necho "security: not found" >&2; exit 44`,
  };
  for (const [name, body] of Object.entries(fakes)) {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }
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

async function runWith(name: string, lines: string[], mode: number): Promise<Run> {
  const port = await freePort();
  const envFile = path.join(dir, `${name}.env`);
  writeFileSync(envFile, [
    `MODEL_PROXY_UPSTREAM=${upstreamOrigin}/v1`,
    `MODEL_PROXY_PLACEHOLDER=${PLACEHOLDER}`,
    `MODEL_PROXY_LISTEN=127.0.0.1:${port}`,
    ...lines,
    "",
  ].join("\n"));
  chmodSync(envFile, mode);
  const child = spawn("/bin/sh", [SCRIPT, envFile], {
    env: {
      PATH: [path.join(dir, "bin"), path.dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      HOME: dir,
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
  const status = await new Promise<number>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: `/${PLACEHOLDER}/v1/models`, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    }).on("error", reject);
  });
  child.kill("SIGTERM");
  return { exitCode: await exited, output, status };
}

describe.skipIf(process.platform === "win32")("run-model-key-proxy.sh", () => {
  it.each([
    { name: "op", lines: [`MODEL_PROXY_API_KEY_SOURCE=${OP_REF}`] },
    { name: "keychain", lines: [`MODEL_PROXY_API_KEY_SOURCE=keychain:${KEYCHAIN_SERVICE}`] },
    { name: "legacy", lines: [`MODEL_PROXY_API_KEY=${KEY}`] },
  ])("reads the key from $name at start and sends it only upstream", async ({ name, lines }) => {
    const before = authorizations.length;
    const run = await runWith(name, lines, 0o600);
    expect(run.status).toBe(200);
    expect(authorizations.slice(before)).toEqual([`Bearer ${KEY}`]);
    expect(run.output).not.toContain(KEY);
    expect(run.output).not.toContain(PLACEHOLDER);
  });

  it.each([
    { name: "readable", lines: [`MODEL_PROXY_API_KEY_SOURCE=${OP_REF}`], mode: 0o644, code: 1 },
    { name: "both", lines: [`MODEL_PROXY_API_KEY_SOURCE=${OP_REF}`, `MODEL_PROXY_API_KEY=${KEY}`], mode: 0o600, code: 1 },
    { name: "unknown", lines: ["MODEL_PROXY_API_KEY_SOURCE=file:/etc/key"], mode: 0o600, code: 2 },
    { name: "missing-op-item", lines: ["MODEL_PROXY_API_KEY_SOURCE=op://vault/other/credential"], mode: 0o600, code: 1 },
    { name: "missing-keychain-item", lines: ["MODEL_PROXY_API_KEY_SOURCE=keychain:other"], mode: 0o600, code: 44 },
  ])("refuses to start: $name", async ({ name, lines, mode, code }) => {
    const before = authorizations.length;
    const run = await runWith(name, lines, mode);
    expect(run.status).toBeUndefined();
    expect(run.exitCode).toBe(code);
    expect(authorizations).toHaveLength(before);
    expect(run.output).not.toContain(KEY);
  });
});
