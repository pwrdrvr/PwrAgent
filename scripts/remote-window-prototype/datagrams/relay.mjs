import { MAX_BUFFERED, parsePacket } from "./protocol.mjs";

// Existing Federation RPC envelopes: no new gateway frame kind/capability.
// The ACK releases a pipeline slot after browser dispatch, not after rendering.
export const RELAY_BATCH_BYTES = 12 * 1024, RELAY_WINDOW_BYTES = 96 * 1024, RELAY_SLOTS = 8;
const byteSize = value => new TextEncoder().encode(value).length;
export function validateRelayBatch(batch, role) {
  if (!batch || !Number.isSafeInteger(batch.epoch) || batch.epoch < 1 || batch.epoch > 0xffffffff
    || !Number.isSafeInteger(batch.sequence) || batch.sequence < 1
    || !["media", "feedback", "ready", "close"].includes(batch.channel)
    || !Array.isArray(batch.items) || byteSize(JSON.stringify(batch)) > RELAY_BATCH_BYTES
    || role === "viewer" && batch.channel === "media" || role === "source" && batch.channel === "ready") throw new Error("invalid_relay_batch");
  if (batch.channel === "media") {
    if (!batch.items.length || batch.items.length > 8) throw new Error("relay_batch_count");
    for (const item of batch.items) {
      if (typeof item !== "string" || item.length > 1372 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item)) throw new Error("relay_base64");
      parsePacket(Uint8Array.from(atob(item), c => c.charCodeAt(0)), batch.epoch);
    }
  } else if (batch.channel === "feedback") {
    if (batch.items.length !== 1 || typeof batch.items[0] !== "string" || byteSize(batch.items[0]) > 4096) throw new Error("relay_feedback_size");
  } else if (batch.items.length) throw new Error("relay_control_size");
  return batch;
}

export class RelayPipe {
  constructor(epoch, role, send, failed, socketBuffered = () => 0) {
    this.epoch = epoch; this.role = role; this.send = send; this.failed = failed; this.socketBuffered = socketBuffered;
    this.sequence = 0; this.received = 0; this.pending = new Map(); this.bytes = 0; this.queue = [];
    this.active = role === "viewer"; this.closed = false;
    this.stats = { batches: 0, peakInFlight: 0, peakBytes: 0, acknowledged: 0 };
    const pipe = this;
    this.media = {
      ordered: true, maxRetransmits: null,
      get readyState() { return pipe.active && !pipe.closed ? "open" : "connecting"; },
      get bufferedAmount() { return pipe.room(true) ? pipe.socketBuffered() : MAX_BUFFERED; },
      send(data) { pipe.queue.push(btoa(String.fromCharCode(...data))); if (pipe.queue.length === 8) pipe.flush(); },
    };
    this.feedback = {
      get readyState() { return pipe.active && !pipe.closed ? "open" : "connecting"; },
      get bufferedAmount() { return pipe.room(false) ? pipe.socketBuffered() : MAX_BUFFERED; },
      send(data) { pipe.push("feedback", [data]); },
    };
  }
  room(media) {
    // Reserve two slots for manifests, budgets and stop; don't let refinements
    // monopolize this stream. Other Federation traffic can run between batches.
    return !this.closed && this.pending.size < (media ? RELAY_SLOTS - 2 : RELAY_SLOTS)
      && this.bytes + RELAY_BATCH_BYTES <= RELAY_WINDOW_BYTES && this.socketBuffered() < MAX_BUFFERED;
  }
  push(channel, items) {
    if (!this.room(channel === "media")) throw new Error("relay_backpressure");
    const batch = validateRelayBatch({ epoch: this.epoch, sequence: ++this.sequence, channel, items }, this.role);
    const bytes = byteSize(JSON.stringify(batch));
    const timer = setTimeout(() => { if (!this.closed) { this.close(false); this.failed(new Error("relay_ack_timeout")); } }, 5000);
    this.pending.set(batch.sequence, { bytes, timer }); this.bytes += bytes;
    this.stats.batches++; this.stats.peakInFlight = Math.max(this.stats.peakInFlight, this.pending.size);
    this.stats.peakBytes = Math.max(this.stats.peakBytes, this.bytes);
    this.send({ kind: "relay", batch });
  }
  flush() { if (this.queue.length) { const items = this.queue; this.queue = []; this.push("media", items); } }
  start() { this.push("ready", []); }
  ack(value) {
    if (value.epoch !== this.epoch || this.closed) return;
    const pending = this.pending.get(value.sequence); if (!pending) return;
    clearTimeout(pending.timer); this.pending.delete(value.sequence); this.bytes -= pending.bytes;
    if (value.error) { this.close(false); this.failed(new Error(value.error)); }
    else this.stats.acknowledged++;
  }
  receive(batch) {
    if (batch.epoch !== this.epoch || this.closed) return;
    validateRelayBatch(batch, this.role === "viewer" ? "source" : "viewer");
    if (batch.sequence !== this.received + 1) throw new Error("relay_sequence_gap");
    this.received = batch.sequence;
    if (batch.channel === "ready") this.active = true;
    else if (batch.channel === "close") { this.close(false); this.onclose?.(); }
    else if (batch.channel === "media") for (const item of batch.items) {
      this.media.onmessage?.({ data: Uint8Array.from(atob(item), c => c.charCodeAt(0)).buffer });
    }
    else this.feedback.onmessage?.({ data: batch.items[0] });
  }
  close(notify = true) {
    if (this.closed) return;
    if (notify && this.room(false)) this.push("close", []);
    this.closed = true; this.active = false; this.queue = [];
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear(); this.bytes = 0;
  }
}
