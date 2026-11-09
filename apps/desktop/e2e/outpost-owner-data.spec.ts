import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openOutpostProfileRuntime } from "../../../packages/pwragent/src/federation-core";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.resolve(specDir, "../../../packages/pwragent/src", file)).href);

test("the actual Outpost registry adopts legacy owner data and receives desktop metadata edits after shutdown", async () => {
  const [{ JobStore }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("federation-backend.js")]);
  const identity = { backend: "codex" as const, threadId: "thread-smoke" };
  let headless = "";
  let legacyBytes = "";
  const app = await launchElectronApp({
    secretStorage: "memory", fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      const stateDirectory = path.dirname(stateDbPathForHomeRoot(homeRoot));
      headless = path.join(stateDirectory, "headless");
      await mkdir(path.join(headless, "jobs"), { recursive: true, mode: 0o700 });
      await writeFile(path.join(headless, "identity.json"), JSON.stringify({ version: 1, workspace: homeRoot, codexHome: path.join(homeRoot, "codex") }));
      legacyBytes = JSON.stringify({ version: 1, threads: [{ id: identity.threadId, title: "Legacy Outpost owner title", titleSource: "explicit",
        createdAt: 1, sandbox: "read-only", pinnedRank: "1024", seenAt: 2, seenUpdatedAt: 1,
        parentThreadId: "legacy-parent", parentThreadBackend: "claude", messagingFileTools: true }] });
      await writeFile(path.join(headless, "threads.json"), legacyBytes);
      await writeFile(path.join(headless, "jobs/legacy.json"), JSON.stringify({ version: 1, id: "legacy", fingerprint: "retained", status: "running",
        threadId: identity.threadId, createdAt: "2026-01-01T00:00:00Z" }));
      const profile = openOutpostProfileRuntime({ stateDirectory, profileName: "default", cwd: homeRoot });
      try {
        const store = new JobStore(headless, { version: 1, workspace: homeRoot, codexHome: path.join(homeRoot, "codex") }, profile);
        const backend = new HeadlessBackend({ workspace: homeRoot, store, onFailure(error: unknown) { throw error; } }, () => {});
        expect(store.get("legacy")).toMatchObject({ status: "unknown", fingerprint: "retained" });
        expect(await backend.threadRegistry.getThreadMetadata(identity)).toMatchObject({ title: { text: "Legacy Outpost owner title", source: "explicit" }, pinnedRank: "1024" });
      } finally { profile.close(); }
    },
  });
  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    const result = await app.window.evaluate(async ref => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      const before = (await api.getNavigationSelectedDetail!({ protocol: 2, ref })).thread;
      await api.setThreadPin!({ ...ref, pinnedRank: "8192" });
      await api.setThreadParent!({ ...ref, parentThreadId: null });
      const seenAt = Date.now() + 60_000;
      await api.markThreadSeen!({ ...ref, seenAt, seenUpdatedAt: before!.updatedAt });
      return { before, seenAt };
    }, identity);
    expect(result.before).toMatchObject({ pinnedRank: "1024", parentThreadId: "legacy-parent" });
    await app.closeApplication();
    const profile = openOutpostProfileRuntime({ stateDirectory: path.dirname(stateDbPathForHomeRoot(app.homeRoot)), profileName: "default", cwd: app.homeRoot });
    try {
      const store = new JobStore(headless, { version: 1, workspace: app.homeRoot, codexHome: path.join(app.homeRoot, "codex") }, profile);
      const backend = new HeadlessBackend({ workspace: app.homeRoot, store, onFailure(error: unknown) { throw error; } }, () => {});
      const metadata = await backend.threadRegistry.getThreadMetadata(identity);
      expect(metadata).toMatchObject({ title: { text: "Legacy Outpost owner title", source: "explicit" }, pinnedRank: "8192", seenAt: result.seenAt });
      expect(metadata.parent).toBeUndefined();
      const summary = backend.summary(backend.owned(identity.threadId));
      expect(summary.pinnedRank).toBe("8192");
      // Recovery is newer than the replay provider row. Acknowledging that
      // older row must not read the recovered job merely because seenAt is later.
      expect(summary.inbox.inInbox).toBe(summary.updatedAt > (metadata.seenUpdatedAt ?? metadata.seenAt ?? 0));
      expect(store.get("legacy")).toMatchObject({ status: "unknown", fingerprint: "retained" });
      expect(await readFile(path.join(headless, "legacy-owner-backup-v1/threads.json"), "utf8")).toBe(legacyBytes);
    } finally { profile.close(); }
  } finally { await app.close(); }
});
