import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getAutomationRunOwner,
  readAutomationRunOwnerLiveness,
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
  expect(readAutomationRunOwnerLiveness(owner)).toBe("alive");
});

it("proves another owner alive only on a full match with a live profile marker", () => {
  const other = { instanceId: "runtime-v2-other-instance", processId: process.pid, startedAt: 5 };
  // Its process ID is alive but nothing vouches for the identity yet.
  expect(readAutomationRunOwnerLiveness(other)).toBe("unconfirmed");

  const heartbeat = startProfileRuntimeHeartbeat(resolveActiveProfileName(), {
    instanceId: other.instanceId,
    intervalMs: 60_000,
    processId: other.processId,
    startedAt: other.startedAt,
  });
  try {
    expect(readAutomationRunOwnerLiveness(other)).toBe("alive");
    // The Research rule: no recorded start time cannot be matched.
    expect(readAutomationRunOwnerLiveness({ instanceId: other.instanceId, processId: other.processId })).toBe("dead");
    // A restarted instance or another instance at a live process ID is not
    // this owner, but only time separates it from a stale marker.
    expect(readAutomationRunOwnerLiveness({ ...other, startedAt: 6 })).toBe("unconfirmed");
    expect(readAutomationRunOwnerLiveness({ ...other, instanceId: "runtime-v2-someone-else" })).toBe("unconfirmed");
  } finally {
    heartbeat.stop();
    fs.rmSync(heartbeat.markerPath, { force: true });
  }
  expect(readAutomationRunOwnerLiveness(other)).toBe("unconfirmed");
});

it("calls an owner dead once its process is gone", () => {
  // No process holds this ID: far above any platform's process ID range in use.
  const gone = { instanceId: "runtime-v2-gone", processId: 0x3fff_fff0, startedAt: 5 };
  expect(readAutomationRunOwnerLiveness(gone)).toBe("dead");
});
