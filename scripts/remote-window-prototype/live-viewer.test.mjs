import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, test, vi } from "vitest";
import { LiveWindowSession } from "./live-session.mjs";

const source = readFileSync(new URL("./live-viewer.html", import.meta.url), "utf8").match(/<script>([\s\S]*?)<\/script>/)[1];
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(rpc) {
  const elements = Object.fromEntries(["canvas", "start", "stop", "motion", "save", "status", "stats"].map(id => [id, {
    getContext: () => ({}), addEventListener: () => {}, textContent: "", disabled: false,
  }]));
  const context = vm.createContext({ document: { getElementById: id => elements[id] },
    location: { hash: "#fixture-token" }, history: { replaceState: () => {} }, window: {}, performance });
  vm.runInContext(source, context);
  context.rpc = rpc;
  return { context, elements, read: expression => vm.runInContext(expression, context) };
}
test("an old asynchronous open cannot overwrite a newer live session", async () => {
  const oldOpen = deferred(), newOpen = deferred(), pulled = deferred(), pull = deferred();
  let opens = 0;
  const rpc = vi.fn((method, _params) => {
    if (method === "open") return opens++ === 0 ? oldOpen.promise : newOpen.promise;
    if (method === "pull") { pulled.resolve(); return pull.promise; }
    return Promise.resolve({});
  });
  const v = fixture(rpc), oldRun = v.context.run();
  await v.context.stop();
  const currentRun = v.context.run();
  newOpen.resolve({ sessionId: "new", epoch: 2, scene: "owned-fixture", control: false });
  await pulled.promise;
  const status = v.elements.status.textContent;
  oldOpen.resolve({ sessionId: "old", epoch: 1, scene: "owned-fixture", control: true });
  await oldRun;
  expect(v.read("session.sessionId")).toBe("new");
  expect(v.elements.status.textContent).toBe(status);
  expect(v.read("metrics.sessions")).toHaveLength(1);
  expect(rpc).toHaveBeenCalledWith("close", { sessionId: "old", epoch: 1, scene: "owned-fixture" });
  await v.context.stop(); pull.resolve({ idle: true }); await currentRun;
});
test("a delayed measurement save cannot replace a stopped viewer's stale-frame status", async () => {
  const saved = deferred(), v = fixture(() => saved.promise);
  const pending = v.context.save();
  await v.context.stop();
  const status = v.elements.status.textContent;
  saved.resolve({}); await pending;
  expect(v.elements.status.textContent).toBe(status);
});
test.each(["paused capture", "expired nonce"])("input sequence recovers after %s rejects a command", async reason => {
  let time = 0, requestId, revision = 0;
  const native = {
    next: (_key, id) => { requestId = id; },
    input: vi.fn(() => ({ revision: ++revision })),
  };
  const owner = new LiveWindowSession({ owner: "source", viewer: "viewer", source: native, control: true, now: () => time });
  const opened = owner.open("viewer");
  const rpc = vi.fn((method, params) => owner.handle("viewer", method, params));
  const v = fixture(rpc);
  v.context.opened = opened;
  v.read("session = opened; active = true;");
  async function present() {
    const delivery = owner.pull("viewer", { ...opened, offset: 0 });
    native.onFrame({ requestId, format: "h264", key: true, width: 800, height: 548, data: "eA==" });
    const packet = await delivery;
    owner.ack("viewer", { ...opened, seq: packet.seq });
    v.context.packet = packet;
    v.read("displayedSeq = packet.seq; nonce = packet.nonce;");
  }
  await present();
  if (reason === "paused capture") native.available = false;
  else time += 1201;
  v.read(`pending.push({ command: { action: "text", text: "rejected" }, start: performance.now() });`);
  await v.context.sendInputs();
  expect(v.read("inputSeq")).toBe(0);
  expect(v.read("metrics.acceptedInputs")).toHaveLength(0);
  expect(v.read("metrics.errors")).toHaveLength(1);
  expect(native.input).not.toHaveBeenCalled();

  native.available = true;
  await present();
  v.read(`pending.push(...["accepted", "next"].map(text => ({ command: { action: "text", text }, start: performance.now() })));`);
  await v.context.sendInputs();
  expect(rpc.mock.calls.map(([, params]) => params.inputSeq)).toEqual([0, 0, 1]);
  expect(native.input.mock.calls.map(([command]) => command.text)).toEqual(["accepted", "next"]);
  expect(v.read("inputSeq")).toBe(2);
  expect(v.read("metrics.acceptedInputs")).toEqual([
    { revision: 1, inputSeq: 0, action: "text" },
    { revision: 2, inputSeq: 1, action: "text" },
  ]);
  owner.disconnect();
});
test("a late input acceptance cannot advance a newer session's sequence or release its send lock", async () => {
  const oldReply = deferred(), newReply = deferred();
  let inputs = 0;
  const v = fixture(method => method === "input" ? (inputs++ === 0 ? oldReply.promise : newReply.promise) : Promise.resolve({}));
  const setup = () => v.read(`
    session = { sessionId: "fixture", scene: "owned-fixture", epoch: generation, control: true };
    active = true; sending = false; inputSeq = 0; displayedSeq = 0; nonce = "fixture";
    pending.push({ command: { action: "text", text: "fixture" }, start: performance.now() });
  `);
  setup();
  const oldSend = v.context.sendInputs();
  await v.context.stop();
  setup();
  const newSend = v.context.sendInputs();
  oldReply.resolve({ revision: 1 }); await oldSend;
  expect(v.read("inputSeq")).toBe(0);
  expect(v.read("sending")).toBe(true);
  expect(v.read("metrics.acceptedInputs")).toHaveLength(0);
  newReply.resolve({ revision: 2 }); await newSend;
  expect(v.read("inputSeq")).toBe(1);
  expect(v.read("sending")).toBe(false);
  expect(v.read("metrics.acceptedInputs")).toEqual([{ revision: 2, inputSeq: 0, action: "text" }]);
});
