import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectFederationHostInfo,
  collectFederationLoadStatus,
  readOrCreateFederationMachineId,
} from "../federation/federation-host-info";

describe("federation host info", () => {
  const tempRoots: string[] = [];

  function makeRoot(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-host-info-"));
    tempRoots.push(root);
    return root;
  }

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("mints a machine id once and returns the same id afterwards", async () => {
    const rootDir = makeRoot();

    const first = await readOrCreateFederationMachineId({ rootDir });
    const second = await readOrCreateFederationMachineId({ rootDir });

    expect(first).toMatch(/^mach_/);
    expect(second).toBe(first);
    expect(readFileSync(path.join(rootDir, "machine-id"), "utf8").trim()).toBe(
      first,
    );
  });

  it("creates the root directory when it does not exist yet", async () => {
    const rootDir = path.join(makeRoot(), "nested", "root");

    const minted = await readOrCreateFederationMachineId({ rootDir });

    expect(minted).toMatch(/^mach_/);
  });

  it("collects host facts with the shared machine id", async () => {
    const rootDir = makeRoot();

    const host = await collectFederationHostInfo({ rootDir });

    expect(host.platform).toBe(process.platform);
    expect(host.hostname).toBeTruthy();
    expect(host.arch).toBeTruthy();
    expect(host.osVersion).toBeTruthy();
    expect(host.cpuCount).toBeGreaterThan(0);
    expect(host.memoryBytes).toBeGreaterThan(0);
    expect(host.diskFreeBytes).toBeGreaterThan(0);
    expect(host.machineId).toMatch(/^mach_/);
    // Two profiles sharing one root — the shared-hardware signal — agree.
    expect((await collectFederationHostInfo({ rootDir })).machineId).toBe(
      host.machineId,
    );
  });

  it("samples a live load reading against the PwrAgent root's volume", async () => {
    const rootDir = makeRoot();
    const before = Date.now();

    const load = await collectFederationLoadStatus({ rootDir });

    // loadAvg* are 0 on Windows by Node contract, so only pin non-negative.
    expect(load.loadAvg1).toBeGreaterThanOrEqual(0);
    expect(load.loadAvg5).toBeGreaterThanOrEqual(0);
    expect(load.loadAvg15).toBeGreaterThanOrEqual(0);
    expect(load.availableMemoryBytes).toBeGreaterThan(0);
    expect(load.freeDiskBytes).toBeGreaterThan(0);
    expect(load.sampledAt).toBeGreaterThanOrEqual(before);
    expect(load.sampledAt).toBeLessThanOrEqual(Date.now());
  });

  it("omits freeDiskBytes when the root's volume cannot be read", async () => {
    const load = await collectFederationLoadStatus({
      rootDir: path.join(makeRoot(), "does-not-exist"),
    });

    expect(load.freeDiskBytes).toBeUndefined();
    expect(load.availableMemoryBytes).toBeGreaterThan(0);
  });
});
