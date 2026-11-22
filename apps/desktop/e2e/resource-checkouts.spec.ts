import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ResourceCheckoutActionRequest } from "@pwragent/shared/contracts/resource-checkouts";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { expect, test, type Page } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { configTomlPathForHomeRoot, stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { StateDb } from "../src/main/state/state-db";

function read(page: Page) {
  return page.evaluate(async () => await (window as unknown as { pwragent: DesktopApi }).pwragent.readResourceCheckouts!());
}

function perform(page: Page, action: ResourceCheckoutActionRequest) {
  return page.evaluate(async (request) => await (window as unknown as { pwragent: DesktopApi }).pwragent.performResourceCheckoutAction!(request), action);
}

test("default and dev contend for one durable machine allocation through preload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-e2e-resource-root-"));
  const apps: Awaited<ReturnType<typeof launchElectronApp>>[] = [];
  async function launch(profile: string) {
    const app = await launchElectronApp({
      fixturePath: path.join(import.meta.dirname, "fixtures/smoke/replay.fixture.json"),
      env: { PWRAGENT_HOME: root, PWRAGENT_PROFILE: profile },
    });
    apps.push(app);
    return app;
  }

  try {
    const launches = await Promise.allSettled([launch("default"), launch("dev")]);
    const [first, second] = launches.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    const [defaultView, devView] = await Promise.all([read(first.window), read(second.window)]);
    expect(defaultView.viewer.profile).toBe("default");
    expect(devView.viewer.profile).toBe("dev");
    expect(defaultView.viewer.machineId).toBeTruthy();
    expect(defaultView.viewer.machineId).toBe(devView.viewer.machineId);
    expect([defaultView.resources[0].condition, devView.resources[0].condition]).toEqual(["available", "available"]);
    const [{ resourceId, sharing }] = defaultView.resources;
    expect(sharing).toMatchObject({ mode: "counted", capacity: os.cpus().length || 1, unitLabel: "CPU slots" });
    expect(devView.resources.map((resource) => resource.resourceId)).toEqual([resourceId]);
    const [a, b] = await Promise.all([first.window, second.window].map((page, index) =>
      perform(page, { kind: "request", idempotencyKey: `hold-${index}`, resourceId,
        purpose: `Profile ${index} hold`, expectedDurationMs: 120_000 })));
    const [holder, waiter] = a.outcome === "granted" ? [first, second] : [second, first];
    const [granted, queued] = a.outcome === "granted" ? [a, b] : [b, a];
    if (granted.outcome !== "granted" || queued.outcome !== "queued") {
      throw new Error(`Expected one grant and one queued request. Results: ${JSON.stringify([a, b])}`);
    }

    await holder.closeApplication();
    const retained = (await read(waiter.window)).resources[0];
    expect(retained.allocations.map(({ allocationId }) => allocationId)).toEqual([granted.allocationId]);
    expect(retained.queue.map(({ queueEntryId }) => queueEntryId)).toEqual([queued.queueEntryId]);

    const reopened = await launch(holder === first ? "default" : "dev");
    await expect(perform(reopened.window, {
      kind: "release", resourceId, allocationId: granted.allocationId, generation: granted.generation,
      idempotencyKey: "release-after-restart",
    })).resolves.toMatchObject({ outcome: "accepted" });
    const promoted = await read(waiter.window);
    expect(promoted.resources[0]).toMatchObject({
      queue: [], allocations: [{ allocationId: queued.queueEntryId, generation: granted.generation + 1, viewerOwns: true }],
    });
    await expect(perform(waiter.window, {
      kind: "release", resourceId, allocationId: queued.queueEntryId, generation: granted.generation + 1,
      idempotencyKey: "release-promoted",
    })).resolves.toMatchObject({ outcome: "accepted" });

    if (sharing.mode === "counted" && sharing.capacity > 1) {
      const request = (idempotencyKey: string, units?: number) => ({
        kind: "request" as const, resourceId, idempotencyKey, purpose: idempotencyKey, expectedDurationMs: 120_000,
        ...(units === undefined ? {} : { units }),
      });
      const lightA = await perform(reopened.window, request("light-default", 1));
      const lightB = await perform(waiter.window, request("light-dev", 1));
      const heavy = await perform(reopened.window, request("heavy"));
      const late = await perform(waiter.window, request("late-light", 1));
      if (lightA.outcome !== "granted" || lightB.outcome !== "granted" || heavy.outcome !== "queued" || late.outcome !== "queued") {
        throw new Error("Expected two light grants followed by two FIFO waiters.");
      }
      const release = (page: Page, lease: typeof lightA) => perform(page, {
        kind: "release", resourceId, allocationId: lease.allocationId, generation: lease.generation,
        idempotencyKey: `release-${lease.allocationId}`,
      });
      await release(reopened.window, lightA);
      expect((await read(waiter.window)).resources[0]).toMatchObject({
        queue: [{ queueEntryId: heavy.queueEntryId }, { queueEntryId: late.queueEntryId }],
        allocations: [{ allocationId: lightB.allocationId, units: 1 }],
      });
      await release(waiter.window, lightB);
      expect((await read(reopened.window)).resources[0]).toMatchObject({
        queue: [{ queueEntryId: late.queueEntryId }], allocations: [{ allocationId: heavy.queueEntryId, units: sharing.capacity }],
      });
    }
  } finally {
    try {
      await Promise.all(apps.map((app) => app.close()));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("an enrolled Federation peer reconnects to the same external authority", async () => {
  const resourceId = "external:fixture:lab:retained";
  const ownerId = "pwr_checkout_e2e_owner";
  const clientId = "pwr_checkout_e2e_client";
  const machineId = `mach_${randomUUID()}`;
  const manifest = JSON.stringify({
    version: 1, domains: [{
      canonicalKey: resourceId, authorityInstanceId: ownerId, authorityMachineId: machineId,
      allowedInstances: [clientId], epoch: 1, revision: 1, updatedAt: 1, capacity: 1, maxHoldMs: 120_000,
      displayName: "Invented retained resource", kindLabel: "Fixture", instructions: "Invented cleanup instructions.",
    }],
  });
  const fixturePath = path.join(import.meta.dirname, "fixtures/smoke/replay.fixture.json");
  const owner = await launchElectronApp({
    fixturePath, secretStorage: "memory",
    async preLaunchHook(homeRoot) {
      await seedCheckoutFederation(homeRoot, ownerId, manifest);
      await writeFile(path.join(homeRoot, ".pwragent", "machine-id"), machineId + "\n");
      await writeFile(configTomlPathForHomeRoot(homeRoot), '[federation]\nmode = "gateway"\nlisten_host = "127.0.0.1"\nlisten_port = 0\n');
    },
  });
  let client: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  try {
    client = await launchElectronApp({
      fixturePath, secretStorage: "memory",
      preLaunchHook: (homeRoot) => seedCheckoutFederation(homeRoot, clientId, manifest),
    });
    const readExternal = async (page: Page) => (await read(page)).resources.find((item) => item.resourceId === resourceId);
    await expect.poll(() => readExternal(owner.window)).toMatchObject({ condition: "available", enforcement: { coverage: "advisory" } });
    await expect.poll(() => readExternal(client!.window)).toMatchObject({ condition: "unreachable", actions: {} });
    await expect.poll(() => owner.window.evaluate(async () =>
      (await (window as unknown as { pwragent: DesktopApi }).pwragent.readFederationHealth!()).health.listenUrl ?? "",
    )).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    const invite = await owner.window.evaluate(async () =>
      (await (window as unknown as { pwragent: DesktopApi }).pwragent.generateFederationInvite!({ label: "Checkout E2E", ttlMs: 60_000 })).invite);
    await client.window.getByRole("button", { name: "Open settings" }).click();
    await client.window.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Federation", exact: true }).click();
    await client.window.getByLabel("Import invite").fill(invite);
    await client.window.getByRole("button", { name: "Import invite" }).click();
    await expect.poll(() => readExternal(client!.window)).toMatchObject({ condition: "available", instructions: { revision: 1 } });

    const action = { kind: "request" as const, idempotencyKey: "federation-hold", purpose: "Federation test hold", resourceId, expectedDurationMs: 120_000 };
    const grant = await perform(client.window, action);
    if (grant.outcome !== "granted") throw new Error("Expected a grant from the enrolled owner.");

    await client.window.evaluate(async () =>
      await (window as unknown as { pwragent: DesktopApi }).pwragent.setFederationEnabled!(false));
    await expect.poll(() => readExternal(client!.window)).toMatchObject({ condition: "unreachable", allocations: [{ lastKnown: true, generation: grant.generation }] });
    expect((await read(client.window)).resources.find((item) => item.placement === "machine")?.condition).toBe("available");
    expect(await readExternal(owner.window)).toMatchObject({
      allocations: [{ allocationId: grant.allocationId, generation: grant.generation }], queue: [],
    });
    await client.window.evaluate(async () =>
      await (window as unknown as { pwragent: DesktopApi }).pwragent.setFederationEnabled!(true));
    await expect.poll(() => readExternal(client!.window)).toMatchObject({ condition: "busy", allocations: [{ lastKnown: false, viewerOwns: true }] });
    await expect(perform(client.window, action)).resolves.toEqual(grant);
    await expect(perform(client.window, {
      kind: "release", resourceId, allocationId: grant.allocationId, generation: grant.generation, idempotencyKey: "federation-release",
    })).resolves.toMatchObject({ outcome: "accepted" });
    await expect.poll(() => readExternal(owner.window)).toMatchObject({ condition: "available", allocations: [], queue: [] });
  } finally {
    await Promise.all([client?.close(), owner.close()]);
  }
});

async function seedCheckoutFederation(homeRoot: string, instanceId: string, manifest: string): Promise<void> {
  const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
  try { db.setMeta("federation_instance_id", instanceId); }
  finally { db.close(); }
  await writeFile(path.join(homeRoot, ".pwragent", "resource-checkout-authorities.json"), manifest);
}
