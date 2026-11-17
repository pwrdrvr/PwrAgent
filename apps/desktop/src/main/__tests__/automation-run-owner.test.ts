import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getAutomationRunOwner,
  isAutomationRunOwnerAlive,
} from "../automations/automation-run-owner";
import { resolveActiveProfileName, startProfileRuntimeHeartbeat } from "../profile";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-automation-owner-"));
  vi.stubEnv("PWRAGENT_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

it("records this process under the identity its runtime marker carries", () => {
  const owner = getAutomationRunOwner();
  expect(owner.processId).toBe(process.pid);
  expect(owner.instanceId).toMatch(/^runtime-v2-/);
  expect(typeof owner.startedAt).toBe("number");
  // Alive without a marker on disk: startup runs before the heartbeat matters.
  expect(isAutomationRunOwnerAlive(owner)).toBe(true);
});

it("proves another owner alive only on a full match with a live profile marker", () => {
  const other = { instanceId: "runtime-v2-other-instance", processId: process.pid, startedAt: 5 };
  expect(isAutomationRunOwnerAlive(other)).toBe(false);

  const heartbeat = startProfileRuntimeHeartbeat(resolveActiveProfileName(), {
    instanceId: other.instanceId,
    intervalMs: 60_000,
    processId: other.processId,
    startedAt: other.startedAt,
  });
  try {
    expect(isAutomationRunOwnerAlive(other)).toBe(true);
    // The Research rule: no recorded start time cannot be matched.
    expect(isAutomationRunOwnerAlive({ instanceId: other.instanceId, processId: other.processId })).toBe(false);
    // A reused process ID or a restarted instance is a different owner.
    expect(isAutomationRunOwnerAlive({ ...other, startedAt: 6 })).toBe(false);
    expect(isAutomationRunOwnerAlive({ ...other, instanceId: "runtime-v2-someone-else" })).toBe(false);
  } finally {
    heartbeat.stop();
    fs.rmSync(heartbeat.markerPath, { force: true });
  }
  expect(isAutomationRunOwnerAlive(other)).toBe(false);
});
