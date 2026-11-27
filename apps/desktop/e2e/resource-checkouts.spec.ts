import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ResourceCheckoutActionRequest } from "@pwragent/shared/contracts/resource-checkouts";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { expect, test, type Page } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { configTomlPathForHomeRoot, stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { removeTempRoot } from "./fixtures/temp-root-cleanup";
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
      const request = (idempotencyKey: string, units?: number, expectedDurationMs = 120_000) => ({
        kind: "request" as const, resourceId, idempotencyKey, purpose: idempotencyKey, expectedDurationMs,
        ...(units === undefined ? {} : { units }),
      });
      const lightA = await perform(reopened.window, request("light-default", 1));
      const lightB = await perform(waiter.window, request("light-dev", 1));
      if (lightA.outcome !== "granted" || lightB.outcome !== "granted") {
        throw new Error(`Expected two light grants. Results: ${JSON.stringify([lightA, lightB])}`);
      }
      const release = (page: Page, lease: { allocationId: string; generation: number }) => perform(page, {
        kind: "release", resourceId, allocationId: lease.allocationId, generation: lease.generation,
        idempotencyKey: `release-${lease.allocationId}`,
      });
      // A profile holding part of the pool can't also wait for the rest.
      await expect(perform(reopened.window, request("heavy-while-holding"))).resolves.toMatchObject({
        outcome: "rejected", reason: "policy", message: expect.stringMatching(/Release what it holds/),
      });
      await release(reopened.window, lightA);
      const heavy = await perform(reopened.window, request("heavy"));
      // The machine pool backfills: a short light request from the other
      // profile ends before the whole-pool request could start, so it
      // starts now, even though that profile already holds a slot.
      const late = await perform(waiter.window, request("late-light", 1, 60_000));
      if (heavy.outcome !== "queued" || late.outcome !== "granted") {
        throw new Error(`Expected a queued whole-pool request and a backfilled light grant. Results: ${JSON.stringify([heavy, late])}`);
      }
      expect((await read(waiter.window)).resources[0]).toMatchObject({
        policy: { queueOrder: "backfill" },
        queue: [{ queueEntryId: heavy.queueEntryId }],
        allocations: [{ allocationId: lightB.allocationId, units: 1 }, { allocationId: late.allocationId, units: 1 }],
      });
      await release(waiter.window, lightB);
      await release(waiter.window, late);
      expect((await read(reopened.window)).resources[0]).toMatchObject({
        queue: [], allocations: [{ allocationId: heavy.queueEntryId, units: sharing.capacity }],
      });
    }
  } finally {
    try {
      await Promise.all(apps.map((app) => app.close()));
    } finally {
      await removeTempRoot(root);
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
      epoch: 1, revision: 1, updatedAt: 1, capacity: 1, maxHoldMs: 120_000,
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
  let sibling: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  try {
    client = await launchElectronApp({
      fixturePath, secretStorage: "memory",
      async preLaunchHook(homeRoot) {
        await seedCheckoutFederation(homeRoot, clientId);
        await writeFile(configTomlPathForHomeRoot(homeRoot), "[experimental]\nresource_checkouts_enabled = true\n");
      },
    });
    const readExternal = async (page: Page) => (await read(page)).resources.find((item) => item.resourceId === resourceId);
    await expect.poll(() => readExternal(owner.window)).toMatchObject({ condition: "available", enforcement: { coverage: "advisory" } });
    expect(await readExternal(client.window)).toBeUndefined();
    expect((await read(client.window)).agentTools).toBe("enabled");
    const popout = client.electronApp.waitForEvent("window");
    await client.window.evaluate(() => (window as unknown as { pwragent: DesktopApi }).pwragent.openResourceCheckoutsWindow!());
    const resourcesWindow = await popout;
    const resources = resourcesWindow.getByRole("region", { name: "Resources", exact: true });
    await expect(resources.getByText("This machine", { exact: true }).first()).toBeVisible();
    const advertised = resources.locator(`li[data-resource-id="${resourceId}"]`);
    await expect(advertised).toHaveCount(0);
    await resources.screenshot({ path: test.info().outputPath("client-before-enrollment.png") });
    await expect.poll(() => owner.window.evaluate(async () =>
      (await (window as unknown as { pwragent: DesktopApi }).pwragent.readFederationHealth!()).health.listenUrl ?? "",
    )).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    async function enroll(page: Page) {
      const invite = await owner.window.evaluate(async () =>
        (await (window as unknown as { pwragent: DesktopApi }).pwragent.generateFederationInvite!({ label: "Checkout E2E", ttlMs: 60_000 })).invite);
      await page.evaluate(async (token) =>
        (window as unknown as { pwragent: DesktopApi }).pwragent.importFederationInvite!({ invite: token }), invite);
    }
    await enroll(client.window);
    await expect.poll(() => readExternal(client!.window)).toMatchObject({ condition: "available", instructions: { revision: 1 } });

    await expect(advertised).toBeVisible();
    await resources.screenshot({ path: test.info().outputPath("client-after-discovery.png") });
    const action = { kind: "request" as const, idempotencyKey: "federation-hold", purpose: "Federation test hold", resourceId, expectedDurationMs: 120_000 };
    const grant = await perform(client.window, action);
    if (grant.outcome !== "granted") throw new Error("Expected a grant from the enrolled owner.");

    // Disconnect preserves the latest snapshot observed by the client.
    await expect.poll(() => readExternal(client!.window)).toMatchObject({
      condition: "busy",
      allocations: [{ allocationId: grant.allocationId, generation: grant.generation, lastKnown: false }],
    });
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
    const queued = await perform(owner.window, { ...action, idempotencyKey: "owner-waits" });
    expect(queued.outcome).toBe("queued");
    await expect(perform(client.window, {
      kind: "release", resourceId, allocationId: grant.allocationId, generation: grant.generation, idempotencyKey: "federation-release",
    })).resolves.toMatchObject({ outcome: "accepted" });
    await expect.poll(() => readExternal(owner.window)).toMatchObject({
      condition: "busy", allocations: [{ viewerOwns: true }], queue: [],
    });
    // A second authority behind the gateway serves the same client through the relay.
    const siblingId = "pwr_checkout_e2e_sibling";
    const siblingResource = "external:fixture:lab:sibling";
    const siblingMachine = `mach_${randomUUID()}`;
    sibling = await launchElectronApp({
      fixturePath, secretStorage: "memory",
      async preLaunchHook(homeRoot) {
        const entry = JSON.parse(manifest).domains[0];
        await seedCheckoutFederation(homeRoot, siblingId, JSON.stringify({ version: 1, domains: [{
          ...entry, authorityInstanceId: siblingId, authorityMachineId: siblingMachine, canonicalKey: siblingResource,
        }] }));
        await writeFile(path.join(homeRoot, ".pwragent", "machine-id"), siblingMachine + "\n");
      },
    });
    await enroll(sibling.window);
    const siblingRow = async (page: Page) => (await read(page)).resources.find((item) => item.resourceId === siblingResource);
    await expect.poll(() => siblingRow(client!.window)).toMatchObject({ condition: "available" });
    const remoteHold = await perform(client.window, { ...action, resourceId: siblingResource, idempotencyKey: "sibling-hold" });
    if (remoteHold.outcome !== "granted") throw new Error("Expected the sibling authority to grant the checkout.");
    expect(await siblingRow(sibling.window)).toMatchObject({ allocations: [{ allocationId: remoteHold.allocationId, viewerOwns: false }] });
    const held = { allocationId: remoteHold.allocationId, generation: remoteHold.generation };
    await expect.poll(() => siblingRow(client!.window)).toMatchObject({ allocations: [{ ...held, lastKnown: false }] });
    await sibling.window.evaluate(async () =>
      await (window as unknown as { pwragent: DesktopApi }).pwragent.setFederationEnabled!(false));
    await expect.poll(() => siblingRow(client!.window)).toMatchObject({ condition: "unreachable", allocations: [{ ...held, lastKnown: true }] });
    const gatewaySnapshot = await read(client.window);
    expect(gatewaySnapshot.authorities.find(item => item.authorityId === `checkout:${ownerId}:${resourceId}`)?.status).toBe("reachable");
    await sibling.window.evaluate(async () =>
      await (window as unknown as { pwragent: DesktopApi }).pwragent.setFederationEnabled!(true));
    await expect.poll(() => siblingRow(client!.window)).toMatchObject({ condition: "busy", allocations: [{ ...held, lastKnown: false }] });
    expect(await perform(client.window, { kind: "release", resourceId: siblingResource, idempotencyKey: "sibling-release",
      generation: remoteHold.generation, allocationId: remoteHold.allocationId })).toMatchObject({ outcome: "accepted" });
    await owner.window.evaluate(async (peerId) =>
      (window as unknown as { pwragent: DesktopApi }).pwragent.setFederationPeerRole!({ peerId, role: "contained" }), clientId);
    await expect.poll(() => readExternal(client!.window)).toBeUndefined();
    expect(await siblingRow(client.window)).toBeUndefined();
    await expect(advertised).toHaveCount(0);
    expect((await perform(client.window, { ...action, idempotencyKey: "contained" })).outcome).toBe("rejected");
    expect((await perform(client.window, { ...action, resourceId: siblingResource, idempotencyKey: "contained-sibling" })).outcome).toBe("rejected");
    await owner.window.evaluate(async (peerId) =>
      (window as unknown as { pwragent: DesktopApi }).pwragent.setFederationPeerRole!({ peerId, role: "full" }), clientId);
    await expect.poll(() => siblingRow(client!.window)).toMatchObject({ condition: "available", allocations: [] });
    await owner.window.evaluate(async (peerId) =>
      (window as unknown as { pwragent: DesktopApi }).pwragent.revokeFederationPeer!({ peerId }), clientId);
    await expect.poll(() => readExternal(client!.window)).toBeUndefined();
    expect(await siblingRow(client.window)).toBeUndefined();
  } finally {
    await Promise.all([sibling?.close(), client?.close(), owner.close()]);
  }
});

async function seedCheckoutFederation(homeRoot: string, instanceId: string, manifest?: string): Promise<void> {
  const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
  try { db.setMeta("federation_instance_id", instanceId); }
  finally { db.close(); }
  if (manifest) await writeFile(path.join(homeRoot, ".pwragent", "resource-checkout-authorities.json"), manifest);
}
