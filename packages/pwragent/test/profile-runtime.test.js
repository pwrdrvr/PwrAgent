import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { setup } from "./helpers.js";

// Oracle: the actual daemon's PID identity and the profile's existing lease
// rows must agree before the daemon accepts any job or starts a provider.
test("the actual daemon owns the shared profile leases and retires them on graceful shutdown", async t => {
  const h = await setup(t);
  const state = path.dirname(h.directory);
  const file = path.join(state, "state.db");
  assert.ok(existsSync(file), "a running Outpost must open the profile's shared state.db");
  const db = new Database(file, { readonly: true });
  t.after(() => db.close());
  assert.equal(db.pragma("user_version", { simple: true }), 81);
  const owner = db.prepare("SELECT * FROM app_runtime_instances WHERE process_id = ? AND exited_at IS NULL").get(h.daemon.pid);
  assert.ok(owner, "the running daemon must register its real process identity");
  assert.match(owner.instance_id, /^runtime-v2-/);
  const markers = readdirSync(path.join(state, "runtime-instances")).map(name =>
    JSON.parse(readFileSync(path.join(state, "runtime-instances", name), "utf8")));
  assert.ok(markers.some(marker => marker.instanceId === owner.instance_id
    && marker.processId === h.daemon.pid && marker.startedAt === owner.started_at));
  const leases = () => db.prepare("SELECT * FROM messaging_runtime_lease ORDER BY lease_key").all();
  assert.deepEqual(leases().map(row => [row.lease_key, row.owner_instance_id, row.status]), [
    ["profile-federation", owner.instance_id, "active"], ["profile-messaging", owner.instance_id, "active"],
  ]);
  const before = leases();
  for (let index = 0; index < 25; index++) await h.rpc("status");
  assert.deepEqual(leases(), before, "status observations must not renew PID-owned leases");
  await h.stop(h.daemon);
  assert.ok(db.prepare("SELECT exited_at FROM app_runtime_instances WHERE instance_id = ?").get(owner.instance_id).exited_at);
  assert.ok(leases().every(row => row.status === "released"));
  assert.equal(readdirSync(path.join(state, "runtime-instances")).length, 0);
  await h.start();
  assert.ok(leases().every(row => row.status === "active" && row.owner_instance_id !== owner.instance_id));
});

for (const held of ["profile-federation", "profile-messaging"]) {
  test(`a live ${held} owner refuses the real daemon before provider startup or job recovery`, async t => {
    const h = await setup(t);
    await h.submit("retained", "hello");
    await h.finished("retained");
    await h.stop(h.daemon);
    const state = path.dirname(h.directory);
    const file = path.join(state, "state.db");
    assert.ok(existsSync(file), "profile ownership must use the shared SQLite database");
    const db = new Database(file);
    t.after(() => db.close());
    const identity = { instanceId: `runtime-v2-fixture-${held}`, processId: process.pid, profileName: "t", startedAt: Date.now() };
    db.prepare("UPDATE app_runtime_instances SET instance_id = ?, process_id = ?, started_at = ?, exited_at = NULL WHERE process_id = ?")
      .run(identity.instanceId, identity.processId, identity.startedAt, h.daemon.pid);
    db.prepare("UPDATE messaging_runtime_lease SET owner_instance_id = ?, status = 'active', released_at = NULL, expires_at = ? WHERE lease_key = ?")
      .run(identity.instanceId, Number.MAX_SAFE_INTEGER, held);
    const markers = path.join(state, "runtime-instances");
    mkdirSync(markers, { recursive: true });
    writeFileSync(path.join(markers, `${process.pid}-${identity.instanceId}.json`), JSON.stringify({ ...identity, heartbeatAt: Date.now() }));
    db.prepare("UPDATE owner_jobs SET payload = json_set(payload, '$.status', 'running') WHERE job_id = ?").run("retained");
    const readJob = () => db.prepare("SELECT payload FROM owner_jobs WHERE job_id = ?").get("retained").payload;
    const priorJob = readJob();
    const priorCalls = h.calls();
    const challenger = h.launch(h.serveArgs);
    assert.equal((await challenger.done).code, 1);
    assert.match(challenger.errors, /profile.*lease.*held/i);
    assert.deepEqual(h.calls(), priorCalls, "refusal must precede even provider initialization");
    assert.equal(readJob(), priorJob, "refusal must precede restart recovery");
    assert.equal(existsSync(path.join(h.directory, "owner.lock")), false);
    assert.equal(db.prepare("SELECT owner_instance_id FROM messaging_runtime_lease WHERE lease_key = ? AND status = 'active'").get(held).owner_instance_id,
      identity.instanceId);
    assert.equal(db.prepare("SELECT count(*) AS n FROM messaging_runtime_lease WHERE owner_instance_id != ? AND status = 'active'").get(identity.instanceId).n, 0);
  });
}
