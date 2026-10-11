import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, test, vi } from "vitest";

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
