import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test, expect } from "vitest";

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
  expect(() => validate(partial)).toThrow("Incomplete");
  const enormous = fixture(); enormous.width = 4096; enormous.height = 4096;
  expect(() => validate(enormous)).toThrow("limits");
  const badMime = fixture(); badMime.frames[0].tiles[0].mime = "image/svg+xml";
  expect(() => validate(badMime)).toThrow("Invalid tile");
});
