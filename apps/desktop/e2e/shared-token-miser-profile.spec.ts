import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { SqliteTokenMiserStorage } from "@pwragent/sqlite-storage/token-miser-storage-sqlite";
import { CURRENT_STATE_DB_USER_VERSION, StateDb } from "@pwragent/sqlite-storage/state-db";
import { TokenMiserStore } from "../src/main/token-miser/token-miser-store";
import type { TokenMiserCodeModeObservation, TokenMiserObjectMetadata } from "../src/main/token-miser/token-miser-types";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const threadId = "thread-smoke";
const objectId = "11111111-1111-4111-8111-111111111111";
const legacyId = "22222222-2222-4222-8222-222222222222";
const key = createHash("sha256").update(threadId).digest("hex");
const params = { threadId, turnId: "portable-turn", toolUseId: "portable-call", toolName: "Code Mode",
  output: "PRIVATE_PORTABLE_ORIGINAL", replacementCharacters: 16, now: 1_779_400_000_000,
  summary: { summary: "PRIVATE_HELPER_SUMMARY", usefulDetails: ["PRIVATE_HELPER_DETAIL"] } };

test("desktop's real usage service sees portable accounting and later WAL commits without retaining originals", async () => {
  let directory = "";
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      directory = path.join(path.dirname(stateDbPathForHomeRoot(homeRoot)), "token-miser", "objects");
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        const storage = new SqliteTokenMiserStorage<TokenMiserObjectMetadata, TokenMiserCodeModeObservation>(db);
        const service = new TokenMiserStore(directory, { storage });
        const portable = await service.store({ ...params, objectId });
        await service.recordCodeModeObservation({ threadId, turnId: "portable-turn", callId: "portable-call",
          cellId: "portable-cell", createdAt: 1_779_400_000_001, outputCharacters: 100, maxOutputTokens: 100,
          scriptStatus: "completed", retrieval: false, capturedNestedInvocationCount: 2,
          script: "PRIVATE_SCRIPT", outputPreview: "PRIVATE_PREVIEW" });
        const thread = path.join(directory, "threads", key);
        await fs.mkdir(thread, { recursive: true });
        await fs.writeFile(path.join(thread, `${objectId}.json`), JSON.stringify({ ...portable, retrievedCharacters: 999 }));
        await fs.writeFile(path.join(thread, `${legacyId}.json`), JSON.stringify({ ...portable, objectId: legacyId,
          toolUseId: "legacy-call", createdAt: portable.createdAt + 2, retrievedCharacters: 77, summary: params.summary }));
        await fs.writeFile(path.join(directory, `${legacyId}.json`), JSON.stringify({ ...portable, objectId: legacyId, retrievedCharacters: 1 }));
        await fs.writeFile(path.join(directory, `${legacyId}.txt`), "PRIVATE_LEGACY_OUTPUT");
        await fs.writeFile(path.join(thread, "archived"), "portable-archive");
        await fs.writeFile(path.join(thread, "retention-generation"), "older-generation");
        await service.prune({ maxAgeMs: 0, maxBytes: 0 });
      } finally { db.close(); }
    },
  });
  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    const readUsage = () => app.window.evaluate(async () => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      return await api.readTokenMiserUsage!();
    });
    expect(await readUsage()).toMatchObject({ interceptionCount: 2, retrievedTokens: 20 });
    // The Settings service retains its real factory-created store. A later
    // query must see another host's commit through that same service instance.
    const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      const storage = new SqliteTokenMiserStorage<TokenMiserObjectMetadata, TokenMiserCodeModeObservation>(db);
      const portable = storage.readMetadata(objectId, threadId)!;
      storage.runExclusive(() => {
        storage.writeMetadata({ ...portable, retrievedCharacters: 400 });
        storage.writeMetadata({ ...portable, objectId: "33333333-3333-4333-8333-333333333333", threadId: "another-owner" });
      });
      expect(await readUsage()).toMatchObject({ interceptionCount: 3, retrievedTokens: 120 });
      storage.removeMetadata("33333333-3333-4333-8333-333333333333");
      expect(await readUsage()).toMatchObject({ interceptionCount: 2, retrievedTokens: 120 });
    } finally { db.close(); }
    const raw = new Database(stateDbPathForHomeRoot(app.homeRoot), { readonly: true });
    try {
      expect(JSON.stringify(raw.prepare("SELECT payload FROM token_miser_objects UNION ALL SELECT payload FROM token_miser_observations").all())).not.toContain("PRIVATE_");
      expect(raw.prepare("SELECT generation, archived FROM token_miser_retention WHERE thread_key = ?").get(key))
        .toEqual({ generation: "portable-archive", archived: 1 });
      expect(raw.prepare("SELECT value FROM meta WHERE key = ?").pluck()
        .get(`token_miser_files_migrated:${createHash("sha256").update(directory).digest("hex")}`)).toBe("complete");
      expect(raw.prepare("PRAGMA user_version").pluck().get()).toBe(CURRENT_STATE_DB_USER_VERSION);
    } finally { raw.close(); }
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await app.closeApplication();
    const reopened = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      const storage = new SqliteTokenMiserStorage<TokenMiserObjectMetadata, TokenMiserCodeModeObservation>(reopened);
      expect(storage.readMetadata(objectId, threadId)?.retrievedCharacters).toBe(400);
      expect(storage.readMetadata(legacyId, threadId)?.retrievedCharacters).toBe(77);
      expect(storage.listObservations(threadId)).toHaveLength(1);
      const restarted = new TokenMiserStore(directory, { storage });
      await restarted.restoreThread(threadId);
      expect(storage.isArchived(key)).toBe(false);
      expect(storage.readRetentionGeneration(key)).toBe("portable-archive");
      expect(await restarted.readAll({ threadId, objectId })).toBeUndefined();
    } finally { reopened.close(); }
  } finally { await app.close(); }
});
