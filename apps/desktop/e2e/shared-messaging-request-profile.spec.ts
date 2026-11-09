import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import Database from "better-sqlite3";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { SqliteMessagingRequestStore } from "@pwragent/sqlite-storage/messaging-request-store";
import type { MessagingRequestSource } from "@pwragent/owner-core/messaging-request-storage";
import type { MessagingInboundEvent } from "@pwragent/messaging-interface";
import { projectMessagingRequest } from "../src/main/messaging/core/messaging-request-projection";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import type { exerciseRequestFactory } from "./fixtures/messaging-request-driver";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("Electron's original request factory consumes portable provenance and returns private immutable outcomes to Node", async () => {
  let source!: MessagingRequestSource<MessagingInboundEvent>;
  let driverPath = "";
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      driverPath = path.join(homeRoot, "messaging-request-driver.cjs");
      // Bind only app-state selection to a test-owned profile. The factory,
      // concrete adapter and policy are production sources, running in Electron.
      const nativeModule = createRequire(new URL("../package.json", import.meta.url)).resolve("better-sqlite3");
      await build({ entryPoints: [path.join(specDir, "fixtures/messaging-request-driver.ts")], outfile: driverPath,
        bundle: true, platform: "node", format: "cjs", logLevel: "silent", plugins: [{ name: "request-profile-host", setup(builder) {
          builder.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: nativeModule, external: true }));
          builder.onResolve({ filter: /(?:^|\/)state\/app-state$/ }, () => ({ path: path.join(specDir, "fixtures/messaging-request-profile.ts") }));
        } }] });
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        const store = new SqliteMessagingRequestStore(db.raw, projectMessagingRequest);
        source = store.remember({ agent: { backend: "codex", threadId: "thread-smoke" }, event: {
          id: "portable-human", kind: "text", text: "Private portable instructions", receivedAt: 100,
          actor: { platformUserId: "invented-human" },
          channel: { channel: "slack", conversation: { id: "invented-channel", kind: "channel", workspaceId: "invented-workspace" } },
          routingState: { opaque: { route: "invented-channel", token: "Private portable credential" } },
        } })!;
        store.claimAttachment([source.ref.requestId, "portable-uncertain"]);
        const completed = store.claimAttachment([source.ref.requestId, "portable-completed"]);
        store.finishAttachment(completed.id, { ok: false, error: { code: "unsupported_operation", message: "Invented portable outcome" } });
      } finally { db.close(); }
    },
  });
  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    const result = await app.electronApp.evaluate((_electron, { driverPath, dbPath, ref }) => {
      const driver = process.getBuiltinModule("node:module").createRequire(driverPath)(driverPath) as { exerciseRequestFactory: typeof exerciseRequestFactory };
      return driver.exerciseRequestFactory(dbPath, ref, true);
    }, { driverPath, dbPath: stateDbPathForHomeRoot(app.homeRoot), ref: source.ref });
    expect(result.source).toEqual(source);
    expect(result.before).toEqual(source);
    expect(result.uncertain).toMatchObject({ claimed: false });
    expect(result.uncertain).not.toHaveProperty("result");
    expect(result.completed).toMatchObject({ claimed: false, result: { ok: false, error: { message: "Invented portable outcome" } } });
    expect(result.created).toEqual(result.duplicate);
    expect(result.after).toEqual(result.created);
    expect(result.page).toEqual([result.created]);
    expect(result.bot).toBeUndefined();
    expect(result.claim?.claimed).toBe(true);
    const raw = new Database(stateDbPathForHomeRoot(app.homeRoot), { readonly: true });
    try {
      const payloads = JSON.stringify(raw.prepare("SELECT payload FROM messaging_requests").all());
      expect(payloads).not.toContain("Private");
      expect(raw.prepare("SELECT COUNT(*) FROM messaging_requests").pluck().get()).toBe(2);
      expect(raw.prepare("SELECT result FROM messaging_attachment_operations WHERE operation_id = ?").pluck().get(result.claim!.id))
        .toContain("Invented Electron outcome");
    } finally { raw.close(); }
    const later = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      new SqliteMessagingRequestStore(later.raw, projectMessagingRequest).remember({ agent: source.agent,
        event: { ...source.event, id: "portable-later", kind: "text", text: "Private later input", receivedAt: 400 } });
    } finally { later.close(); }
    const observed = await app.electronApp.evaluate((_electron, { driverPath, dbPath, ref }) => {
      const driver = process.getBuiltinModule("node:module").createRequire(driverPath)(driverPath) as { exerciseRequestFactory: typeof exerciseRequestFactory };
      return driver.exerciseRequestFactory(dbPath, ref, false);
    }, { driverPath, dbPath: stateDbPathForHomeRoot(app.homeRoot), ref: source.ref });
    expect(observed.source).toEqual(source);
    expect(observed.before?.event.id).toBe("portable-later");
    await app.closeApplication();
    const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      const store = new SqliteMessagingRequestStore(db.raw, projectMessagingRequest);
      expect(store.get(source.ref)).toEqual(source);
      expect(store.get(result.created!.ref)).toEqual(result.created);
      expect(store.destination(source, source.selector)?.event.id).toBe("portable-later");
      expect(store.claimAttachment([source.ref.requestId, "electron-outcome"]))
        .toMatchObject({ claimed: false, result: { ok: false, error: { message: "Invented Electron outcome" } } });
      expect(store.claimAttachment([source.ref.requestId, "portable-uncertain"]).claimed).toBe(false);
    } finally { db.close(); }
  } finally { await app.close(); }
});
