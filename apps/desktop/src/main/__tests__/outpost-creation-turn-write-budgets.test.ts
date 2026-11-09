import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "@pwragent/sqlite-storage/sqlite-write-metrics";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
const budgetFile = "outpost-creation-turn-write-budgets.json";

// This budget measures the Linux/macOS executable Runtime, not a portable host.
it.skipIf(process.platform === "win32")("budgets shared actual native creation and accepted turn boundaries including observer and confirmation refusals", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const [{ JobStore }, { Runtime }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("runtime.js"), load("federation-backend.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-lifecycle-writes-")));
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  try {
    const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
    const runtime = new Runtime({ store, workspace: root, home: path.join(root, "codex"), command: "unused", onFailure() {} });
    const backend = new HeadlessBackend(runtime, () => {});
    // A continued job already has its thread ID at acceptance. Its repeated
    // confirmation's timestamp must not depend on millisecond test timing.
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    let thread = "federated";
    let turns = 0;
    runtime.codex = {
      startThread: async () => ({ threadId: thread }),
      startTurn: async () => {
        turns++;
        runtime.notification({ method: "turn/completed", params: { threadId: thread, turn: { id: `turn-${turns}`, status: "completed" } } });
        return { threadId: thread, turnId: `turn-${turns}` };
      },
    };
    runtime.onEvent = (event: unknown) => { backend.event(event); throw new Error("Observer refused"); };
    const creation = await measureSqliteWrites(() => backend.handle("startThread"));
    expectSqliteWriteBudget({ budgetFile, scenario: "native-creation", note: "Actual federation creation through the shared coordinator; existing metadata confirmation commit, setup excluded", writes: creation.writes });
    const input = { id: "continued", threadId: thread, prompt: "Inspect the lifecycle" };
    const continued = await measureSqliteWrites(async () => { runtime.submit(input); await runtime.work; });
    expectSqliteWriteBudget({ budgetFile, scenario: "accepted-existing-thread", note: "Durable acceptance/thread/turn/terminal plus prompt fallback; observer refusals add no writes or replay", writes: continued.writes });
    expect(store.get(input.id)).toMatchObject({ turnId: "turn-1", status: "completed" });
    thread = "job-created";
    const created = await measureSqliteWrites(async () => { runtime.submit({ id: "created", prompt: "Inspect new creation" }); await runtime.work; });
    expectSqliteWriteBudget({ budgetFile, scenario: "accepted-new-thread", note: "Actual job-created native thread/turn via both shared coordinators; inherited six boundary commits, no timer", writes: created.writes });
    const save = store.save.bind(store);
    store.save = (job: { status: string }) => { if (job.status === "running") throw new Error("Confirmed turn write refused"); return save(job); };
    thread = "refused-confirmation";
    const refused = await measureSqliteWrites(async () => { runtime.submit({ id: "refused", prompt: "Accepted input" }); await runtime.work; });
    expect(store.get("refused")).toMatchObject({ threadId: thread, turnId: "turn-3", status: "unknown" });
    expectSqliteWriteBudget({ budgetFile, scenario: "confirmed-write-refusal", note: "One refused turn confirmation; existing unknown terminal boundary preserves provider IDs without another provider submission", writes: refused.writes });
    const passive = await measureSqliteWrites(() => {
      for (let i = 0; i < 1000; i++) { runtime.submit(input); store.get("created"); backend.threads.get("job-created"); }
    });
    expect(turns).toBe(3);
    expectSqliteWriteBudget({ budgetFile, scenario: "accepted-duplicate-reads", note: "1000 durable duplicate submissions and owner reads; zero SQL writes, zero provider replay", writes: passive.writes });
  } finally { profile.close(); rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); vi.unstubAllEnvs(); }
});
