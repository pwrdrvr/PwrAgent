import path from "node:path";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { AppRuntimeInstanceStore } from "@pwragent/sqlite-storage/app-runtime-instance-store";
import { openOutpostProfileRuntime } from "../../../packages/pwragent/src/federation-core";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { configTomlPathForHomeRoot, stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));

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
