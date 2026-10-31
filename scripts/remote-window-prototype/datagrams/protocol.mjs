// Experimental fixed-geometry fixture protocol. Fragments can use either the
// Federation RPC push pipeline or unordered, zero-retransmit RTCDataChannels.
export const WIDTH = 800, HEIGHT = 548, EDGE = 64, COLS = 13, TILES = 117;
export const HEADER = 28, PAYLOAD = 1000, MAX_IMAGE = 132000, MAX_TILE = 32768;
export const MAX_ASSEMBLY = 512 * 1024, MAX_BUFFERED = 64 * 1024;
const MAGIC = 0x50574431;
export const geometry = id => ({ x: id % COLS * EDGE, y: Math.floor(id / COLS) * EDGE,
  width: Math.min(EDGE, WIDTH - id % COLS * EDGE), height: Math.min(EDGE, HEIGHT - Math.floor(id / COLS) * EDGE) });
export function validVersions(v) { return Array.isArray(v) && v.length === TILES && v.every(n => Number.isSafeInteger(n) && n > 0 && n <= 0x7fffffff); }
export function previewBody(data, versions) {
  if (!validVersions(versions)) throw new Error("invalid_versions");
  const out = new Uint8Array(TILES * 4 + data.length), view = new DataView(out.buffer);
  versions.forEach((v, i) => view.setUint32(i * 4, v)); out.set(data, TILES * 4); return out;
}
export function packet(epoch, item, part) {
  const count = Math.ceil(item.data.length / PAYLOAD), payload = item.data.subarray(part * PAYLOAD, (part + 1) * PAYLOAD);
  const out = new Uint8Array(HEADER + payload.length), v = new DataView(out.buffer);
  v.setUint32(0, MAGIC); v.setUint32(4, epoch); v.setUint32(8, item.version);
  v.setUint16(12, item.id); v.setUint16(14, part); v.setUint16(16, count);
  v.setUint16(18, item.kind); v.setUint32(20, item.data.length); v.setUint32(24, 0);
  out.set(payload, HEADER); return out;
}
export function parsePacket(raw, epoch) {
  const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (data.length <= HEADER || data.length > HEADER + PAYLOAD) throw new Error("invalid_datagram_size");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (v.getUint32(0) !== MAGIC || v.getUint32(4) !== epoch || v.getUint32(24) !== 0) throw new Error("wrong_epoch_or_header");
  const version = v.getUint32(8), id = v.getUint16(12), part = v.getUint16(14), count = v.getUint16(16), kind = v.getUint16(18), size = v.getUint32(20);
  if (!version || version > 0x7fffffff || ![1, 2].includes(kind) || (kind === 1 ? id !== 65535 : id >= TILES)
    || !size || size > (kind === 1 ? MAX_IMAGE : MAX_TILE) || count !== Math.ceil(size / PAYLOAD)
    || part >= count || data.length - HEADER !== Math.min(PAYLOAD, size - part * PAYLOAD)) throw new Error("invalid_fragment");
  return { version, id, part, count, kind, size, data: data.subarray(HEADER) };
}

// Validate both canvas and compressed image dimensions before browser decoding.
// Animated WebP and multiple coded images are deliberately unsupported.
export function webpDimensions(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = i => String.fromCharCode(...b.subarray(i, i + 4));
  const u24 = i => b[i] | b[i+1] << 8 | b[i+2] << 16;
  if (b.length < 26 || b.length > MAX_IMAGE || tag(0) !== "RIFF" || tag(8) !== "WEBP" || v.getUint32(4, true) + 8 !== b.length) throw new Error("invalid_webp");
  let canvas, coded, chunks = 0;
  for (let i = 12; i < b.length;) {
    if (++chunks > 8 || i + 8 > b.length) throw new Error("invalid_webp_chunk");
    const n = v.getUint32(i + 4, true), start = i + 8, end = start + n;
    if (end + (n & 1) > b.length) throw new Error("invalid_webp_chunk");
    const type = tag(i);
    if (type === "VP8X") {
      if (canvas || n !== 10 || b[start] & 2) throw new Error("animated_or_invalid_webp");
      canvas = { width: u24(start + 4) + 1, height: u24(start + 7) + 1 };
    } else if (type === "VP8L") {
      if (coded || n < 5 || b[start] !== 0x2f) throw new Error("invalid_webp_lossless");
      const bits = v.getUint32(start + 1, true);
      if (bits >>> 29) throw new Error("invalid_webp_version");
      coded = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    } else if (type === "VP8 ") {
      if (coded || n < 10 || b[start] & 1 || b[start+3] !== 0x9d || b[start+4] !== 1 || b[start+5] !== 0x2a) throw new Error("invalid_webp_lossy");
      coded = { width: v.getUint16(start + 6, true) & 0x3fff, height: v.getUint16(start + 8, true) & 0x3fff };
    } else if (type !== "ALPH") throw new Error("unsupported_webp_chunk");
    i = end + (n & 1);
  }
  if (!coded || coded.width <= 0 || coded.height <= 0 || coded.width > WIDTH || coded.height > HEIGHT
    || canvas && (canvas.width !== coded.width || canvas.height !== coded.height)) throw new Error("invalid_webp_dimensions");
  return coded;
}

export class TileReceiver {
  constructor(epoch, now = () => performance.now()) {
    this.epoch = epoch; this.now = now; this.assemblies = new Map(); this.bytes = 0;
    this.wanted = Array(TILES).fill(0); this.presented = Array(TILES).fill(0);
    this.coarse = Array(TILES).fill(0); this.previewVersion = 0;
    this.stats = { received: 0, stale: 0, expired: 0, evicted: 0, peakBytes: 0 };
  }
  manifest(versions) {
    if (!validVersions(versions)) throw new Error("invalid_manifest");
    versions.forEach((v, i) => { this.wanted[i] = Math.max(this.wanted[i], v); });
    for (const [key, a] of this.assemblies) if (a.kind === 2 && a.version < this.wanted[a.id]) this.remove(key);
  }
  remove(key) { const a = this.assemblies.get(key); if (a) { this.bytes -= a.size; this.assemblies.delete(key); } }
  expire() {
    for (const [key, a] of this.assemblies) if (this.now() - a.at > 250) { this.remove(key); this.stats.expired++; }
  }
  accept(raw) {
    const p = parsePacket(raw, this.epoch); this.stats.received++; this.expire();
    if (p.kind === 2 && (p.version < this.wanted[p.id] || p.version <= this.presented[p.id])
      || p.kind === 1 && p.version < this.previewVersion) { this.stats.stale++; return; }
    if (p.kind === 1 && p.version > this.previewVersion) {
      this.previewVersion = p.version;
      for (const [key, a] of this.assemblies) if (a.kind === 1) this.remove(key);
    }
    const key = `${p.kind}:${p.id}:${p.version}`;
    let a = this.assemblies.get(key);
    if (!a) {
      while (this.bytes + p.size > MAX_ASSEMBLY || this.assemblies.size >= 32) { this.remove(this.assemblies.keys().next().value); this.stats.evicted++; }
      a = { ...p, data: new Uint8Array(p.size), parts: new Set(), at: this.now() };
      this.assemblies.set(key, a); this.bytes += p.size; this.stats.peakBytes = Math.max(this.stats.peakBytes, this.bytes);
    }
    if (a.size !== p.size || a.count !== p.count) throw new Error("fragment_changed_shape");
    if (!a.parts.has(p.part)) { a.data.set(p.data, p.part * PAYLOAD); a.parts.add(p.part); }
    if (a.parts.size !== a.count) return;
    this.remove(key);
    let versions;
    if (p.kind === 1) {
      if (a.data.length <= TILES * 4) throw new Error("short_preview");
      const view = new DataView(a.data.buffer);
      versions = Array.from({ length: TILES }, (_, i) => view.getUint32(i * 4));
      if (!validVersions(versions) || versions.some(v => v > p.version)) throw new Error("invalid_preview_versions");
      this.manifest(versions); a.data = a.data.slice(TILES * 4);
    } else { this.wanted[p.id] = Math.max(this.wanted[p.id], p.version); }
    const dimensions = webpDimensions(a.data), expected = p.kind === 1 ? { width: 200, height: 137 } : geometry(p.id);
    if (dimensions.width !== expected.width || dimensions.height !== expected.height) throw new Error("image_geometry_mismatch");
    return { ...p, data: a.data, versions, dimensions };
  }
  // Called after decode, immediately before drawing: late completions cannot roll back pixels.
  canPresent(image, id) {
    return image.kind === 2 ? image.version >= this.wanted[id] && image.version > this.presented[id]
      : image.versions[id] > this.presented[id] && image.versions[id] > this.coarse[id];
  }
  presentedImage(image, id) {
    if (!this.canPresent(image, id)) return false;
    if (image.kind === 2) this.presented[id] = image.version;
    else this.coarse[id] = image.versions[id];
    return true;
  }
  missing(limit = 16) {
    return this.wanted.flatMap((v, id) => v > this.presented[id] ? [{ id, have: this.presented[id] }] : []).slice(0, limit);
  }
}

export class TileSender {
  constructor(epoch, { now = () => performance.now(), bytesPerSecond = 1250000 } = {}) {
    this.epoch = epoch; this.now = now; this.rate = bytesPerSecond; this.lastTick = now(); this.tokens = PAYLOAD * 4;
    this.cache = new Map(); this.pending = new Map(); this.wanted = Array(TILES).fill(0); this.generation = 0; this.quietUntil = 0;
    this.credit = 0; this.creditSequence = 0; this.creditUntil = 0;
    this.stats = { sentBytes: 0, packets: 0, cancelled: 0, cancelledPreviews: 0, cancelledRefinements: 0, repairs: 0, peakQueuedBytes: 0 };
  }
  manifest(m) {
    if (!Number.isSafeInteger(m.generation) || m.generation <= this.generation || !validVersions(m.versions)
      || m.versions.some((v, i) => v > m.generation || v < this.wanted[i])) throw new Error("invalid_source_manifest");
    this.generation = m.generation; this.wanted = [...m.versions];
    for (const [id, p] of this.pending) if (id === 65535 || m.preview || p.version < this.wanted[id]) {
      this.pending.delete(id); this.stats.cancelled++;
      if (p.kind === 1) this.stats.cancelledPreviews++; else this.stats.cancelledRefinements++;
    }
    if (m.preview) this.quietUntil = this.now() + 120;
  }
  image({ imageKind: kind, id, version, data, versions }) {
    if (!(data instanceof Uint8Array) || !data.length || data.length > (kind === 1 ? 131072 : MAX_TILE)
      || ![1, 2].includes(kind) || !Number.isSafeInteger(version) || version < 1
      || (kind === 1 ? id !== 65535 || version !== this.generation : !Number.isSafeInteger(id) || id < 0 || id >= TILES || version !== this.wanted[id])) return false;
    const item = { kind, id, version, data: kind === 1 ? previewBody(data, versions) : data, part: 0 };
    this.cache.set(id, item); this.pending.set(id, { ...item });
    this.stats.peakQueuedBytes = Math.max(this.stats.peakQueuedBytes, [...this.pending.values()].reduce((n, x) => n + x.data.length, 0));
    return true;
  }
  repair(requests) {
    if (!Array.isArray(requests) || requests.length > 16) throw new Error("repair_budget");
    for (const { id, have } of requests) {
      if (!Number.isSafeInteger(id) || id < 0 || id >= TILES || !Number.isSafeInteger(have) || have < 0) throw new Error("invalid_repair");
      const current = this.cache.get(id);
      if (current && current.version === this.wanted[id] && current.version > have && !this.pending.has(id)) {
        this.pending.set(id, { ...current, part: 0 }); this.stats.repairs++;
      }
    }
  }
  budget({ sequence, bytes }) {
    if (!Number.isSafeInteger(sequence) || sequence <= this.creditSequence || !Number.isSafeInteger(bytes)
      || bytes < 0 || bytes > MAX_BUFFERED) throw new Error("invalid_receive_budget");
    // Replacement allowance, not accumulated ACK credits: lost packets cannot deadlock it.
    this.creditSequence = sequence; this.credit = bytes; this.creditUntil = this.now() + 250;
  }
  pump(channel) {
    const now = this.now();
    this.tokens = Math.min(PAYLOAD * 8, this.tokens + Math.max(0, now - this.lastTick) * this.rate / 1000); this.lastTick = now;
    for (let quantum = 0; quantum < 8 && now < this.creditUntil && channel.readyState === "open" && channel.bufferedAmount < MAX_BUFFERED; quantum++) {
      const item = this.pending.get(65535) ?? (now >= this.quietUntil ? this.pending.values().next().value : undefined);
      if (!item) break;
      const bytes = packet(this.epoch, item, item.part);
      if (this.tokens < bytes.length || this.credit < bytes.length) break;
      channel.send(bytes); this.tokens -= bytes.length; this.credit -= bytes.length; this.stats.sentBytes += bytes.length; this.stats.packets++;
      if (++item.part === Math.ceil(item.data.length / PAYLOAD)) this.pending.delete(item.id);
    }
  }
}
