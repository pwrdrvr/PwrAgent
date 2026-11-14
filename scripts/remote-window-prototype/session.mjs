import { randomUUID } from "node:crypto";

// Experimental state machine only: not registered in the product runtime.
// The adapter must supply the Router-authenticated origin, never a payload owner.
export class WindowSession {
  constructor({ owner, viewer, scene, now = () => performance.now(), input = () => {} }) {
    this.owner = owner;
    this.viewer = viewer;
    this.scene = scene;
    this.now = now;
    this.input = input;
    this.id = randomUUID();
    this.epoch = 1;
    this.seq = -1;
    this.ack = -1;
    this.inputSeq = -1;
    this.control = false;
    this.closed = false;
    this.pending = null;
    this.inflight = null;
    this.dropped = 0;
    this.sent = new Map();
  }

  assertPeer(peer, epoch) {
    if (this.closed || peer !== this.viewer || epoch !== this.epoch) throw new Error("stale_or_unauthorized");
  }

  // Local consent only; never callable through a remote RPC.
  grantFixtureControl() { this.control = true; }

  publish(snapshot) {
    if (this.closed) return;
    if (!Buffer.isBuffer(snapshot) || snapshot.length > 8 * 1024 * 1024) throw new Error("snapshot_limit");
    if (this.pending) this.dropped++;
    // Self-contained snapshots are safe to replace. A delta implementation must
    // regenerate against the acknowledged base; dropping a delta is NOT safe.
    this.pending = { seq: ++this.seq, bytes: Buffer.from(snapshot) };
  }

  pull(peer, { epoch, ack = -1 }) {
    this.assertPeer(peer, epoch);
    if (!Number.isSafeInteger(ack) || ack < -1 || ack > this.seq) throw new Error("invalid_ack");
    if (this.inflight && ack === this.inflight.seq) {
      this.ack = ack;
      this.inflight = null;
    }
    if (!this.inflight && this.pending) {
      this.inflight = this.pending;
      this.pending = null;
      this.sent.set(this.inflight.seq, this.now());
      while (this.sent.size > 8) this.sent.delete(this.sent.keys().next().value);
    }
    return this.inflight ? {
      sessionId: this.id, owner: this.owner, scene: this.scene, epoch: this.epoch,
      seq: this.inflight.seq, keyframe: true, bytes: this.inflight.bytes,
    } : null;
  }

  acceptInput(peer, command) {
    this.assertPeer(peer, command.epoch);
    const displayedAt = this.sent.get(command.displayedSeq);
    if (!this.control || command.sessionId !== this.id || command.scene !== this.scene
      || command.action !== "fixture-toggle" || !Number.isSafeInteger(command.inputSeq)
      || command.inputSeq <= this.inputSeq || displayedAt === undefined
      || this.now() - displayedAt > 1000 || command.displayedSeq !== this.ack) throw new Error("input_rejected");
    this.inputSeq = command.inputSeq;
    this.input();
    return { accepted: true, inputSeq: command.inputSeq };
  }

  reconnect(peer) {
    this.assertPeer(peer, this.epoch);
    this.epoch++;
    this.seq = this.ack = this.inputSeq = -1;
    this.pending = this.inflight = null;
    this.sent.clear();
    this.control = false;
  }

  revoke() {
    this.closed = true;
    this.control = false;
    this.pending = this.inflight = null;
    this.sent.clear();
  }
}

// Deterministic fair queue prototype: one bounded quantum per stream each turn.
// Never enqueue a full media frame into the product's shared socket at once.
export class FairQueue {
  constructor(quantum = 16384, cap = 1048576) {
    this.quantum = quantum;
    this.cap = cap;
    this.queues = new Map();
    this.cursor = 0;
    this.bytes = 0;
    this.items = 0;
  }
  enqueue(id, bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || this.bytes + bytes.length > this.cap
      || this.items >= 64 || (!this.queues.has(id) && this.queues.size >= 8)) return false;
    const q = this.queues.get(id) ?? [];
    q.push(Buffer.from(bytes));
    this.queues.set(id, q);
    this.bytes += bytes.length;
    this.items++;
    return true;
  }
  take() {
    const ids = [...this.queues.keys()];
    if (!ids.length) return null;
    const id = ids[this.cursor++ % ids.length], q = this.queues.get(id), b = q[0];
    const chunk = b.subarray(0, this.quantum);
    if (chunk.length === b.length) { q.shift(); this.items--; }
    else q[0] = b.subarray(chunk.length);
    if (!q.length) this.queues.delete(id);
    this.bytes -= chunk.length;
    return { id, chunk };
  }
}
