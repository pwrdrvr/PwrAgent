import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test, expect, vi } from "vitest";

const html = readFileSync(new URL("./viewer.html", import.meta.url), "utf8");
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function validator() {
  const element = { getContext: () => ({}) };
  const context = vm.createContext({ document: { getElementById: () => element } });
  vm.runInContext(source, context);
  return context.validate;
}
function fixture() {
  return { version: 1, sessionId: "fixture", ownerInstanceId: "owner", sceneId: "scene", epoch: 1, width: 128, height: 128,
    frames: [{ seq: 0, baseSeq: -1, keyframe: true, tiles: [{ x: 0, y: 0, width: 128, height: 128, mime: "image/webp", base64: "AAAA" }] }] };
}

test("viewer rejects wrong delta base, incomplete first frame and excessive pixels before decode", () => {
  const validate = validator();
  expect(() => validate(fixture())).not.toThrow();
  const gap = fixture(); gap.frames.push({ seq: 1, baseSeq: 4, keyframe: false, tiles: [] });
  expect(() => validate(gap)).toThrow("resync");
  const partial = fixture(); partial.frames[0].tiles[0].width = 127;
  expect(() => validate(partial)).toThrow("grid");
  const enormous = fixture(); enormous.width = 4096; enormous.height = 4096;
  expect(() => validate(enormous)).toThrow("limits");
  const badMime = fixture(); badMime.frames[0].tiles[0].mime = "image/svg+xml";
  expect(() => validate(badMime)).toThrow("Invalid tile");
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function viewer(overrides = {}) {
  const drawn = [];
  const elements = Object.fromEntries(["file", "play", "save", "status", "metrics", "canvas"].map(id => [id, { textContent: "", disabled: true }]));
  elements.canvas.getContext = () => ({ drawImage: bitmap => drawn.push(bitmap) });
  const context = vm.createContext({
    document: { getElementById: id => elements[id] },
    performance, Blob, atob, setTimeout,
    requestAnimationFrame: callback => callback(),
    createImageBitmap: vi.fn(async () => ({ width: 128, height: 128, close: vi.fn() })),
    ...overrides,
  });
  vm.runInContext(source, context);
  return {
    context, elements, drawn,
    read: expression => vm.runInContext(expression, context),
    select: (text, size = 1000) => elements.file.onchange({ target: { files: [{ size, text }] } }),
  };
}

test("delta tiles cannot overlap or exceed a single canvas of decoded pixels", () => {
  const validate = validator();
  const b = fixture();
  b.width = 4096; b.height = 2048;
  b.frames[0].tiles = [];
  for (let y = 0; y < b.height; y += 128) {
    for (let x = 0; x < b.width; x += 128) b.frames[0].tiles.push({ ...fixture().frames[0].tiles[0], x, y });
  }
  const delta = { seq: 1, baseSeq: 0, keyframe: false, tiles: [{ ...b.frames[0].tiles[1] }] };
  b.frames.push(delta);
  expect(() => validate(b)).not.toThrow();
  delta.tiles.push({ ...delta.tiles[0] });
  expect(() => validate(b)).toThrow("grid");
  delta.tiles = Array.from({ length: 1024 }, () => ({ ...fixture().frames[0].tiles[0], width: 4096, height: 2048 }));
  expect(() => validate(b)).toThrow("grid");
  delta.tiles = [{ ...fixture().frames[0].tiles[0], x: 1 }];
  expect(() => validate(b)).toThrow("grid");
});

test.each(["resolve", "reject"])("stale file read cannot replace a newer import on %s", async outcome => {
  const v = viewer(), pending = deferred();
  const a = v.select(() => pending.promise);
  const b = fixture(); b.sessionId = "new"; b.ownerInstanceId = "new-owner";
  await v.select(async () => JSON.stringify(b));
  const status = v.elements.status.textContent;
  if (outcome === "resolve") pending.resolve(JSON.stringify({ ...fixture(), sessionId: "old" }));
  else pending.reject(new Error("old read failed"));
  await a;
  expect(v.read("batch.sessionId")).toBe("new");
  expect(v.elements.status.textContent).toBe(status);
  expect(v.elements.play.disabled).toBe(false);
  expect(v.drawn).toHaveLength(1);
  expect(v.read("measurements.length")).toBe(1);
});

test("stale image decode closes its bitmap without drawing or completing the import", async () => {
  const pending = deferred(), started = deferred();
  const oldBitmap = { width: 128, height: 128, close: vi.fn() };
  const currentBitmap = { width: 128, height: 128, close: vi.fn() };
  const decode = vi.fn().mockImplementationOnce(() => { started.resolve(); return pending.promise; })
    .mockResolvedValue(currentBitmap);
  const v = viewer({ createImageBitmap: decode });
  const a = v.select(async () => JSON.stringify(fixture()));
  await started.promise;
  await v.select(async () => JSON.stringify({ ...fixture(), sessionId: "new" }));
  pending.resolve(oldBitmap);
  await a;
  expect(v.read("batch.sessionId")).toBe("new");
  expect(v.drawn).toEqual([currentBitmap]);
  expect(oldBitmap.close).toHaveBeenCalledOnce();
  expect(v.read("measurements.length")).toBe(1);
});

test("stale presentation callback cannot append measurements to the new import", async () => {
  const callbacks = [], started = deferred();
  const v = viewer({ requestAnimationFrame: callback => { callbacks.push(callback); started.resolve(); } });
  const a = v.select(async () => JSON.stringify(fixture()));
  await started.promise;
  const readB = deferred();
  const b = v.select(() => readB.promise);
  callbacks.shift()();
  await a;
  expect(v.read("measurements.length")).toBe(0);
  expect(v.elements.play.disabled).toBe(true);
  expect(v.elements.status.textContent).toBe("Importing fixture batch");
  // Finish the current import through its own presentation callback.
  v.context.requestAnimationFrame = callback => callback();
  readB.resolve(JSON.stringify({ ...fixture(), sessionId: "new" }));
  await b;
  expect(v.read("batch.sessionId")).toBe("new");
  expect(v.read("measurements.length")).toBe(1);
});

test("obsolete playback cannot clear a newer playback's busy state", async () => {
  const timers = [];
  const v = viewer({ setTimeout: callback => timers.push(callback), navigator: { userAgent: "fixture" } });
  await v.select(async () => JSON.stringify(fixture()));
  const oldPlayback = v.elements.play.onclick();
  await v.select(async () => JSON.stringify({ ...fixture(), sessionId: "new" }));
  const newPlayback = v.elements.play.onclick();
  timers.shift()();
  await oldPlayback;
  expect(v.read("playing")).toBe(true);
  expect(v.elements.play.disabled).toBe(true);
  timers.shift()();
  await newPlayback;
  expect(v.read("result.sessionId")).toBe("new");
  expect(v.read("result.frames")).toBe(1);
});
