import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, test } from "vitest";
import { TileSender, TileReceiver, geometry, TILES, MAX_BUFFERED } from "./protocol.mjs";

const source = readFileSync(new URL("./browser.mjs", import.meta.url), "utf8").replace(/^import[^\n]*\n/, "");
const benchmark = readFileSync(new URL("./benchmark.py", import.meta.url), "utf8");
const readiness = benchmark.match(/^VIEWER_READY = "([^"]+)"$/m)[1];
function fixture() {
  let time = 5000, offered;
  const sockets = [], peers = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor() { sockets.push(this); }
    send(raw) { const message = JSON.parse(raw); if (message.kind === "offer") offered(message); }
  }
  class Peer {
    iceGatheringState = "complete";
    connectionState = "new";
    channels = new Map();
    constructor() { peers.push(this); }
    addEventListener() {}
    createDataChannel(label) {
      const channel = { readyState: "open", bufferedAmount: 0, send: () => {} };
      this.channels.set(label, channel); return channel;
    }
    async createOffer() { return { type: "offer", sdp: "fixture" }; }
    async setLocalDescription() { this.localDescription = { toJSON: () => ({ type: "offer", sdp: "fixture" }) }; }
    async setRemoteDescription() { this.connectionState = "connected"; }
    close() { this.connectionState = "closed"; }
  }
  const element = { textContent: "", addEventListener: () => {}, getContext: () => ({ getImageData: () => ({ data: [0, 0, 0, 255] }) }) };
  const context = vm.createContext({ TileSender, TileReceiver, geometry, TILES, MAX_BUFFERED,
    document: { body: { dataset: { role: "viewer" } }, querySelector: () => element },
    location: { origin: "http://fixture", pathname: "/", hash: "#fixture" }, history: { replaceState: () => {} },
    window: { addEventListener: () => {} }, performance: { now: () => time }, crypto: { randomUUID: () => "offer" },
    WebSocket: Socket, RTCPeerConnection: Peer, setInterval: () => {}, setTimeout, clearTimeout,
  });
  vm.runInContext(source, context);
  const socket = sockets[0], api = context.window.pwrwin;
  socket.onmessage({ data: JSON.stringify({ kind: "authenticated" }) });
  return {
    snapshot: api.snapshot, ready: () => vm.runInContext(readiness, context), advance: ms => { time += ms; },
    read: expression => vm.runInContext(expression, context),
    async connect(epoch) {
      const offer = new Promise(resolve => { offered = resolve; });
      const opening = api.begin(), request = await offer;
      socket.onmessage({ data: JSON.stringify({ kind: "answer", id: request.id,
        result: { protocol: "pwrwin-datagram-fixture-v1", epoch, description: { type: "answer", sdp: "fixture" } } }) });
      await opening; return peers.at(-1).channels.get("feedback");
    },
  };
}
const manifest = (channel, epoch, version = 1) => channel.onmessage({
  data: JSON.stringify({ kind: "manifest", epoch, versions: Array(TILES).fill(version) }),
});

test("benchmark readiness requires the current manifest and all of its refined tiles", async () => {
  const v = fixture(), channel = await v.connect(1);
  v.advance(1000);
  expect(v.snapshot()).toMatchObject({ connected: true, missing: 0, manifestReceived: false, refinementComplete: false, quietMs: null });
  expect(v.ready()).toBe(false);

  manifest(channel, 1); v.advance(501);
  expect(v.snapshot()).toMatchObject({ missing: TILES, manifestReceived: true, refinementComplete: false });
  v.read(`for (let id = 0; id < TILES; id++) receiver.presentedImage({ kind: 1, versions: Array(TILES).fill(1) }, id);`);
  expect(v.ready()).toBe(false); // A coarse preview is not lossless coverage.
  v.read(`for (let id = 0; id < TILES - 1; id++) receiver.presentedImage({ kind: 2, version: 1 }, id);`);
  expect(v.snapshot().missing).toBe(1); expect(v.ready()).toBe(false);
  v.read(`receiver.presentedImage({ kind: 2, version: 1 }, TILES - 1);`);
  expect(v.ready()).toBe(true);
});

test("reconnect cannot reuse previous manifest timing, pixels, or a delayed old callback", async () => {
  const v = fixture(), old = await v.connect(1);
  manifest(old, 1);
  v.read(`for (let id = 0; id < TILES; id++) receiver.presentedImage({ kind: 2, version: 1 }, id);`);
  v.advance(1000); expect(v.ready()).toBe(true);

  const current = await v.connect(2);
  v.advance(5000); manifest(old, 1, 2);
  expect(v.snapshot()).toMatchObject({ epoch: 2, connected: true, missing: 0, manifestReceived: false, refinementComplete: false, quietMs: null });
  expect(v.ready()).toBe(false);
  manifest(current, 2, 3); v.advance(501);
  expect(v.snapshot().missing).toBe(TILES); expect(v.ready()).toBe(false);
  v.read(`for (let id = 0; id < TILES; id++) receiver.presentedImage({ kind: 2, version: 3 }, id);`);
  expect(v.ready()).toBe(true);
});
