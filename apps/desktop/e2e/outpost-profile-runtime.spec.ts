import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { AppRuntimeInstanceStore } from "@pwragent/sqlite-storage/app-runtime-instance-store";
import { openOutpostProfileRuntime } from "../../../packages/pwragent/src/federation-core";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import type { ReplayFixture } from "../src/main/testing/replay-fixture";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { configTomlPathForHomeRoot, stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("excludes local thread owners with federation and messaging disabled while keeping passive viewers readable", async () => {
  const fixturePath = path.join(specDir, "fixtures/turn-lifecycle/replay.fixture.json");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as ReplayFixture;
  let outpost: ReturnType<typeof openOutpostProfileRuntime> | undefined;
  const app = await launchElectronApp({
    secretStorage: "memory", fixturePath,
    env: { PWRAGENT_DISABLE_MESSAGING: "1" },
    async preLaunchHook(homeRoot) {
      outpost = openOutpostProfileRuntime({ stateDirectory: path.dirname(stateDbPathForHomeRoot(homeRoot)), profileName: "default", cwd: homeRoot });
      await writeFile(configTomlPathForHomeRoot(homeRoot), '[federation]\nmode = "disabled"\n');
    },
  });
  const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
  const store = new AppRuntimeInstanceStore(db);
  const start = () => app.window.evaluate(async () => {
    const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
    return await api.startTurn!({ backend: "codex", threadId: "thread-turn-lifecycle", input: [{ type: "text", text: "Fixture owner handover" }] })
      .then(value => ({ value }), (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  });
  try {
    const outpostOwner = store.getFederationLease()!.ownerInstanceId;
    await app.window.getByRole("button", { name: /Turn lifecycle replay/i }).first().click();
    await expect(app.window.getByText("lifecycle baseline ready", { exact: true })).toBeVisible();
    const health = await app.window.evaluate(async () => await (window as unknown as { pwragent: DesktopApi }).pwragent.readFederationHealth!());
    expect(health.health.enabled).toBe(false);
    expect(await start()).toMatchObject({ error: expect.stringContaining("Profile thread ownership is held") });
    expect(await app.getLastStartTurn()).toBeUndefined();
    expect(store.getFederationLease()).toMatchObject({ ownerInstanceId: outpostOwner, status: "active" });
    outpost!.close();
    expect(await start()).toMatchObject({ value: { threadId: "thread-turn-lifecycle", turnId: "turn-turn-lifecycle-2" } });
    for (const step of fixture.steps) if (step.kind === "notification") await app.advance({ stepId: step.id });
    await expect(app.window.getByTestId("composer-stop-turn")).toHaveCount(0);
    const desktopOwner = store.getFederationLease()!.ownerInstanceId;
    expect(store.getInstance(desktopOwner)?.processId).toBe(app.electronApp.process().pid);
    // A service stop must not release a provider that is still alive.
    await app.window.evaluate(async () => await (window as unknown as { pwragent: DesktopApi }).pwragent.setFederationEnabled!(false));
    expect(store.getFederationLease()).toMatchObject({ ownerInstanceId: desktopOwner, status: "active" });
    expect(() => openOutpostProfileRuntime({ stateDirectory: path.dirname(stateDbPathForHomeRoot(app.homeRoot)), profileName: "default", cwd: app.homeRoot }))
      .toThrow(/Profile federation lease is held/);
    await app.closeApplication();
    expect(store.getFederationLease()).toMatchObject({ ownerInstanceId: desktopOwner, status: "released" });
    outpost = openOutpostProfileRuntime({ stateDirectory: path.dirname(stateDbPathForHomeRoot(app.homeRoot)), profileName: "default", cwd: app.homeRoot });
    outpost.close();
  } finally { outpost?.close(); db.close(); await app.close(); }
});

test("Outpost and the supported desktop exchange the same profile's runtime leases across graceful shutdown", async () => {
  let outpost: ReturnType<typeof openOutpostProfileRuntime> | undefined;
  const app = await launchElectronApp({
    secretStorage: "memory",
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      outpost = openOutpostProfileRuntime({ stateDirectory: path.dirname(stateDbPathForHomeRoot(homeRoot)), profileName: "default", cwd: homeRoot });
      await writeFile(configTomlPathForHomeRoot(homeRoot), '[federation]\nmode = "client"\n');
    },
  });
  const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
  const store = new AppRuntimeInstanceStore(db);
  const enableFederation = () => app.window.evaluate(async () => {
    const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
    await api.setFederationEnabled!(true);
    return await api.readFederationHealth!();
  });
  try {
    const outpostOwner = store.getFederationLease()!.ownerInstanceId;
    expect(store.getInstance(outpostOwner)?.processId).toBe(process.pid);
    expect(store.getMessagingLease()?.ownerInstanceId).toBe(outpostOwner);
    const blocked = await enableFederation();
    expect(blocked.health.status).toBe("degraded");
    expect(blocked.health.leaseHolder?.instanceId).toBe(outpostOwner);
    expect(blocked.health.unavailableReason).toMatch(/another PwrAgent instance/);
    expect(store.getFederationLease()).toMatchObject({ ownerInstanceId: outpostOwner, status: "active" });

    outpost!.close();
    const enabled = await enableFederation();
    expect(enabled.health.enabled).toBe(true);
    const desktopOwner = store.getFederationLease()!.ownerInstanceId;
    expect(desktopOwner).not.toBe(outpostOwner);
    expect(store.getInstance(desktopOwner)?.processId).toBe(app.electronApp.process().pid);
    expect(() => openOutpostProfileRuntime({ stateDirectory: path.dirname(stateDbPathForHomeRoot(app.homeRoot)), profileName: "default", cwd: app.homeRoot }))
      .toThrow(/Profile federation lease is held/);
    expect(store.getFederationLease()).toMatchObject({ ownerInstanceId: desktopOwner, status: "active" });
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    await app.closeApplication();
    expect(store.getFederationLease()).toMatchObject({ ownerInstanceId: desktopOwner, status: "released" });
    outpost = openOutpostProfileRuntime({ stateDirectory: path.dirname(stateDbPathForHomeRoot(app.homeRoot)), profileName: "default", cwd: app.homeRoot });
    expect(store.getFederationLease()).toMatchObject({ ownerInstanceId: outpostOwner, status: "active" });
    expect(store.getMessagingLease()).toMatchObject({ ownerInstanceId: outpostOwner, status: "active" });
    outpost.close();
    expect(store.getFederationLease()?.status).toBe("released");
    expect(store.getMessagingLease()?.status).toBe("released");
  } finally { outpost?.close(); db.close(); await app.close(); }
});
