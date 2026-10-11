import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Terminal } from "@xterm/headless";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalReplay, TERMINAL_SNAPSHOT_LIMIT } from "../terminal/terminal-replay";
import { TerminalHistoryStore, type TerminalHistoryRecord } from "../terminal/terminal-history-store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function text(terminal: Terminal): string {
  const buffer = terminal.buffer.active;
  return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? "").join("\n").trimEnd();
}

describe("TerminalReplay", () => {
  it("serializes parsed cells across split escapes, carriage returns and Unicode without replaying queries", async () => {
    const replay = new TerminalReplay(40, 4);
    replay.append("stale\r\x1b[", 1);
    replay.append("2K\x1b[31mready 😀\x1b[0m\r\nnext\x1b[6n\x1b]52;c;c2VjcmV0\x07", 2);
    const snapshot = await replay.snapshot();
    expect(snapshot.seq).toBe(2);
    expect(snapshot.timestamp).toBe(2);
    expect(snapshot.data).not.toContain("52;c;");
    expect(snapshot.data).not.toContain("[6n");
    const restored = new Terminal({ cols: snapshot.cols, rows: snapshot.rows, allowProposedApi: true });
    const replies: string[] = [];
    restored.onData((data) => replies.push(data));
    await new Promise<void>((resolve) => restored.write(snapshot.data, resolve));
    expect(text(restored)).toBe("ready 😀\nnext");
    expect(replies).toEqual([]);
    restored.dispose();
    await replay.dispose();
  });

  it("takes an atomic watermark before output appended while the snapshot waits", async () => {
    const replay = new TerminalReplay(80, 4);
    replay.append("before", 10);
    const first = replay.snapshot();
    replay.append("after", 20);
    expect(await first).toMatchObject({ seq: 1, data: "before", timestamp: 10 });
    expect(await replay.snapshot()).toMatchObject({ seq: 2, data: "beforeafter", timestamp: 20 });
    expect(replay.read(1)).toMatchObject({ frames: [{ seq: 2, timestamp: 20, data: "after" }], nextSeq: 2, hasMore: false });
    await replay.dispose();
  });

  it("bounds raw reads, reports evicted cursors and always makes progress", async () => {
    const replay = new TerminalReplay(80, 4);
    replay.append("x".repeat(300 * 1024), 1);
    expect(replay.read(0, 8)).toEqual({ frames: [], nextSeq: 1, truncated: true, hasMore: false });
    replay.append("123456789", 2);
    expect(replay.read(1, 8)).toEqual({ frames: [], nextSeq: 2, truncated: true, hasMore: false });
    expect(() => replay.read(999)).toThrow("Invalid terminal cursor");
    expect(Buffer.byteLength((await replay.snapshot()).data)).toBeLessThanOrEqual(TERMINAL_SNAPSHOT_LIMIT);
    await replay.dispose();
  });

  it("normalizes progress updates and distinguishes screen text from event deltas", async () => {
    const replay = new TerminalReplay(80, 4);
    replay.append("step 1\rstep 2\r\n\x1b[32mDone\x1b[0m", 42);
    expect(await replay.readPlain()).toEqual({ data: "step 2\nDone", seq: 1, timestamp: 42 });
    expect(replay.read().frames[0]?.data).toContain("\x1b[32m");
    await replay.dispose();
  });
});

describe("TerminalHistoryStore", () => {
  async function setup() {
    const root = await mkdtemp(path.join(os.tmpdir(), "terminal-history-"));
    roots.push(root);
    const directory = path.join(root, "history");
    return { directory, store: new TerminalHistoryStore(directory) };
  }
  function record(id = "../untrusted-id"): TerminalHistoryRecord {
    return { version: 1, savedAt: Date.now(), summary: {
      sessionId: id, threadKey: "codex:one", cwd: "/work", shell: "/bin/sh", createdAt: 1,
      panelHidden: true, name: "Build", status: "restored",
    }, snapshot: { data: "safe", seq: 3, timestamp: 4, cols: 80, rows: 24, truncated: false } };
  }
  it("round trips bounded metadata in private atomic files and removes only the named record", async () => {
    const { directory, store } = await setup();
    await store.save(record());
    await store.save(record("second"));
    const files = await readdir(directory);
    expect(files).toHaveLength(2);
    expect(files.every((file) => /^[a-f0-9]{64}\.json$/.test(file))).toBe(true);
    if (process.platform !== "win32") expect((await stat(path.join(directory, files[0]!))).mode & 0o777).toBe(0o600);
    expect(await new TerminalHistoryStore(directory).load()).toHaveLength(2);
    await store.remove("../untrusted-id");
    expect((await store.load()).map((item) => item.summary.sessionId)).toEqual(["second"]);
  });
  it("rejects invalid/oversized snapshots and limits retention while running", async () => {
    const { directory, store } = await setup();
    for (let i = 0; i < 66; i++) await store.save(record(String(i)));
    expect(await readdir(directory)).toHaveLength(64);
    await writeFile(path.join(directory, `${"a".repeat(64)}.json`), JSON.stringify({ ...record(), snapshot: { data: "bad" } }));
    expect(await store.load()).toHaveLength(64);
    await expect(store.save({ ...record(), snapshot: { ...record().snapshot, data: "x".repeat(2 * 1024 * 1024) } })).rejects.toThrow("byte budget");
  });
});
