import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MobileDeviceStore } from "../mobile/device-store";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
describe("mobile device pairing", () => {
  it("consumes a single-use code atomically, stores only hashes and survives restart/revocation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mobile-devices-")); roots.push(root);
    const file = path.join(root, "devices.json"); const store = new MobileDeviceStore(file);
    const code = await store.invite(["read", "send"], ["machine-a"]);
    const results = await Promise.allSettled([store.pair(code, "phone"), store.pair(code, "second phone")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const result = results.find((row) => row.status === "fulfilled")!;
    if (result.status !== "fulfilled") throw new Error("pair failed");
    const { token, device } = result.value;
    const content = await readFile(file, "utf8"); expect(content).not.toContain(token); expect(content).not.toContain(code);
    const restarted = new MobileDeviceStore(file);
    expect((await restarted.authenticate(token))?.machines).toEqual(["machine-a"]);
    expect(await restarted.authenticate("wrong token")).toBeUndefined();
    await restarted.revoke(device.id); expect(await store.authenticate(token)).toBeUndefined();
  });
});
