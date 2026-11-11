import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import { buildOwnerFixture } from "./helpers/built-owner-fixture";

async function openOwner(root: string, kind: "desktop" | "headless") {
  const directory = path.join(root, `bundle-${kind}`);
  const guard = await buildOwnerFixture(directory, kind);
  const driver = path.join(directory, "driver.cjs");
  fs.writeFileSync(driver, `const app = require("./dist/index.js");
    (async () => {
      await app.prepareOutpostProfile("t", process.execPath);
      const services = await app.startHeadlessHost(undefined, { manageSignals: false });
      process.on("message", async request => {
        if (request.method === "stop") { await app.shutdownHeadlessHost("profile-oracle"); process.disconnect(); return; }
        try { const target = typeof services.registry[request.method] === "function" ? services.registry : services.service; process.send({ id: request.id, result: await target[request.method](request.params) }); }
        catch(error) { process.send({ id: request.id, error: error.message }); }
      });
      process.send({ ready: true });
    })().catch(error => { console.error(error.stack); process.exitCode = 1; process.disconnect(); });`);
  const child = fork(driver, [], { cwd: path.join(root, "workspace"),
    env: { ...process.env, PWRAGENT_HOME: root, PWRAGENT_PROFILE: "t", PWRAGENT_CODEX_COMMAND: process.execPath,
      PWRAGENT_TEST_DATA: path.join(root, "fixture"), CLAUDE_CONFIG_DIR: path.join(root, "claude") },
    execArgv: ["--require", guard], stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout?.on("data", chunk => { output += String(chunk); });
  child.stderr?.on("data", chunk => { output += String(chunk); });
  const exited = once(child, "exit");
  await Promise.race([once(child, "message"), exited.then(([code]) => { throw new Error(`Owner exited ${code}: ${output.slice(-3000)}`); })]);
  let sequence = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  child.on("message", raw => {
    const message = raw as { id: number; result?: unknown; error?: string };
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request?.reject(new Error(message.error)); else request?.resolve(message.result);
  });
  return {
    call: <T>(method: string, params: unknown): Promise<T> => new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve: value => resolve(value as T), reject });
      child.send({ id, method, params });
    }),
    close: async () => { child.send({ method: "stop" }); const [code] = await exited; expect(code, output.slice(-3000)).toBe(0); },
  };
}

it("fresh desktop and Node roots preserve one profile's native identities, titles and canonical metadata", async () => {
  await fc.assert(fc.asyncProperty(fc.stringMatching(/^[A-Z][a-z]{0,8}$/), async suffix => {
    const root = fs.realpathSync(fs.mkdtempSync("/tmp/pa-profile-oracle-"));
    for (const name of ["workspace", "fixture"]) fs.mkdirSync(path.join(root, name));
    let host: Awaited<ReturnType<typeof openOwner>> | undefined;
    type Ref = { backend: "codex"; threadId: string };
    try {
      host = await openOwner(root, "desktop");
      const parent = await host.call<Ref>("startThread", { backend: "codex", cwd: path.join(root, "workspace") });
      const child = await host.call<Ref>("startThread", { backend: "codex", cwd: path.join(root, "workspace") });
      await host.call("renameThread", { ...parent, name: `Parent ${suffix}` });
      await host.call("renameThread", { ...child, name: `Desktop ${suffix}` });
      await host.call("setThreadPin", { ...parent, pinnedRank: "8192" });
      await host.call("setThreadParent", { ...child, parentThreadId: parent.threadId, parentThreadBackend: "codex" });
      await host.close(); host = undefined;
      for (const [kind, title] of [["headless", `Desktop ${suffix}`], ["desktop", `Outpost ${suffix}`], ["headless", `Desktop again ${suffix}`]] as const) {
        host = await openOwner(root, kind);
        await host.call("readThread", child);
        // The provider's completed inventory walk is the ownership boundary;
        // startup's retained snapshot can precede a native observation.
        await host.call("listThreads", { backend: "codex", forceRefresh: true, enrichDirectories: false });
        const read = await host.call<{ thread: { title: string; titleSource: string; parentThreadId?: string } }>("getNavigationSelectedDetail", { protocol: 2, ref: child });
        expect(read.thread).toMatchObject({ title, titleSource: "explicit", parentThreadId: parent.threadId });
        expect((await host.call<{ thread: unknown }>("getNavigationSelectedDetail", { protocol: 2, ref: parent })).thread).toMatchObject({ title: `Parent ${suffix}`, pinnedRank: "8192" });
        const next = kind === "headless" ? `Outpost ${suffix}` : `Desktop again ${suffix}`;
        await host.call("renameThread", { ...child, name: next, expectedName: title });
        const provider = JSON.parse(fs.readFileSync(path.join(root, "fixture/fixture-threads.json"), "utf8"));
        expect(provider[child.threadId].name).toBe(next);
        expect((await host.call<{ thread: unknown }>("getNavigationSelectedDetail", { protocol: 2, ref: child })).thread).toMatchObject({ title: next });
        await host.close(); host = undefined;
      }
    } finally { await host?.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }), { numRuns: 3 });
}, 120_000);
