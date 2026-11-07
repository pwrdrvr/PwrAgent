import { test } from "vitest";
import assert from "node:assert/strict";
import { WindowSession, FairQueue } from "./session.mjs";

function setup() {
  let now = 0, inputs = 0;
  const s = new WindowSession({ owner: "source", viewer: "viewer", scene: "fixture", now: () => now, input: () => inputs++ });
  return { s, advance: ms => now += ms, inputs: () => inputs };
}

test("authenticated origin, revocation, epoch and replay fences", () => {
  const { s, inputs, advance } = setup();
  s.publish(Buffer.from("frame0"));
  assert.throws(() => s.pull("other", { epoch: 1 }), /unauthorized/);
  const frame = s.pull("viewer", { epoch: 1 });
  s.pull("viewer", { epoch: 1, ack: frame.seq });
  const command = { sessionId: s.id, scene: "fixture", epoch: 1, displayedSeq: 0, inputSeq: 0, action: "fixture-toggle" };
  assert.throws(() => s.acceptInput("viewer", command), /input_rejected/);
  s.grantFixtureControl();
  s.acceptInput("viewer", command);
  assert.equal(inputs(), 1);
  assert.throws(() => s.acceptInput("viewer", command), /input_rejected/);
  advance(1001);
  assert.throws(() => s.acceptInput("viewer", { ...command, inputSeq: 1 }), /input_rejected/);
  s.reconnect("viewer");
  assert.throws(() => s.acceptInput("viewer", command), /unauthorized/);
  assert.equal(s.control, false);
  s.revoke();
  assert.throws(() => s.pull("viewer", { epoch: 2 }), /unauthorized/);
});

test("slow viewer retains one immutable inflight plus latest snapshot", () => {
  const { s } = setup();
  s.publish(Buffer.from("zero"));
  assert.equal(s.pull("viewer", { epoch: 1 }).seq, 0);
  for (let i = 1; i < 100; i++) s.publish(Buffer.from(String(i)));
  assert.equal(s.dropped, 98);
  assert.equal(s.pull("viewer", { epoch: 1 }).seq, 0);
  const latest = s.pull("viewer", { epoch: 1, ack: 0 });
  assert.equal(latest.seq, 99);
  assert.equal(latest.bytes.toString(), "99");
  assert.equal(latest.keyframe, true);
  assert.throws(() => s.pull("viewer", { epoch: 1, ack: 101 }), /invalid_ack/);
});

test("media cannot hide small event behind full frame; queue memory is bounded", () => {
  const q = new FairQueue();
  assert.equal(q.enqueue("media", Buffer.alloc(500000)), true);
  assert.equal(q.enqueue("events", Buffer.from("turn")), true);
  assert.equal(q.enqueue("media2", Buffer.alloc(600000)), false);
  const first = q.take(), second = q.take();
  assert.equal(first.chunk.length, 16384);
  assert.equal(second.id, "events");
  assert.equal(second.chunk.toString(), "turn");
});


test("queue caps also bound metadata and empty payload attacks", () => {
  const q = new FairQueue();
  assert.equal(q.enqueue("empty", Buffer.alloc(0)), false);
  for (let i = 0; i < 8; i++) assert.equal(q.enqueue(String(i), Buffer.from("x")), true);
  assert.equal(q.enqueue("ninth", Buffer.from("x")), false);
  for (let i = 8; i < 64; i++) assert.equal(q.enqueue("0", Buffer.from("x")), true);
  assert.equal(q.enqueue("0", Buffer.from("x")), false);
});
