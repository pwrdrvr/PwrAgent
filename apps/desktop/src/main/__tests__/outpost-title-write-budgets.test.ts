import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { measureSqliteWrites } from "@pwragent/sqlite-storage/sqlite-write-metrics";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);

it("budgets actual first-prompt and helper title boundaries separately from duplicate events and passive reads", async () => {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-title-writes-")));
  const previous = process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS;
  process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS = "1";
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  try {
    const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
    store.save({ version: 1, id: "first", fingerprint: "immutable", threadId: "thread", turnId: "turn", status: "running", sandbox: "read-only", createdAt: new Date(1).toISOString() });
    let complete!: (value: unknown) => void;
    const helper = new Promise(resolve => { complete = resolve; });
    const backend = new HeadlessBackend({ workspace: root, store, onFailure(error: unknown) { throw error; }, codex: {
      generateTitle: async () => await helper, renameThread: async () => ({ threadId: "thread" }),
    } }, () => {});
    const event = { method: "headless/turnStarted", params: { threadId: "thread", jobId: "first", prompt: "Please fix the login test" } };
    const fallback = await measureSqliteWrites(async () => { backend.event(event); });
    expectSqliteWriteBudget({ budgetFile: "outpost-title-write-budgets.json", scenario: "prompt-fallback", note: "Existing immediate first-prompt title boundary; setup and job acceptance excluded", writes: fallback.writes });
    const generated = await measureSqliteWrites(async () => {
      complete({ status: "ok", object: { title: "Repair login regression" } });
      await backend.titles.whenSettled();
    });
    expectSqliteWriteBudget({ budgetFile: "outpost-title-write-budgets.json", scenario: "helper-title", note: "One acknowledged helper title through actual shared naming and owner metadata; no helper job or transcript persistence", writes: generated.writes });
    const repeated = await measureSqliteWrites(async () => {
      for (let i = 0; i < 1000; i++) { backend.event(event); backend.threads.get("thread"); }
      await backend.titles.whenSettled();
    });
    expectSqliteWriteBudget({ budgetFile: "outpost-title-write-budgets.json", scenario: "repeated-title-reads", note: "1000 repeated accepted-turn observations and owner reads; helper admission remains process-local", writes: repeated.writes });
    expect(store.get("first")).toMatchObject({ fingerprint: "immutable", threadId: "thread", turnId: "turn", status: "running" });
  } finally {
    profile.close(); rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS;
    else process.env.PWRAGENT_DEV_SQLITE_WRITE_METRICS = previous;
  }
});
