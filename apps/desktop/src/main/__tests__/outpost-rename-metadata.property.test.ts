import fc from "fast-check";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteOverlayStore } from "@pwragent/sqlite-storage/overlay-store-sqlite";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
type Update =
  | { kind: "seen"; value: number }
  | { kind: "model"; value: string }
  | { kind: "mode"; value: "default" | "auto" }
  | { kind: "owner"; value: number };
const update = fc.oneof(
  fc.record({ kind: fc.constant("seen" as const), value: fc.nat(10000) }),
  fc.record({ kind: fc.constant("model" as const), value: fc.stringMatching(/^[a-z]{1,12}$/) }),
  fc.record({ kind: fc.constant("mode" as const), value: fc.constantFrom("default" as const, "auto" as const) }),
  fc.record({ kind: fc.constant("owner" as const), value: fc.nat(10000) }),
);

async function renameWithConcurrentUpdates(updates: Update[], source: "explicit" | "derived", refused: boolean) {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-rename-metadata-")));
  mkdirSync(path.join(root, "headless"), { mode: 0o700 });
  const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
  const overlay = new SqliteOverlayStore(db);
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  const identity = { backend: "codex" as const, threadId: "thread" };
  let entered!: () => void;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; });
  const provider = new Promise<void>(resolve => { release = resolve; });
  let completion: Promise<unknown> | undefined;
  try {
    const initialTitle = { text: "Before", source: "explicit" as const, nativeName: "Before" };
    await overlay.updateThreadMetadata(identity, { title: initialTitle, seenAt: 1, seenUpdatedAt: 1,
      executionMode: "default", model: "before", reasoningEffort: "low", serviceTier: "flex", updatedAt: 123,
      pinnedRank: "100", parent: { backend: "claude", threadId: "parent" }, nativeMembershipRetired: false });
    const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
    store.inventory.replace({ backend: "codex", observedAt: 1, threads: [{ id: identity.threadId, source: "codex",
      title: "Before", titleSource: "explicit", createdAt: 1, updatedAt: 123, linkedDirectories: [] }] });
    let calls = 0;
    let nameEvents = 0;
    const backend = new HeadlessBackend({ workspace: root, store, onFailure(error: unknown) { throw error; },
      codex: { renameThread: async () => {
        calls++;
        entered();
        await provider;
        if (refused) throw new Error("Provider refused rename");
        return { threadId: identity.threadId };
      } } }, (event: { notification: { method: string } }) => {
      if (event.notification.method === "thread/name/updated") nameEvents++;
    });
    completion = backend.naming.renameThread({ ...identity, name: "After" }, { titleSource: source })
      .then(() => undefined, (error: unknown) => error);
    await pending;
    for (const change of updates) {
      switch (change.kind) {
        case "seen":
          await backend.handle("markThreadSeen", { ...identity, seenAt: change.value, seenUpdatedAt: change.value });
          break;
        case "model":
          await backend.handle("setThreadModelSettings", { ...identity, model: change.value, reasoningEffort: change.value, serviceTier: change.value });
          break;
        case "mode":
          await backend.handle("setThreadExecutionMode", { ...identity, executionMode: change.value });
          break;
        case "owner":
          await overlay.updateThreadMetadata(identity, { pinnedRank: String(change.value), updatedAt: change.value,
            parent: { backend: "claude", threadId: String(change.value) }, nativeMembershipRetired: change.value % 2 === 0 });
          break;
      }
    }
    // The owner storage is the oracle: rename may replace only its title fact.
    const latest = await overlay.getThreadMetadata(identity);
    const expected = { ...latest, title: refused ? initialTitle : { text: "After", source, nativeName: "After" } };
    release();
    const result = await completion;
    if (refused) expect(result).toEqual(new Error("Provider refused rename"));
    else expect(result).toBeUndefined();
    expect(calls).toBe(1);
    expect(nameEvents).toBe(refused ? 0 : 1);
    expect(await overlay.getThreadMetadata(identity)).toEqual(expected);
    profile.close();
    const reopened = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
    try {
      const reopenedStore = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, reopened);
      expect(reopenedStore.threadRegistry.getThreadMetadata(identity)).toEqual(expected);
    } finally { reopened.close(); }
  } finally {
    release();
    await completion;
    profile.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

it("provider rename completion preserves every concurrent canonical owner update", async () => {
  await fc.assert(fc.asyncProperty(fc.array(update, { minLength: 1, maxLength: 8 }),
    fc.constantFrom("explicit" as const, "derived" as const), fc.boolean(), renameWithConcurrentUpdates), { numRuns: 30 });
});

it("acknowledging update 123 during rename never restores the old read watermark 1", async () => {
  await renameWithConcurrentUpdates([{ kind: "seen", value: 123 }], "explicit", false);
});

it("rename preserves concurrent owner updates at timestamp zero", async () => {
  await renameWithConcurrentUpdates([{ kind: "owner", value: 0 }], "explicit", false);
});

it("rename preserves concurrent model settings and execution mode", async () => {
  await renameWithConcurrentUpdates([{ kind: "model", value: "after" }, { kind: "mode", value: "auto" }], "derived", false);
});
