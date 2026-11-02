import assert from "node:assert/strict";
import test from "node:test";
import { FEDERATION_BACKEND_METHOD_CAPABILITIES } from "../dist/federation-core.js";
import { METHOD_CAPABILITIES, ownerMethodCapabilities } from "../src/federation-backend.js";

test("every owner method takes its capability from the shared contract", () => {
  assert.ok(Object.keys(METHOD_CAPABILITIES).length > 0);
  for (const [method, capability] of Object.entries(METHOD_CAPABILITIES)) {
    assert.equal(capability, FEDERATION_BACKEND_METHOD_CAPABILITIES[method], method);
  }
  // These five once differed from desktop and let a navigation-only peer read detail.
  assert.deepEqual([
    "backend.getNavigationSelectedDetail", "backend.getNavigationQueueProjection",
    "backend.getNavigationLaunchpadConfig", "backend.listBackends", "backend.materializeDirectoryLaunchpad",
  ].map((method) => METHOD_CAPABILITIES[method]), ["thread_detail", "thread_detail", "thread_detail", "thread_detail", "environment_actions"]);
});

test("an owner method outside the shared contract fails at load", () => {
  assert.throws(() => ownerMethodCapabilities(["readThread", "inventedMethod"]), /backend\.inventedMethod is not in the shared owner contract/);
  assert.throws(() => ownerMethodCapabilities(["toString"]), /backend\.toString is not in the shared owner contract/);
});
