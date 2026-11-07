import { TileSender, TileReceiver, geometry, TILES, MAX_BUFFERED } from "./protocol.mjs";
import { RelayPipe } from "./relay.mjs";

const role = document.body.dataset.role, token = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
const status = document.querySelector("#status"), canvas = document.querySelector("canvas"), context = canvas?.getContext("2d");
const socket = new WebSocket(`${location.origin.replace("http", "ws")}/socket/${role}`);
let ready = false, nativeReady = false, pc, media, feedback, sender, receiver, pendingOffer;
let transport = "federation", relay;
let lastSourceManifestAt = null;
let connection = 0, epoch = 0, budgetSequence = 0, lastRepair = 0, lastManifestAt = null, manifestEpoch = 0, manifest, manifestSent = 0;
const nativeCache = new Map(), decodeQueue = new Map(), delayed = new Map();
const fixtureAcks = [];
let decoding = 0, delayedBytes = 0, delayId = 0, seed = 1;
let faults = { loss: 0, delayMs: 0, jitterMs: 0 };
const metrics = { started: performance.now(), packets: 0, mediaBytes: 0, dropped: 0, previews: 0, tiles: 0,
  feedbackSentBytes: 0, feedbackReceivedBytes: 0, fixtureRevision: 0,
  staleDecode: 0, peakDecodeQueueBytes: 0, peakDelayedBytes: 0, decodeMs: [], presentations: [], errors: [] };
const note = text => { status.textContent = text; };
const error = value => { const message = String(value); if (metrics.errors.length < 20) metrics.errors.push(message); note(message); };
const sendLocal = value => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
const sendFeedback = value => { const text = JSON.stringify(value); feedback.send(text); metrics.feedbackSentBytes += text.length; };
function close() {
  relay?.close(); relay = undefined;
  connection++; pc?.close(); pc = media = feedback = sender = receiver = undefined;
  pendingOffer?.reject(new Error("connection_closed")); pendingOffer = undefined;
  decodeQueue.clear(); for (const timer of delayed.values()) clearTimeout(timer); delayed.clear(); delayedBytes = 0;
  manifestSent = 0; budgetSequence = 0; manifestEpoch = 0; lastManifestAt = null; note("Stopped");
}
async function gathered(peer) {
  if (peer.iceGatheringState === "complete") return;
  await new Promise((resolve, reject) => {
    const done = () => { if (peer.iceGatheringState === "complete") { cleanup(); resolve(); } };
    const cleanup = () => { clearTimeout(timer); peer.removeEventListener("icegatheringstatechange", done); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("local_ice_timeout")); }, 2000);
    peer.addEventListener("icegatheringstatechange", done); done();
  });
}
function peer() {
  const instance = new RTCPeerConnection({ iceServers: [] });
  instance.addEventListener("connectionstatechange", () => {
    if (pc !== instance) return;
    note(`${role}: ${instance.connectionState}`);
    if (["failed", "closed", "disconnected"].includes(instance.connectionState)) close();
    if (instance.connectionState === "connected") void instance.getStats().then(stats => {
      if (pc !== instance) return;
      const pair = [...stats.values()].find(s => s.type === "candidate-pair" && s.nominated && s.state === "succeeded");
      if (stats.get(pair?.localCandidateId)?.protocol !== "udp") { error("prototype_requires_udp"); close(); }
    }).catch(error);
  });
  return instance;
}
function sourceChannel(channel) {
  if (channel.label === "media" && !channel.ordered && channel.maxRetransmits === 0) media = channel;
  else if (channel.label === "feedback" && channel.ordered && channel.maxRetransmits === null) {
    feedback = channel;
    channel.onmessage = event => {
      try {
        if (typeof event.data !== "string" || event.data.length > 4096) throw new Error("feedback_size");
        metrics.feedbackReceivedBytes += event.data.length;
        const m = JSON.parse(event.data);
        if (m.epoch !== epoch || !sender) return;
        if (m.kind === "budget") sender.budget(m);
        else if (m.kind === "repair") {
          if (performance.now() - lastRepair < 90) return;
          lastRepair = performance.now(); sender.repair(m.tiles);
        } else throw new Error("feedback_method");
      } catch (e) { error(e); close(); }
    };
  } else { channel.close(); error("unexpected_channel"); }
}
async function answer(message) {
  if (message.params?.kind === "reference") {
    // Benchmark-only checksums, taken without activating a second browser/app.
    sendLocal({ kind: "answer", id: message.id, result: { epoch, generation: manifest?.generation, hashes: window.pwrwin.hashes() } });
    return;
  }
  close(); const generation = connection;
  epoch = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
  sender = new TileSender(epoch); lastRepair = 0;
  if (manifest) { sender.manifest(manifest); for (const image of nativeCache.values()) sender.image(image); }
  if (transport === "federation") {
    relay = makeRelay(); media = relay.media;
    sourceChannel(Object.assign(relay.feedback, { label: "feedback", ordered: true, maxRetransmits: null }));
    sendLocal({ kind: "answer", id: message.id, result: { protocol: "pwrwin-datagram-fixture-v1", epoch, transport } });
    return;
  }
  const local = pc = peer();
  local.ondatachannel = event => { if (pc === local) sourceChannel(event.channel); else event.channel.close(); };
  await local.setRemoteDescription(message.params);
  await local.setLocalDescription(await local.createAnswer()); await gathered(local);
  if (generation !== connection || pc !== local) return;
  sendLocal({ kind: "answer", id: message.id, result: { protocol: "pwrwin-datagram-fixture-v1", epoch, description: local.localDescription.toJSON() } });
}
async function begin() {
  if (role !== "viewer" || !ready) throw new Error("viewer_not_ready");
  if (transport === "federation") {
    close(); const generation = connection;
    const result = await requestOffer({ transport });
    if (generation !== connection) return;
    validateAnswer(result);
    if (result.transport !== transport) throw new Error("transport_mismatch");
    epoch = result.epoch; receiver = new TileReceiver(epoch);
    relay = makeRelay(); media = relay.media; feedback = relay.feedback;
    media.onmessage = event => { if (generation === connection && receiver) deliver(event.data, generation); };
    viewerFeedback(generation); relay.start(); note("Viewer: Federation push connected");
    return;
  }
  close(); const generation = connection, local = pc = peer();
  media = local.createDataChannel("media", { ordered: false, maxRetransmits: 0 }); media.binaryType = "arraybuffer";
  feedback = local.createDataChannel("feedback", { ordered: true });
  media.onmessage = event => { if (generation === connection && receiver) deliver(event.data, generation); };
  viewerFeedback(generation);
  await local.setLocalDescription(await local.createOffer()); await gathered(local);
  if (generation !== connection) return;
  const result = await requestOffer(local.localDescription.toJSON());
  if (generation !== connection) return;
  validateAnswer(result);
  epoch = result.epoch; receiver = new TileReceiver(epoch);
  await local.setRemoteDescription(result.description);
}
function makeRelay() {
  const pipe = new RelayPipe(epoch, role, sendLocal, e => { error(e); close(); }, () => socket.bufferedAmount);
  pipe.onclose = close; return pipe;
}
function requestOffer(params) {
  if (pendingOffer) return Promise.reject(new Error("fixture_request_in_flight"));
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID(); pendingOffer = { id, resolve, reject };
    sendLocal({ kind: "offer", id, params });
  });
}
function validateAnswer(result) {
  if (result.protocol !== "pwrwin-datagram-fixture-v1" || !Number.isInteger(result.epoch) || result.epoch <= 0 || result.epoch > 0xffffffff) throw new Error("invalid_answer");
}
function viewerFeedback(generation) {
  feedback.onmessage = event => {
    if (generation !== connection || !receiver) return;
    try {
      if (typeof event.data !== "string" || event.data.length > 4096) throw new Error("manifest_size");
      metrics.feedbackReceivedBytes += event.data.length;
      const m = JSON.parse(event.data);
      if (m.epoch === epoch && m.kind === "manifest") {
        receiver.manifest(m.versions); manifestEpoch = m.epoch; lastManifestAt = performance.now(); receiveBudget();
      }
      else throw new Error("manifest_method");
    } catch (e) { error(e); close(); }
  };
}
function random() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; }
function deliver(raw, generation) {
  if (!(raw instanceof ArrayBuffer) || raw.byteLength > 1028) { error("media_size"); return; }
  metrics.packets++; metrics.mediaBytes += raw.byteLength;
  // Application-message faults AFTER transport delivery, not network packet loss.
  if (random() < faults.loss || delayedBytes + raw.byteLength > 512 * 1024) { metrics.dropped++; return; }
  const delay = faults.delayMs + random() * faults.jitterMs;
  if (delay === 0) { receive(raw, generation); return; }
  const id = ++delayId; delayedBytes += raw.byteLength;
  metrics.peakDelayedBytes = Math.max(metrics.peakDelayedBytes, delayedBytes);
  delayed.set(id, setTimeout(() => {
    delayed.delete(id); delayedBytes -= raw.byteLength;
    if (generation === connection) receive(raw, generation);
  }, delay));
}
function receive(raw, generation) {
  try {
    const image = receiver.accept(raw); if (!image) return;
    const old = decodeQueue.get(image.id);
    if (!old || old.version < image.version) decodeQueue.set(image.id, image);
    while (queueBytes() > 128 * 1024 || decodeQueue.size > 32) decodeQueue.delete(decodeQueue.keys().next().value);
    metrics.peakDecodeQueueBytes = Math.max(metrics.peakDecodeQueueBytes, queueBytes());
    drainDecode(generation);
  } catch (e) { error(e); close(); }
}
const queueBytes = () => [...decodeQueue.values()].reduce((sum, image) => sum + image.data.length, 0);
function drainDecode(generation) {
  if (generation !== connection) return;
  while (decoding < 2 && decodeQueue.size) {
    const image = decodeQueue.get(65535) ?? decodeQueue.values().next().value;
    decodeQueue.delete(image.id); decoding++;
    const began = performance.now(), currentReceiver = receiver;
    createImageBitmap(new Blob([image.data], { type: "image/webp" })).then(bitmap => {
      try {
        if (generation !== connection || currentReceiver !== receiver) { metrics.staleDecode++; return; }
        if (bitmap.width !== image.dimensions.width || bitmap.height !== image.dimensions.height) throw new Error("decoded_geometry");
        let drawn = 0;
        for (const id of image.kind === 1 ? Array.from({ length: TILES }, (_, i) => i) : [image.id]) {
          if (!receiver.presentedImage(image, id)) continue;
          const g = geometry(id);
          context.clearRect(g.x, g.y, g.width, g.height);
          if (image.kind === 1) context.drawImage(bitmap, g.x/4, g.y/4, g.width/4, g.height/4, g.x, g.y, g.width, g.height);
          else context.drawImage(bitmap, g.x, g.y);
          drawn++;
        }
        if (drawn) {
          if (image.kind === 1) metrics.previews++; else metrics.tiles++;
          if (metrics.decodeMs.length < 10000) metrics.decodeMs.push(performance.now() - began);
          if (metrics.presentations.length < 10000) metrics.presentations.push({ at: performance.now(), kind: image.kind, version: image.version, regions: drawn });
        }
      } finally { bitmap.close(); }
    }).catch(error).finally(() => { decoding--; drainDecode(connection); });
  }
}
socket.onopen = () => socket.send(JSON.stringify({ token }));
socket.onclose = () => { close(); ready = false; };
socket.onmessage = event => {
  try {
    const value = JSON.parse(event.data);
    if (value.kind === "authenticated") { transport = value.transport; ready = true; note(`${role}: authenticated (${transport})`); }
    else if (value.kind === "ready") { nativeReady = true; note("Source ready; waiting for viewer"); }
    else if (value.kind === "offer" && role === "source") answer(value).catch(error);
    else if (value.kind === "answer" && value.id === pendingOffer?.id) { pendingOffer.resolve(value.result); pendingOffer = undefined; }
    else if (value.kind === "relay-ack") relay?.ack(value);
    else if (value.kind === "relay-delivery") {
      relay?.receive(value.batch);
      sendLocal({ kind: "relay-receipt", id: value.id });
    }
    else if (value.kind === "input") { metrics.fixtureRevision = value.revision; fixtureAcks.shift()?.(value.revision); }
    else if (value.kind === "error") { pendingOffer?.reject(new Error(value.message)); pendingOffer = undefined; error(value.message); }
    else if (value.kind === "manifest") {
      manifest = value; lastSourceManifestAt = performance.now();
      for (const [id, image] of nativeCache) if (id === 65535 || image.version < value.versions[id]) nativeCache.delete(id);
      sender?.manifest(value);
    } else if (value.kind === "image") {
      const image = { ...value, data: Uint8Array.from(atob(value.data), c => c.charCodeAt(0)) };
      if (!manifest || (image.imageKind === 1 ? image.version !== manifest.generation : image.version !== manifest.versions[image.id])) return;
      nativeCache.set(image.id, image); sender?.image(image);
    }
  } catch (e) { error(e); close(); }
};
setInterval(() => {
  try {
    if (role === "source") {
      if (feedback?.readyState === "open" && feedback.bufferedAmount < 4096 && manifest && manifestSent < manifest.generation) {
        sendFeedback({ kind: "manifest", epoch, versions: manifest.versions }); manifestSent = manifest.generation;
      }
      if (sender && media) { sender.pump(media); relay?.flush(); }
    }
  } catch (e) { error(e); close(); }
}, 4);
function receiveBudget() {
  if (role !== "viewer" || !receiver || feedback?.readyState !== "open" || feedback.bufferedAmount > 4096) return;
  if (!receiver.missing(1).length) return;
  sendFeedback({ kind: "budget", epoch, sequence: ++budgetSequence,
    bytes: Math.max(0, Math.min(MAX_BUFFERED, 128 * 1024 - queueBytes())) });
}
setInterval(() => {
  if (role !== "viewer" || !receiver || feedback?.readyState !== "open" || feedback.bufferedAmount > 4096) return;
  receiveBudget();
  receiver.expire();
  if (lastManifestAt !== null && performance.now() - lastRepair >= 100 && performance.now() - lastManifestAt >= 150) {
    const missing = receiver.missing(); lastRepair = performance.now();
    if (missing.length) sendFeedback({ kind: "repair", epoch, tiles: missing });
  }
}, 50);
function snapshot() {
  const manifestReceived = receiver !== undefined && manifestEpoch === receiver.epoch;
  const missing = receiver?.missing(TILES).length;
  let visibleRevision = 0;
  if (context) for (let bit = 0; bit < 12; bit++) {
    const p = context.getImageData(28 + bit * 16, 538, 1, 1).data;
    if (p[0] + p[1] + p[2] > 384) visibleRevision |= 1 << bit;
  }
  return { ...metrics, at: performance.now(), ready, nativeReady, transport,
    sourceGeneration: manifest?.generation, sourceTiles: [...nativeCache.values()].filter(i => i.imageKind === 2).length,
    sourceQuietMs: lastSourceManifestAt === null ? null : performance.now() - lastSourceManifestAt,
    connected: transport === "federation" ? !!relay?.active && !relay.closed : pc?.connectionState === "connected", epoch,
    visibleRevision, quietMs: lastManifestAt === null ? null : performance.now() - lastManifestAt,
    manifestReceived, refinementComplete: manifestReceived && missing === 0,
    missing, receive: receiver?.stats, send: sender?.stats,
    queuedBytes: queueBytes(), delayedBytes, faults, relay: relay?.stats,
    unordered: media ? !media.ordered : undefined, maxRetransmits: media?.maxRetransmits };
}
window.pwrwin = {
  begin, stop: close, snapshot,
  checkPixels: async () => {
    if (role !== "viewer" || !snapshot().refinementComplete) throw new Error("viewer_not_refined");
    const generation = connection, reference = await requestOffer({ kind: "reference" });
    if (generation !== connection || reference.epoch !== epoch || !snapshot().refinementComplete) throw new Error("reference_session_changed");
    if (!Array.isArray(reference.hashes) || reference.hashes.length !== TILES
      || new Set(reference.hashes.map(t => t.id)).size !== TILES
      || reference.hashes.some(t => !Number.isInteger(t.id) || t.id < 0 || t.id >= TILES
        || !Number.isSafeInteger(t.version) || t.version < 1 || !Number.isInteger(t.hash) || t.hash < 0 || t.hash > 0xffffffff)) throw new Error("invalid_pixel_reference");
    const actual = window.pwrwin.hashes(), mismatches = reference.hashes.filter(t =>
      t.version !== actual[t.id]?.version || t.hash !== actual[t.id]?.hash);
    return { expectedCount: reference.hashes.length, sourceGeneration: reference.generation,
      matches: reference.hashes.length - mismatches.length,
      mismatches: mismatches.map(t => ({ expected: t, actual: actual[t.id] })) };
  },
  fixture: command => new Promise((resolve, reject) => {
    if (fixtureAcks.length || socket.readyState !== WebSocket.OPEN) { reject(new Error("fixture_command_in_flight")); return; }
    const timer = setTimeout(() => { fixtureAcks.length = 0; reject(new Error("fixture_ack_timeout")); }, 2000);
    fixtureAcks.push(revision => { clearTimeout(timer); resolve(revision); });
    sendLocal({ kind: "fixture", command });
  }),
  faults: value => {
    if (![value.loss, value.delayMs, value.jitterMs].every(Number.isFinite) || value.loss < 0 || value.loss > 0.3
      || value.delayMs < 0 || value.delayMs > 500 || value.jitterMs < 0 || value.jitterMs > 100) throw new Error("invalid_faults");
    faults = value; seed = 12345;
  },
  save: () => sendLocal({ kind: "metrics", metrics: snapshot() }),
  rtc: async () => {
    const result = []; if (!pc) return result;
    for (const stat of (await pc.getStats()).values()) if (["transport", "candidate-pair", "local-candidate", "remote-candidate", "data-channel"].includes(stat.type)) {
      const { type, protocol, state, nominated, bytesSent, bytesReceived, messagesSent, messagesReceived, label, currentRoundTripTime } = stat;
      const candidate = stat.localCandidateId ? (await pc.getStats()).get(stat.localCandidateId) : undefined;
      result.push({ type, protocol, selectedProtocol: nominated ? candidate?.protocol : undefined, state, nominated,
        bytesSent, bytesReceived, messagesSent, messagesReceived, label, currentRoundTripTime });
    }
    return result;
  },
  hashes: () => role === "source" ? [...nativeCache.values()].filter(i => i.imageKind === 2)
    .map(i => ({ id: i.id, version: i.version, hash: i.opaqueHash })) : Array.from({ length: TILES }, (_, id) => {
      const g = geometry(id), pixels = context.getImageData(g.x, g.y, g.width, g.height).data;
      let hash = 2166136261;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i+3] === 255) {
        for (let c = 0; c < 3; c++) hash = Math.imul(hash ^ pixels[i+c], 16777619) >>> 0;
      }
      return { id, version: receiver?.presented[id], hash };
    }),
};
document.querySelector("#start")?.addEventListener("click", () => begin().catch(error));
document.querySelector("#stop")?.addEventListener("click", close);
document.querySelector("#save")?.addEventListener("click", window.pwrwin.save);
window.addEventListener("pagehide", () => { close(); socket.close(); });
