import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { buildCodexClientArgs } from "../src/main/app-server/codex-thread-config";
import * as ownerPolicy from "../src/main/owner-runtime-policy";

// Standalone OS oracle, intentionally outside Vitest's real-agent spawn guard.
// Only generated canaries are used. No model calls or operator state reads.
async function probe(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "outpost-isolation-"));
  const workspace = path.join(root, "workspace");
  const state = path.join(root, "owner");
  const home = path.join(root, "codex");
  for (const directory of [workspace, state, home]) await mkdir(directory);
  const secrets = ["headless-secret.key", "identity.json", "settings-secrets.json"].map(name => path.join(state, name));
  secrets.push(path.join(home, "auth.json"));
  for (const file of secrets) await writeFile(file, file.endsWith("auth.json") ? '{"OPENAI_API_KEY":"oracle-canary"}' : "oracle-canary");
  // A second, root-owned login fixture models the live read-only auth mount.
  const mountedAuth = process.argv[3];
  if (mountedAuth) {
    assert.equal(await readFile(mountedAuth, "utf8"), '{"OPENAI_API_KEY":"oracle-canary"}');
    secrets.push(mountedAuth);
  }
  const configs = [path.join(state, "config.toml"), path.join(state, "state.db"), path.join(home, "config.toml")];
  for (const file of configs) await writeFile(file, "");
  await symlink(state, path.join(workspace, "owner-link"));
  const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, PWRAGENT_HOME: state,
    PWRAGENT_CODEX_HOME: home, OPENAI_API_KEY: "oracle-canary", CUSTOM_PROVIDER_CREDENTIAL: "oracle-canary" };
  const policy = ownerPolicy.createOutpostRuntimePolicy(env);
  const child = spawn(process.argv[2] ?? "codex", [...buildCodexClientArgs(env, [], [], policy), "app-server"], {
    cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"],
  });
  let id = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
  readline.createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  child.on("error", error => { for (const request of pending.values()) request.reject(error); });
  child.on("exit", code => { for (const request of pending.values()) request.reject(new Error(`Codex exited ${code}: ${stderr}`)); });
  const request = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    child.stdin.write(JSON.stringify({ id: requestId, method, params }) + "\n");
  });
  try {
    await request("initialize", { clientInfo: { name: "outpost-isolation-oracle", version: "1" }, capabilities: { experimentalApi: true } });
    child.stdin.write('{"method":"initialized"}\n');
    const failures: string[] = [];
    for (const mode of ["read-only", "workspace-write"] as const) {
      const sandboxPolicy = mode === "read-only"
        ? { type: "readOnly", networkAccess: false }
        : { type: "workspaceWrite", writableRoots: [workspace], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
      const attempts = [...secrets, path.join(workspace, "owner-link", "headless-secret.key"), `/proc/${child.pid}/environ`];
      const program = `const fs=require("node:fs"); const result={};
        for(const file of ${JSON.stringify(attempts)}) { try { fs.readFileSync(file); result["read:"+file]=true; } catch { result["read:"+file]=false; } }
        for(const file of ${JSON.stringify(configs)}) { try { fs.appendFileSync(file,"# modified\\n"); result["write:"+file]=true; } catch { result["write:"+file]=false; } }
        result.environment=Object.values(process.env).some(value=>value.includes("oracle-canary"));
        const ps=require("node:child_process").spawnSync("/bin/ps",["eww","-p",${JSON.stringify(String(child.pid))}],{encoding:"utf8"});
        result.processEnvironment=Boolean(ps.stdout?.includes("oracle-canary"));
        result.workspaceRead=fs.readFileSync(${JSON.stringify(path.join(workspace, "source"))},"utf8")==="source";
        try { fs.writeFileSync(${JSON.stringify(path.join(workspace, "output"))},"output"); result.workspaceWrite=true; } catch { result.workspaceWrite=false; }
        console.log(JSON.stringify(result));`;
      await writeFile(path.join(workspace, "source"), "source");
      let params: unknown = { command: [process.execPath, "-e", program], cwd: workspace, sandboxPolicy };
      params = ownerPolicy.applyOwnerCodexExecutionPolicy(policy, "command/exec", params);
      const result = await request("command/exec", params) as { exitCode: number; stdout: string; stderr: string };
      assert.equal(result.exitCode, 0, result.stderr);
      const observations = JSON.parse(result.stdout) as Record<string, boolean>;
      for (const [attempt, succeeded] of Object.entries(observations)) {
        const expected = attempt === "workspaceRead" || (attempt === "workspaceWrite" && mode === "workspace-write");
        if (succeeded !== expected) failures.push(`${mode}: ${attempt} expected ${expected}, got ${succeeded}`);
      }
      console.log(JSON.stringify({ mode, observations }));
    }
    assert.deepEqual(failures, [], "Locked-down commands must not read owner/provider credentials or write owner/Codex configuration");
  } finally {
    child.stdin.end();
    child.kill();
    await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", () => resolve()); });
    await rm(root, { recursive: true, force: true });
  }
}
void probe().catch(error => { console.error(error); process.exitCode = 1; });
