import { describe, it, expect } from "vitest";
import { TileReceiver, TileSender, TILES, PAYLOAD, MAX_ASSEMBLY, packet, previewBody, webpDimensions } from "./protocol.mjs";

// Header-only synthetic WebP for parser/protocol tests; real codec decoding is tested in the browser harness.
function webp(width = 64, height = 64, size = 2600) {
  const out = new Uint8Array(size), view = new DataView(out.buffer);
  for (const [offset, tag] of [[0, "RIFF"], [8, "WEBP"], [12, "VP8L"]]) out.set(new TextEncoder().encode(tag), offset);
  view.setUint32(4, size - 8, true); view.setUint32(16, size - 20, true); out[20] = 0x2f;
  view.setUint32(21, width - 1 | (height - 1) << 14, true); return out;
}
const versions = n => Array(TILES).fill(n);
const tile = (id = 0, version = 1) => ({ kind: 2, id, version, data: webp() });
const packets = item => Array.from({ length: Math.ceil(item.data.length / PAYLOAD) }, (_, i) => packet(9, item, i));
function complete(receiver, image) { let result; for (const p of packets(image)) result = receiver.accept(p) ?? result; return result; }

describe("push tile protocol", () => {
  it("does not block independent tiles behind a missing fragment, and repairs only the incomplete tile", () => {
    const receiver = new TileReceiver(9); receiver.manifest(versions(1));
    const broken = packets(tile()); receiver.accept(broken[0]); receiver.accept(broken[2]);
    const intact = complete(receiver, tile(1)); expect(intact.id).toBe(1);
    receiver.presentedImage(intact, 1);
    expect(receiver.missing()).toContainEqual({ id: 0, have: 0 });
    expect(receiver.missing()).not.toContainEqual({ id: 1, have: 0 });
    expect(receiver.accept(broken[1]).id).toBe(0);
  });
  it("accepts reordering and duplicates without counting duplicate bytes twice", () => {
    const receiver = new TileReceiver(9), p = packets(tile());
    receiver.accept(p[2]); receiver.accept(p[2]); receiver.accept(p[0]);
    expect(receiver.bytes).toBe(2600); expect(receiver.accept(p[1]).data).toEqual(webp()); expect(receiver.bytes).toBe(0);
  });
  it("fences old epochs and tiles that finish decoding after newer damage", () => {
    const receiver = new TileReceiver(9), image = complete(receiver, tile());
    receiver.manifest(versions(2)); expect(receiver.canPresent(image, 0)).toBe(false);
    expect(() => receiver.accept(packet(8, tile(), 0))).toThrow("wrong_epoch");
    expect(complete(receiver, tile())).toBeUndefined();
  });
  it("allows a delayed preview while newer damage is in flight, but never overwrites a newer drawn region", () => {
    const receiver = new TileReceiver(9); receiver.manifest(versions(3));
    const preview = complete(receiver, { kind: 1, id: 65535, version: 2, data: previewBody(webp(200, 137), versions(2)) });
    expect(receiver.presentedImage(preview, 0)).toBe(true);
    expect(receiver.canPresent(preview, 0)).toBe(false);
    const fine = complete(receiver, tile(0, 3)); receiver.presentedImage(fine, 0);
    expect(receiver.canPresent(preview, 0)).toBe(false);
  });
  it("bounds and expires incomplete assemblies even with many overlapping image versions", () => {
    let now = 0; const receiver = new TileReceiver(9, () => now);
    for (let id = 0; id < TILES; id++) receiver.accept(packet(9, { ...tile(id), data: webp(64, 64, 32000) }, 0));
    expect(receiver.bytes).toBeLessThanOrEqual(MAX_ASSEMBLY); expect(receiver.assemblies.size).toBeLessThanOrEqual(32);
    expect(receiver.stats.evicted).toBeGreaterThan(0); now = 251; receiver.expire(); expect(receiver.bytes).toBe(0);
  });
  it("rejects dangerous decoded dimensions, animation, and malformed fragment sizes before decoding", () => {
    expect(() => webpDimensions(webp(4096, 2048))).toThrow("dimensions");
    const animation = webp(); animation.set(new TextEncoder().encode("ANIM"), 12);
    expect(() => webpDimensions(animation)).toThrow("unsupported");
    const receiver = new TileReceiver(9), wrong = packet(9, tile(), 0); new DataView(wrong.buffer).setUint32(20, 0xffffffff);
    expect(() => receiver.accept(wrong)).toThrow("invalid_fragment"); expect(receiver.bytes).toBe(0);
    expect(() => complete(receiver, { ...tile(), data: webp(800, 548) })).toThrow("geometry");
  });
  it("cancels pending refinements on movement and pushes preview first without an image request", () => {
    let now = 0; const sender = new TileSender(9, { now: () => now });
    sender.manifest({ generation: 1, versions: versions(1), preview: false }); sender.image({ ...tile(), imageKind: 2 });
    sender.manifest({ generation: 2, versions: versions(2), preview: true });
    expect(sender.pending.size).toBe(0); expect(sender.stats.cancelledRefinements).toBe(1);
    sender.image({ imageKind: 1, id: 65535, version: 2, versions: versions(2), data: webp(200, 137) });
    const sent = []; const channel = { readyState: "open", bufferedAmount: 0, send: bytes => sent.push(bytes) };
    sender.pump(channel); expect(sent).toHaveLength(0); // No initial receiver allowance.
    sender.budget({ sequence: 1, bytes: 65536 }); sender.pump(channel);
    expect(sent.length).toBeGreaterThan(0); expect(new DataView(sent[0].buffer).getUint16(18)).toBe(1);
    now = 300; sender.image({ ...tile(1, 2), imageKind: 2 });
    const count = sent.length; sender.pump(channel); expect(sent).toHaveLength(count); // Lease expired.
    sender.budget({ sequence: 2, bytes: 65536 }); sender.pump(channel); expect(sent.length).toBeGreaterThan(count);
  });
  it("repairs current tile versions, rejects regressive manifests and stale receive allowances", () => {
    const sender = new TileSender(9); sender.manifest({ generation: 2, versions: versions(2) });
    sender.image({ ...tile(0, 2), imageKind: 2 }); sender.pending.clear();
    sender.repair([{ id: 0, have: 0 }]); expect(sender.pending.get(0).version).toBe(2);
    expect(() => sender.manifest({ generation: 3, versions: versions(1) })).toThrow("manifest");
    sender.budget({ sequence: 1, bytes: 500 });
    expect(() => sender.budget({ sequence: 1, bytes: 65536 })).toThrow("budget");
    expect(() => sender.repair(Array(17).fill({ id: 0, have: 0 }))).toThrow("budget");
  });
});
