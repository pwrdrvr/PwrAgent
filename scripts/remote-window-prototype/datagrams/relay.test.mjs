import { expect, test, vi } from "vitest";
import { packet, MAX_BUFFERED, TileSender, TILES } from "./protocol.mjs";
import { RelayPipe, RELAY_WINDOW_BYTES, validateRelayBatch } from "./relay.mjs";

const fragment = (version = 1) => packet(7, { kind: 2, id: 0, version, data: new Uint8Array(1000) }, 0);
function source() {
  const sent = [], failed = vi.fn();
  const pipe = new RelayPipe(7, "source", m => sent.push(m.batch), failed);
  pipe.receive({ epoch: 7, sequence: 1, channel: "ready", items: [] });
  return { pipe, sent, failed };
}
test("pipelines six media batches without round trips, reserves control slots, and bounds stalled receivers", () => {
  const { pipe, sent } = source();
  try {
    for (let batch = 0; batch < 6; batch++) for (let i = 0; i < 8; i++) pipe.media.send(fragment());
    expect(sent).toHaveLength(6);
    expect(pipe.media.bufferedAmount).toBe(MAX_BUFFERED);
    pipe.feedback.send("manifest"); pipe.feedback.send("stop-or-budget");
    expect(pipe.feedback.bufferedAmount).toBe(MAX_BUFFERED);
    expect(pipe.stats.peakInFlight).toBe(8);
    expect(pipe.bytes).toBeLessThanOrEqual(RELAY_WINDOW_BYTES);
    expect(() => pipe.feedback.send("overflow")).toThrow("relay_backpressure");
    for (const batch of sent) pipe.ack(batch);
    expect(pipe.media.bufferedAmount).toBe(0);
    expect(pipe.bytes).toBe(0);
  } finally { pipe.close(false); }
});
test("a new damage generation cancels unsent refinements while a relay is congested", () => {
  const { pipe, sent } = source();
  try {
    let time = 1000;
    const sender = new TileSender(7, { now: () => time });
    sender.manifest({ generation: 1, versions: Array(TILES).fill(1) });
    sender.image({ imageKind: 2, id: 0, version: 1, data: new Uint8Array(32000) });
    sender.budget({ sequence: 1, bytes: MAX_BUFFERED });
    sender.pump(pipe.media); pipe.flush();
    expect(sender.pending.size).toBe(1);
    sender.manifest({ generation: 2, versions: Array(TILES).fill(2), preview: true });
    time += 150; sender.pump(pipe.media); pipe.flush();
    expect(sender.pending.size).toBe(0);
    expect(sender.stats.cancelledRefinements).toBe(1);
    expect(sent).toHaveLength(1); // Only the bounded already-sent prefix remains.
  } finally { pipe.close(false); }
});
test("relay epochs fence stale batches and ACKs; missing sequences fail closed", () => {
  const received = vi.fn(), pipe = new RelayPipe(7, "viewer", () => {}, vi.fn());
  pipe.media.onmessage = received;
  const body = btoa(String.fromCharCode(...fragment()));
  try {
    pipe.start(); pipe.ack({ epoch: 6, sequence: 1 }); expect(pipe.pending.size).toBe(1);
    pipe.receive({ epoch: 6, sequence: 1, channel: "media", items: [body] });
    expect(received).not.toHaveBeenCalled();
    pipe.receive({ epoch: 7, sequence: 1, channel: "media", items: [body] });
    expect(received).toHaveBeenCalledTimes(1);
    expect(() => pipe.receive({ epoch: 7, sequence: 3, channel: "media", items: [body] })).toThrow("relay_sequence_gap");
    expect(() => validateRelayBatch({ epoch: 7, sequence: 1, channel: "media", items: [body] }, "viewer")).toThrow();
    expect(() => validateRelayBatch({ epoch: 7, sequence: 1, channel: "media", items: Array(9).fill(body) }, "source")).toThrow();
    expect(() => validateRelayBatch({ epoch: 7, sequence: 1, channel: "feedback", items: ["é".repeat(3000)] }, "source")).toThrow("relay_feedback_size");
  } finally { pipe.close(false); }
});
test("lost browser ACK closes the bounded session instead of accumulating or retrying images", () => {
  vi.useFakeTimers(); const { pipe, failed } = source();
  try {
    pipe.media.send(fragment()); pipe.flush();
    vi.advanceTimersByTime(5000);
    expect(pipe.closed).toBe(true); expect(pipe.pending.size).toBe(0);
    expect(failed).toHaveBeenCalledTimes(1);
  } finally { pipe.close(false); vi.useRealTimers(); }
});
