import assert from "node:assert/strict";
import test from "node:test";
import { syncHomebrew } from "./sync-homebrew.mjs";

function fixture({ published = "1.0.0", installed = true, failed = false } = {}) {
  const calls = [];
  const api = (endpoint, body, token) => {
    calls.push({ endpoint, body, token });
    if (endpoint.includes("releases/latest")) return { tag_name: "v1.2.3", draft: false, prerelease: false };
    if (endpoint.includes("contents/")) return { content: Buffer.from(`  version "${published}"\n`).toString("base64") };
    if (body) { if (!failed) published = "1.2.3"; return null; }
    if (endpoint.includes("/runs?")) return { workflow_runs: failed ? [{ display_title: "PwrAgent Homebrew sync 1.2.3", created_at: new Date().toISOString(), status: "completed", conclusion: "failure", html_url: "https://github.com/pwrdrvr/homebrew-tap/actions/runs/123" }] : [] };
    return installed ? { state: "active" } : null;
  };
  return { api, calls, publish: () => { published = "1.2.3"; } };
}
test("current cask needs no dispatch credential", async () => {
  const f = fixture({ published: "1.2.3" });
  assert.equal((await syncHomebrew("1.2.3", { api: f.api, dispatchToken: "" })).state, "published");
  assert.equal(f.calls.length, 2);
});
test("dispatch uses only the tap workflow and verifies main", async () => {
  const f = fixture();
  await syncHomebrew("1.2.3", { api: f.api, dispatchToken: "fixture", pause: async () => {} });
  const writes = f.calls.filter((call) => call.body);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].endpoint, "repos/pwrdrvr/homebrew-tap/actions/workflows/bump-pwragent.yml/dispatches");
  assert.deepEqual(writes[0].body, { ref: "main", inputs: { version: "1.2.3" } });
});
test("missing dispatch token awaits scheduled publication without writes", async () => {
  const f = fixture();
  await syncHomebrew("1.2.3", { api: f.api, dispatchToken: "", pause: async () => f.publish(), attempts: 2 });
  assert.equal(f.calls.filter((call) => call.body).length, 0);
});
test("stale targets, missing publisher and failed validation fail explicitly", async () => {
  await assert.rejects(syncHomebrew("1.2.2", { ...fixture(), dispatchToken: "" }), /no longer promoted/);
  await assert.rejects(syncHomebrew("1.2.3", { ...fixture({ installed: false }), dispatchToken: "" }), /not installed\/active/);
  await assert.rejects(syncHomebrew("1.2.3", { ...fixture({ failed: true }), dispatchToken: "fixture", pause: async () => {}, attempts: 2 }), /actions\/runs\/123/);
});
test("schedule wait has a bounded deadline and never downloads assets", async () => {
  const f = fixture();
  await assert.rejects(syncHomebrew("1.2.3", { ...f, dispatchToken: "", pause: async () => {}, attempts: 2 }), /not on tap main/);
  assert(f.calls.every((call) => !call.endpoint.includes("releases/assets") && !call.endpoint.includes("releases/download")));
});
