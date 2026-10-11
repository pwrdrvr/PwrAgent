import { randomUUID } from "node:crypto";

export const CHUNK_BYTES = 16 * 1024;
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const METHODS = ["open", "pull", "ack", "input", "close", "ping"];

// Independent prototype protocol. No service tunnel or terminal transport.
// Adapter passes a Router-verified peer identity; payload identities grant nothing.
export class LiveWindowSession {
  constructor({ owner, viewer, source, control = false, now = () => performance.now() }) {
    Object.assign(this, { owner, viewer, source, now });
    this.initialControl = control;
    this.epoch = 0;
    this.seq = 0;
    this.metrics = { frames: 0, mediaBytes: 0, inputs: 0 };
    this.current = null;
    this.frame = null;
    this.waiter = null;
    this.requested = false;
    this.stopped = false;
    source.onFrame = frame => this.publish(frame);
    source.onStop = () => this.revoke();
  }
  open(peer) {
    if (peer !== this.viewer || this.stopped) throw new Error("not_authorized");
    this.disconnect();
    this.current = { sessionId: randomUUID(), epoch: ++this.epoch, scene: "owned-fixture",
      owner: this.owner, viewer: peer, width: 800, height: 548, control: this.epoch === 1 && this.initialControl };
    this.ackSeq = -1;
    this.inputSeq = -1;
    this.sentOffset = 0;
    this.lastPull = this.now();
    this.nonce = randomUUID();
    this.nonces = new Map([[this.nonce, this.now()]]);
    this.acknowledged = new Set();
    this.requested = true;
    this.requestId = randomUUID();
    this.source.next(true, this.requestId);
    return { ...this.current, protocol: "window.prototype.v1", chunkBytes: CHUNK_BYTES };
  }
  check(peer, p) {
    if (!this.current || this.stopped || peer !== this.viewer || p?.sessionId !== this.current.sessionId
      || p?.epoch !== this.current.epoch || p?.scene !== this.current.scene) throw new Error("stale_or_unauthorized");
  }
  publish(value) {
    if (!this.current || !this.requested || this.stopped || value.requestId !== this.requestId) return;
    this.requested = false;
    const bytes = Buffer.from(value.data, "base64");
    if (!bytes.length || bytes.length > MAX_FRAME_BYTES || value.width !== 800 || value.height !== 548
      || !["h264", "png"].includes(value.format) || (this.ackSeq === -1 && (!value.key || value.format !== "h264"))) { this.revoke(); return; }
    // One encode credit and one immutable frame; never drop a codec dependency.
    this.frame = { ...value, data: undefined, bytes, seq: this.seq++, epoch: this.current.epoch };
    this.sentOffset = 0;
    this.metrics.frames++;
    this.metrics.mediaBytes += bytes.length;
    this.waiter?.();
  }
  async pull(peer, p) {
    this.check(peer, p);
    if (!Number.isSafeInteger(p.offset) || p.offset < 0) throw new Error("invalid_offset");
    if (this.waiter) throw new Error("concurrent_pull");
    if (!this.frame) {
      if (p.offset !== 0) throw new Error("invalid_offset");
      if (!this.requested) { this.requested = true; this.requestId = randomUUID(); this.source.next(false, this.requestId); }
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); this.waiter = null; resolve(); };
        const timer = setTimeout(finish, 400);
        this.waiter = finish;
      });
      this.check(peer, p);
    }
    this.lastPull = this.now();
    this.nonce = randomUUID();
    this.nonces.set(this.nonce, this.now());
    while (this.nonces.size > 8) this.nonces.delete(this.nonces.keys().next().value);
    if (!this.frame) return { idle: true, paused: this.source.available === false, nonce: this.nonce, epoch: this.current.epoch };
    if (p.offset !== this.sentOffset) throw new Error("invalid_offset");
    const f = this.frame;
    const data = f.bytes.subarray(p.offset, p.offset + CHUNK_BYTES);
    this.sentOffset += data.length;
    return { sessionId: this.current.sessionId, epoch: f.epoch, seq: f.seq,
      offset: p.offset, total: f.bytes.length, data: data.toString("base64"),
      key: f.key, codec: f.codec, format: f.format, captureMs: f.captureMs, encodeMs: f.encodeMs,
      width: 800, height: 548, nonce: this.nonce };
  }
  ack(peer, p) {
    this.check(peer, p);
    if (!this.frame || p.seq !== this.frame.seq || this.sentOffset !== this.frame.bytes.length) throw new Error("invalid_ack");
    this.ackSeq = p.seq;
    this.acknowledged.add(p.seq);
    while (this.acknowledged.size > 8) this.acknowledged.delete(this.acknowledged.values().next().value);
    this.frame = null;
    return { ack: p.seq };
  }
  async input(peer, p) {
    this.check(peer, p);
    if (this.source.available === false || !this.current.control || !this.acknowledged.has(p.displayedSeq) || this.ackSeq < 0
      || !this.nonces.has(p.nonce) || this.now() - this.nonces.get(p.nonce) > 1200
      || p.inputSeq !== this.inputSeq + 1) throw new Error("input_rejected");
    const c = p.command;
    if (!c || !validCommand(c)) throw new Error("invalid_command");
    this.inputSeq = p.inputSeq;
    this.metrics.inputs++;
    return this.source.input(c);
  }
  disconnect() {
    this.current = null; this.frame = null; this.requested = false;
    this.waiter?.();
  }
  revoke() { this.stopped = true; this.disconnect(); }
  handle(peer, method, p) {
    if (method === "open") return this.open(peer);
    this.check(peer, p);
    if (method === "pull") return this.pull(peer, p);
    if (method === "ack") return this.ack(peer, p);
    if (method === "input") return this.input(peer, p);
    if (method === "ping") return { alive: true };
    if (method === "close") { this.disconnect(); return { closed: true }; }
    throw new Error("method_not_found");
  }
}
function validCommand(c) {
  if (c.action === "text") return typeof c.text === "string" && Buffer.byteLength(c.text) > 0
    && Buffer.byteLength(c.text) <= 128 && !/[\x00-\x1f\x7f]/.test(c.text);
  if (c.action === "key") return c.key === "Backspace";
  if (c.action === "click") return [c.x, c.y].every(x => Number.isFinite(x) && x >= 0 && x <= 1);
  if (c.action === "scroll") return Number.isSafeInteger(c.lines) && Math.abs(c.lines) <= 20;
  if (c.action === "motion") return typeof c.enabled === "boolean";
  return false;
}
