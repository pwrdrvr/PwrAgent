import { afterEach, describe, expect, it, vi } from "vitest";
import { FederationTrafficHistory, recordFederationTraffic, saveFederationTrafficHistory, federationTrafficCaptureUntil, setFederationTrafficCapture } from "../federation/federation-traffic-capture";

afterEach(() => { setFederationTrafficCapture(false); vi.restoreAllMocks(); });

describe("Federation detailed traffic capture", () => {
  it("expires at 60 seconds without depending on a window or a timer callback", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    expect(federationTrafficCaptureUntil()).toBeUndefined();
    setFederationTrafficCapture(true);
    expect(federationTrafficCaptureUntil()).toBe(61_000);
    expect(federationTrafficCaptureUntil(60_999)).toBe(61_000);
    expect(federationTrafficCaptureUntil(61_000)).toBeUndefined();
    expect(federationTrafficCaptureUntil(120_000)).toBeUndefined();
  });
  it("stops immediately and starts a fresh bounded capture only on request", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    setFederationTrafficCapture(true);
    setFederationTrafficCapture(false);
    expect(federationTrafficCaptureUntil()).toBeUndefined();
    now.mockReturnValue(5_000);
    setFederationTrafficCapture(true);
    expect(federationTrafficCaptureUntil()).toBe(65_000);
  });
});


describe("retrospective traffic metadata", () => {
  it("retains the preceding minute without capture enabled, and expires idle history on dump", () => {
    const history = new FederationTrafficHistory();
    history.record("sent", { method: "backend.readThread", byteCount: 400 }, 1_000);
    history.record("received", { method: "backend.readThread", byteCount: 900 }, 60_999);
    const retained = history.snapshot(60_999).trim().split("\n").map((line) => JSON.parse(line));
    expect(retained[0]).toMatchObject({ records: 2, capacityDropped: 0 });
    expect(retained[1]).toMatchObject({ at: 1_000, direction: "sent", method: "backend.readThread" });
    expect(JSON.parse(history.snapshot(61_000).split("\n")[0])).toMatchObject({ records: 1 });
    expect(JSON.parse(history.snapshot(121_000).split("\n")[0])).toMatchObject({ records: 0, bytes: 0 });
  });

  it("bounds both frames and bytes and reports overflow instead of silently claiming a full minute", () => {
    const frames = new FederationTrafficHistory(2);
    for (let i = 0; i < 3; i++) frames.record("sent", { requestId: String(i) }, i);
    expect(JSON.parse(frames.snapshot(3).split("\n")[0])).toMatchObject({ records: 2, capacityDropped: 1 });
    expect(frames.snapshot(3)).not.toContain('"requestId":"0"');
    const bytes = new FederationTrafficHistory(4096, 500);
    for (let i = 0; i < 1_000; i++) bytes.record("sent", { method: "x".repeat(1000) }, i);
    const dump = bytes.snapshot(1_000).trim().split("\n").map((line) => JSON.parse(line));
    expect(dump[0].bytes).toBeLessThanOrEqual(500);
    expect(dump[0].capacityDropped).toBeGreaterThan(0);
    expect(dump[1].method).toHaveLength(256);
  });
});


it("atomically saves bounded metadata on demand and serializes competing window captures", async () => {
  const { mkdtemp, readFile, readdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const directory = await mkdtemp(`${tmpdir()}/federation-history-`);
  try {
    recordFederationTraffic("sent", { method: "backend.readThread", byteCount: 400, dataByteCount: 384 });
    expect(await readdir(directory)).toEqual([]);
    const [first, second] = await Promise.all([saveFederationTrafficHistory(directory), saveFederationTrafficHistory(directory)]);
    expect(first).toBe(second);
    expect(await readdir(directory)).toEqual([`federation-traffic-${process.pid}.jsonl`]);
    const records = (await readFile(first, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({ type: "federation-traffic-history", records: 1 });
    expect(records[1]).toMatchObject({ method: "backend.readThread", direction: "sent", byteCount: 400 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
