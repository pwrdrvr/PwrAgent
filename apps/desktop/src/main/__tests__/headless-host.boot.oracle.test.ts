import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { expect, it, onTestFinished } from "vitest";
import { buildHeadless } from "../../../scripts/build-headless.mjs";
import { ensureNamedProfileExists } from "../profile";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";
import { StateDb } from "../state/state-db";
import { tagSecretEncryption } from "../settings/secret-encryption-envelope";

it("boots and shuts down the real Node owners while preserving desktop-encrypted federation keys", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "headless-host-boot-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputDirectory = path.join(root, "runtime");
  await buildHeadless({ outputDirectory, plugins: [{ name: "owned-codex-protocol", setup(builder) {
    builder.onResolve({ filter: /(?:^|\/)stdio-transport$/ }, () => ({ path: "fixture-codex", namespace: "owned-codex" }));
    builder.onLoad({ filter: /.*/, namespace: "owned-codex" }, () => ({
      contents: `export { OwnerConformanceCodexTransport as StdioJsonRpcTransport } from ${JSON.stringify(path.join(import.meta.dirname, "fixtures/owner-conformance-codex-transport.ts"))};`,
      loader: "ts", resolveDir: import.meta.dirname,
    }));
  } }] });
  // Reuse the repository's CLI guard in the child. Probe failures may be
  // caught by owners, so the recorded violations still fail process exit.
  const guard = path.join(root, "guard.cjs");
  await build({
    entryPoints: [path.join(import.meta.dirname, "setup/agent-cli-spawn-guard.ts")], outfile: guard,
    bundle: true, platform: "node", format: "cjs", logLevel: "silent",
    plugins: [{ name: "child-test-hooks", setup(builder) {
      builder.onResolve({ filter: /^vitest$/ }, () => ({ path: "hooks", namespace: "child-test" }));
      builder.onLoad({ filter: /.*/, namespace: "child-test" }, () => ({
        contents: `export const afterEach = () => {}; export const afterAll = fn => process.once("exit", () => { try { fn(); } catch (error) { console.error(error.message); process.exitCode = 1; } });`,
        loader: "js",
      }));
    } }],
  });
  const env = { ...process.env, PWRAGENT_HOME: path.join(root, "home"), PWRAGENT_PROFILE: "fixture", CLAUDE_CONFIG_DIR: path.join(root, "claude") };
  const profile = ensureNamedProfileExists("fixture", { env });
  const config = new DesktopConfigStore({ configPath: path.join(profile.profileDir, "config.toml") });
  config.recordProviderDiscovery("codex", { candidates: [], selectedCommand: process.execPath, selectedVersion: "0.159.2" });
  config.dispose();
  const dbPath = path.join(profile.profileDir, "state/state.db");
  const database = StateDb.open(dbPath);
  const desktop = tagSecretEncryption({ isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() }, "desktop-safe-storage");
  const ciphertext = desktop.encryptString("invented desktop-owned key material");
  for (const name of ["federationInstancePrivateKey", "federationNoiseStaticPrivateKey"] as const) database.setSecret(name, ciphertext);
  database.close();
  const driver = path.join(root, "driver.cjs");
  fs.writeFileSync(driver, `const app = require(${JSON.stringify(path.join(outputDirectory, "index.js"))});
    app.startHeadlessHost().then(async services => {
      process.once("message", () => { process.disconnect(); process.emit("SIGTERM", "SIGTERM"); });
      process.send({ ready: true, errors: await services.settings.readFederationKeyAccessErrors() });
    }).catch(error => { console.error(error.stack); process.exitCode = 1; });`);
  const child = fork(driver, [], { env, execArgv: ["--require", guard], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  onTestFinished(() => { child.kill(); });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
  const exited = once(child, "exit");
  const ready = await Promise.race([once(child, "message").then(([value]) => value), exited.then(([code]) => { throw new Error(`Node owner exited before ready (${code}): ${output}`); })]);
  expect(ready).toMatchObject({ ready: true, errors: [
    { name: "federationInstancePrivateKey", reason: expect.stringContaining("desktop OS keychain") },
    { name: "federationNoiseStaticPrivateKey", reason: expect.stringContaining("desktop OS keychain") },
  ] });
  child.send({ stop: true });
  expect((await exited)[0], output).toBe(0);
  const startupLog = fs.readFileSync(path.join(profile.profileDir, "logs/profile-fixture.main.log"), "utf8");
  expect(startupLog).toContain("Stored federation private key is unavailable in the headless host");
  expect(startupLog).toContain("desktop OS keychain");
  expect(startupLog).toContain("federationInstancePrivateKey");
  expect(startupLog).toContain("federationNoiseStaticPrivateKey");
  const reopened = StateDb.open(dbPath);
  try {
    expect(reopened.getSecret("federationInstancePrivateKey")).toEqual(ciphertext);
    expect(reopened.getSecret("federationNoiseStaticPrivateKey")).toEqual(ciphertext);
  } finally { reopened.close(); }
});
