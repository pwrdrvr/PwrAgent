import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { ThreadSandboxStore } from "@pwragent/sqlite-storage/thread-sandbox-store";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import type { exerciseResourceFactories } from "./fixtures/thread-resource-driver";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("Electron's actual resource factories and cleanup service share portable ownership across WAL and shutdown", async () => {
  let driverPath = "";
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      driverPath = path.join(homeRoot, "thread-resource-driver.cjs");
      const nativeModule = createRequire(new URL("../package.json", import.meta.url)).resolve("better-sqlite3");
      await build({ entryPoints: [path.join(specDir, "fixtures/thread-resource-driver.ts")], outfile: driverPath,
        bundle: true, platform: "node", format: "cjs", logLevel: "silent", external: ["electron"],
        plugins: [{ name: "resource-profile-host", setup(builder) {
          builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: nativeModule, external: true }));
          builder.onResolve({ filter: /(?:^|\/)state\/app-state$/ }, () => ({ path: path.join(specDir, "fixtures/thread-resource-profile.ts") }));
        } }],
      });
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        const store = new ThreadSandboxStore(db.raw);
        store.recordCreated({ connectionId: "invented", sandboxId: "portable", threadId: "thread", name: "Invented native grant", now: 100 });
        store.recordCreated({ connectionId: "invented", sandboxId: "other-provider", backend: "claude", threadId: "thread", now: 100 });
      } finally { db.close(); }
    },
  });
  const run = async (phase: "first" | "later" | "close") => await app.electronApp.evaluate(async (_electron, params) => {
    const driver = process.getBuiltinModule("node:module").createRequire(params.driverPath)(params.driverPath) as { exerciseResourceFactories: typeof exerciseResourceFactories };
    return await driver.exerciseResourceFactories(params.dbPath, params.phase);
  }, { driverPath, dbPath: stateDbPathForHomeRoot(app.homeRoot), phase });
  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    const first = await run("first");
    expect(first.before).toHaveLength(2);
    expect(first.calls).toEqual([{ name: "stop_sandbox", sandboxId: "portable" }]);
    expect(first.after).toHaveLength(3);
    expect(first.after).toContainEqual(expect.objectContaining({ sandboxId: "portable", threadId: "thread", status: "stopped", createdAt: 100, updatedAt: 200 }));
    expect(first.after.some(row => row.sandboxId === "guarded")).toBe(false);

    const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      const store = new ThreadSandboxStore(db.raw);
      expect(store.all()).toEqual(first.after);
      store.recordCreated({ connectionId: "invented", sandboxId: "later-wal", backend: "codex", threadId: "thread", now: 350 });
    } finally { db.close(); }
    const later = await run("later");
    expect(later.before).toContainEqual(expect.objectContaining({ sandboxId: "later-wal", status: "active" }));
    expect(later.calls).toEqual([{ name: "delete_sandbox", sandboxId: "portable" }, { name: "delete_sandbox", sandboxId: "electron" }, { name: "delete_sandbox", sandboxId: "later-wal" }]);
    expect(later.after).toEqual([expect.objectContaining({ sandboxId: "other-provider", backend: "claude", status: "active" })]);
    await run("close");
    await app.closeApplication();
    const reopened = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      const store = new ThreadSandboxStore(reopened.raw);
      expect(store.all()).toEqual(later.after);
      store.markOutcome({ connectionId: "invented", sandboxId: "portable", status: "stopped", now: 500 });
      expect(store.all()).toEqual(later.after); // stale cleanup cannot recreate it
      expect(store.pendingForThread({ backend: "codex", threadId: "thread" })).toEqual([]);
    } finally { reopened.close(); }
  } finally { await app.close(); }
});
