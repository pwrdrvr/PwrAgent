import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "@pwragent/sqlite-storage/sqlite-write-metrics";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);

it.runIf(process.platform === "linux" || process.platform === "darwin")("budgets actual shared Outpost steering and durable interruption boundaries", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const [{ JobStore }, { Runtime }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("runtime.js"), load("federation-backend.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-control-writes-")));
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  try {
    const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
    const runtime = new Runtime({ store, workspace: root, home: path.join(root, "codex"), command: "unused", onFailure() {} });
    const backend = new HeadlessBackend(runtime, () => {});
    runtime.onEvent = (event: unknown) => backend.event(event);
    backend.authenticateOrigin = (origin: unknown) => origin;
    let sends = 0;
    let interruptions = 0;
    runtime.codex = {
      steerTurn: async () => { sends++; return { threadId: "native", turnId: "turn" }; },
      interruptTurn: async () => { interruptions++; return {}; },
    };
    const seed = () => {
      runtime.save({ version: 1, id: "job", fingerprint: "accepted", threadId: "native", turnId: "turn", status: "running", createdAt: new Date().toISOString() });
      runtime.active = "job";
    };
    const budget = async (scenario: string, note: string, work: () => unknown) => {
      const { writes } = await measureSqliteWrites(work);
      expectSqliteWriteBudget({ budgetFile: "outpost-turn-control-write-budgets.json", scenario, note, writes });
    };
    seed();
    const request = { backend: "codex", threadId: "native", expectedTurnId: "turn", requestId: "ordinary", input: [{ type: "text", text: "steer" }] };
    await budget("ordinary-steer", "Actual ordinary steering; no origin or persistence, zero commits", () => backend.handle("steerTurn", request));
    const attributed = { ...request, requestId: "attributed", messageOrigin: { kind: "agent", systemReason: "first" } };
    await budget("accepted-origin", "One accepted native steer's causal origin boundary; setup and native turn creation excluded", () => backend.handle("steerTurn", attributed));
    await budget("accepted-duplicate-reads", "1000 accepted retries and owner reads; no native replay or writes", async () => {
      for (let i = 0; i < 1000; i++) { await backend.handle("steerTurn", attributed); store.get("job"); }
    });
    expect(sends).toBe(2);
    const save = store.save.bind(store);
    let refuse = true;
    store.save = (job: any) => { if (refuse) { refuse = false; throw new Error("origin refused"); } return save(job); };
    const retry = { ...attributed, requestId: "retry", messageOrigin: { kind: "agent", systemReason: "second" } };
    await budget("origin-write-refusal", "Refused host retention after native acceptance; no durable write and no provider replay", async () => {
      await expect(backend.handle("steerTurn", retry)).rejects.toThrow("origin refused");
    });
    store.save = save;
    await budget("origin-completion-retry", "Retry only the refused origin boundary after native acceptance", () => backend.handle("steerTurn", retry));
    expect(sends).toBe(3);
    await budget("accepted-interrupt", "Existing durable interrupting transition before native RPC, no retirement before terminal", () => runtime.handle("interrupt", { id: "job" }));
    await budget("duplicate-interrupt", "1000 repeated interrupts while confirmed interrupt is pending; no native replay or writes", async () => {
      for (let i = 0; i < 1000; i++) await runtime.handle("interrupt", { id: "job" });
    });
    expect(interruptions).toBe(1);
    seed();
    runtime.codex.interruptTurn = async () => { throw new Error("native refusal"); };
    await budget("refused-interrupt", "Existing interrupting and restoration boundaries after provider refusal", async () => {
      await expect(runtime.handle("interrupt", { id: "job" })).rejects.toThrow("native refusal");
    });
    seed();
    runtime.codex.interruptTurn = async () => {
      runtime.notification({ method: "turn/completed", params: { threadId: "native", turn: { id: "turn", status: "completed" } } });
      throw new Error("late refusal");
    };
    await budget("terminal-during-interrupt", "Interrupting plus confirmed provider terminal; late refusal makes no restoration write", async () => {
      await expect(runtime.handle("interrupt", { id: "job" })).rejects.toThrow("late refusal");
    });
    expect(store.get("job").status).toBe("completed");
  } finally { profile.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
});
