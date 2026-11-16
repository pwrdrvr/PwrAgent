import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { getProcessRuntimeIdentity, startProfileRuntimeHeartbeat } from "../profile";
import { createResearchOwnerIdentity } from "../research/research-owner-identity";

afterEach(() => vi.unstubAllEnvs());

it("research recovery matches the real profile marker's complete process identity", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "research-owner-"));
  vi.stubEnv("PWRAGENT_HOME", root);
  vi.stubEnv("PWRAGENT_PROFILE", "research-owner");
  const owner = createResearchOwnerIdentity();
  const identity = getProcessRuntimeIdentity();
  expect(owner).toMatchObject({ ownerId: identity.instanceId, ownerPid: process.pid, ownerStartedAt: identity.startedAt });
  const marker = startProfileRuntimeHeartbeat("research-owner", {
    instanceId: identity.instanceId, processId: process.pid, startedAt: identity.startedAt, intervalMs: 60_000,
  });
  try {
    // All three components must agree, even while the old PID is still alive.
    for (const changed of ["none", "instance", "pid", "start", "legacy"] as const) {
      const candidate = { ownerId: owner.ownerId, ownerPid: owner.ownerPid, ownerStartedAt: owner.ownerStartedAt,
        ...(changed === "instance" ? { ownerId: "runtime-v2-unrelated" } : {}),
        ...(changed === "pid" ? { ownerPid: process.pid + 1 } : {}),
        ...(changed === "start" ? { ownerStartedAt: owner.ownerStartedAt + 1 } : {}),
        ...(changed === "legacy" ? { ownerStartedAt: undefined } : {}),
      };
      expect(owner.isOwnerAlive(candidate)).toBe(changed === "none");
    }
    marker.stop();
    expect(owner.isOwnerAlive(owner)).toBe(false);
  } finally {
    marker.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
