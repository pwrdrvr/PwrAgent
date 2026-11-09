import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore } from "../src/main/state/overlay-store-sqlite";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("desktop upgrades a profile opened by portable SQLite and retains its owner metadata", async () => {
  const identity = { backend: "codex" as const, threadId: "portable-fixture-thread" };
  const metadata = {
    title: { text: "Portable profile title", source: "explicit" as const },
    pinnedRank: "a0", seenAt: 123, seenUpdatedAt: 100,
    parent: { backend: "claude" as const, threadId: "portable-fixture-parent", instanceId: "fixture-instance" },
  };
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot), { profileName: "default" });
      try {
        await new SqliteOverlayStore(db).updateThreadMetadata(identity, metadata);
        db.setMeta("portable-fixture", "created outside Electron");
        // A supported old profile shape. Electron must run the same ladder
        // before its stores open; no test-only migration hook is involved.
        db.raw.exec("DROP TABLE durable_turn_requests");
        db.raw.pragma("user_version = 73");
      } finally { db.close(); }
    },
  });
  try {
    // Inspect through a raw WAL reader first: reopening with StateDb would
    // repair the profile itself and could conceal a missing Electron upgrade.
    const reader = new Database(stateDbPathForHomeRoot(app.homeRoot), { readonly: true });
    try {
      expect(reader.pragma("user_version", { simple: true })).toBe(80);
      expect(reader.prepare("SELECT name FROM pragma_table_info('durable_turn_requests')").all())
        .toContainEqual({ name: "receipt_json" });
    } finally { reader.close(); }
    const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      expect(db.getMeta("portable-fixture")).toBe("created outside Electron");
      expect(await new SqliteOverlayStore(db).getThreadMetadata(identity))
        .toMatchObject({ ...identity, ...metadata });
    } finally { db.close(); }
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    await app.window.getByRole("textbox", { name: "Reply", exact: true }).fill("The upgraded profile remains usable.");
    await expect(app.window.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  } finally { await app.close(); }
});
