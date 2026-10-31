import assert from "node:assert/strict";
import test from "node:test";
import { releaseSource } from "./release-context.mjs";

const sha = "a".repeat(40);
const context = () => ({ repository: "pwrdrvr/PwrAgent", eventName: "push", ref: "refs/tags/v1.3.7",
  workflowRef: "pwrdrvr/PwrAgent/.github/workflows/release.yml@refs/tags/v1.3.7",
  refProtected: "true", sha, head: sha, tagCommit: sha, version: "1.3.7" });

test("only protected desktop tag pushes or dispatches on that exact tag can release", () => {
  assert.deepEqual(releaseSource(context(), ["main"]), { tag: "v1.3.7", commit: sha });
  assert.deepEqual(releaseSource({ ...context(), eventName: "workflow_dispatch", tag: "v1.3.7" }, ["main"]),
    { tag: "v1.3.7", commit: sha });
  for (const change of [{ repository: "fork/PwrAgent" }, { eventName: "pull_request" },
    { eventName: "pull_request_target" }, { eventName: "workflow_run" }, { ref: "refs/heads/main" },
    { refProtected: "false" }, { head: "b".repeat(40) }, { tagCommit: "b".repeat(40) },
    { tag: "v1.3.6" }, { version: "1.3.8" }, { sha: "not-a-sha" },
    { workflowRef: "pwrdrvr/PwrAgent/.github/workflows/publish-headless.yml@refs/tags/v1.3.7" }]) {
    assert.throws(() => releaseSource({ ...context(), ...change }, ["main"]), JSON.stringify(change));
  }
  assert.throws(() => releaseSource(context(), []), /release branch/);
  assert.throws(() => releaseSource(context(), ["feature/arbitrary"]), /release branch/);
  assert.throws(() => releaseSource(context(), ["releases/1.2"]), /release branch/);
  assert.deepEqual(releaseSource(context(), ["releases/1.3"]), { tag: "v1.3.7", commit: sha });
});
