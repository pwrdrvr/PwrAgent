import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnosticExcerpt, TokenMiserDiagnostics, type TokenMiserDiagnosticGate } from "../token-miser/token-miser-diagnostics";

const directories: string[] = [];
const captures: TokenMiserDiagnostics[] = [];
afterEach(async () => {
  await Promise.all(captures.splice(0).map((capture) => capture.close()));
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function setup(options: Partial<ConstructorParameters<typeof TokenMiserDiagnostics>[0]> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "miser-diagnostics-"));
  directories.push(directory);
  const file = path.join(directory, "diagnostics", "instance.jsonl");
  const capture = new TokenMiserDiagnostics({ filePath: file, isEnabled: () => true, sampleEvery: 1, ...options });
  captures.push(capture);
  return { capture, file, directory };
}
function gate(id = "object", toolName = "exec_command", disposition: "summarized" | "passed_through" = "summarized"): TokenMiserDiagnosticGate {
  const summary = { summary: "Found three relevant files", usefulDetails: ["src/test.ts"] };
  return {
    metadata: {
      version: 1, objectId: id, threadId: "thread", turnId: "turn", toolUseId: id,
      toolName, createdAt: Date.now(), originalCharacters: 5000, baselineParentTokens: 1250,
      replacementCharacters: 100, retrievedCharacters: 0, summary, disposition,
    },
    before: diagnosticExcerpt("original files", 100), delivered: diagnosticExcerpt("summary files", 100), summary,
    input: JSON.stringify({ cmd: "rg test src" }),
    context: { provider: "openai", model: "gpt-6-luna", reasoningEffort: "high", serviceTier: "priority" },
  };
}
function invoke(capture: TokenMiserDiagnostics, cmd = "rg test src", toolName = "exec_command") {
  capture.recordInvocation({ threadId: "thread", turnId: "turn", callId: cmd, toolName,
    input: JSON.stringify({ cmd }), output: `result ${cmd}`, codeMode: false });
}
async function rows(file: string) {
  return (await fs.readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("Token Miser diagnostic capture", () => {
  it("does no filesystem work while disabled and discards pending data on disable", async () => {
    let enabled = false;
    const { capture, directory, file } = await setup({ isEnabled: () => enabled });
    capture.recordGate(gate());
    await capture.flush();
    expect(await fs.readdir(directory)).toEqual([]);
    enabled = true;
    capture.recordGate(gate());
    capture.endTurn("thread");
    enabled = false;
    capture.isEnabled();
    enabled = true;
    await capture.flush();
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("batches multiple turns in one append every 30 seconds and writes nothing while idle", async () => {
    vi.useFakeTimers();
    const append = vi.fn<(file: string, data: string) => Promise<void>>(async () => undefined);
    const { capture } = await setup({ append });
    for (let i = 0; i < 10; i++) { capture.recordGate(gate(String(i))); capture.endTurn("thread"); }
    expect(append).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    await capture.flush();
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][1].trim().split("\n")).toHaveLength(10);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("captures the accepted before/summary/after chain and only explicit commentary", async () => {
    const { capture, file } = await setup();
    capture.recordNarration("thread", "turn", "commentary", "Looking for files with test");
    invoke(capture);
    capture.recordGate(gate());
    capture.recordNarration("thread", "turn", "final_answer", "Final answer excluded");
    capture.recordNarration("thread", "turn", undefined, "Unknown phase excluded");
    capture.recordNarration("thread", "turn", "commentary", "I need the exact result");
    invoke(capture, "read", "pwragent.read_all_token_miser_output");
    capture.recordRetrieval({ ...gate().metadata, retrievedCharacters: 5000 });
    capture.endTurn("thread");
    await capture.flush();
    const [row] = await rows(file);
    expect(row).toMatchObject({ category: "recovered", provider: "openai", context: { model: "gpt-6-luna", reasoningEffort: "high" } });
    const text = JSON.stringify(row);
    expect(text).toContain("original files");
    expect(text).toContain("Found three relevant files");
    expect(text).toContain("I need the exact result");
    expect(text).not.toContain("excluded");
    expect(row.events.find((event: { kind: string }) => event.kind === "retrieval_attempt").data.retrievalMode).toBe("all_requested");
    expect(row.events.find((event: { kind: string }) => event.kind === "retrieval_delivered").data.deliveredBytes).toBe(5000);
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("prioritizes a connected retry burst, counts exact repeats, and deduplicates its events", async () => {
    const { capture, file } = await setup({ sampleEvery: 100 });
    capture.recordGate(gate());
    invoke(capture); invoke(capture, "rg test other"); invoke(capture);
    for (let i = 0; i < 9; i++) invoke(capture, "git diff");
    capture.recordGate(gate("second"));
    invoke(capture); invoke(capture); invoke(capture);
    capture.endTurn("thread");
    await capture.flush();
    const result = await rows(file);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ category: "suspected_retry_burst", repeats: 3, exactRepeats: 2 });
    expect(result[1].burstGroupId).toBe(result[0].burstGroupId);
    const sequences = result.flatMap((row) => row.events.map((event: { sequence: number }) => event.sequence));
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it("does not treat polling, late repeats, or unrelated work as a workaround burst", async () => {
    let now = 0;
    const { capture, file } = await setup({ now: () => now });
    capture.recordGate(gate("poll", "write_stdin"));
    for (let i = 0; i < 3; i++) invoke(capture, "poll", "write_stdin");
    capture.recordGate(gate("late"));
    now = 46_000;
    for (let i = 0; i < 3; i++) invoke(capture);
    invoke(capture, "git diff");
    capture.endTurn("thread");
    await capture.flush();
    expect((await rows(file)).every((row) => row.category === "summarized_no_recovery_observed")).toBe(true);
  });

  it("keeps the remainder of long bursts even after the initial anchor and ring expire", async () => {
    let now = 0;
    const { capture, file } = await setup({ now: () => now });
    capture.recordGate(gate());
    for (let i = 0; i < 50; i++) { now += 2000; invoke(capture, `rg test ${i}`); }
    capture.endTurn("thread"); await capture.flush();
    const result = await rows(file);
    expect(new Set(result.map((row) => row.burstGroupId)).size).toBe(1);
    expect(result.every((row) => row.category === "suspected_retry_burst")).toBe(true);
    const tools = result.flatMap((row) => row.events).filter((event: { kind: string }) => event.kind === "tool");
    expect(tools).toHaveLength(50);
    expect(new Set(tools.map((event: { sequence: number }) => event.sequence)).size).toBe(50);
  });

  it("labels retrieval attempts separately from confirmed delivery and records byte deltas", async () => {
    const { capture, file } = await setup();
    capture.recordGate(gate());
    invoke(capture, "expired", "pwragent.read_token_miser_output");
    capture.recordRetrieval({ ...gate().metadata, retrievedCharacters: 10 });
    capture.recordRetrieval({ ...gate().metadata, retrievedCharacters: 10 });
    capture.recordRetrieval({ ...gate().metadata, retrievedCharacters: 30, focusedSummaryCharacters: 20 });
    capture.endTurn("thread"); await capture.flush();
    const [row] = await rows(file);
    expect(row.retrievedBytes).toBe(30);
    expect(row.events.filter((event: { kind: string }) => event.kind === "retrieval_delivered").map((event: { data: { deliveredBytes: number } }) => event.data.deliveredBytes)).toEqual([10, 20]);
  });

  it("flushes expired windows without requiring a turn end", async () => {
    let now = 0;
    const { capture, file } = await setup({ now: () => now });
    capture.recordGate(gate()); now = 90_000;
    await capture.flush();
    expect((await rows(file))[0].window.reason).toBe("observation_window");
  });

  it("clips Unicode content with an explicit omission and digest", () => {
    const result = diagnosticExcerpt("🙂".repeat(100), 32);
    expect(result).toMatchObject({ bytes: 400, truncated: true, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(result.text).toContain("middle omitted");
    expect(result.text).not.toContain("�");
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(32);
  });

  it("caps rings and queued samples and reports dropped queued records", async () => {
    const { capture, file } = await setup({ queueBytes: 5000, memoryBytes: 10_000 });
    for (let i = 0; i < 100; i++) { capture.recordGate(gate(String(i))); capture.endTurn("thread"); }
    await capture.flush();
    const result = await rows(file);
    expect(result.length).toBeLessThan(100);
    expect(result[result.length - 1].droppedQueuedRecords).toBeGreaterThan(0);
    expect((await fs.stat(file)).size).toBeLessThanOrEqual(5000);
  });

  it("rotates at most three bounded files", async () => {
    const { capture, file } = await setup({ fileBytes: 3500 });
    for (let i = 0; i < 8; i++) { capture.recordGate(gate(String(i))); capture.endTurn("thread"); await capture.flush(); }
    const names = await fs.readdir(path.dirname(file));
    expect(names.sort()).toEqual(["instance.jsonl", "instance.jsonl.1", "instance.jsonl.2"]);
    for (const name of names) expect((await fs.stat(path.join(path.dirname(file), name))).size).toBeLessThanOrEqual(3500);
  });

  it("caps old instance logs across restarts without deleting unrelated files", async () => {
    const { capture, file } = await setup();
    const directory = path.dirname(file);
    await fs.mkdir(directory);
    for (let i = 0; i < 30; i++) await fs.writeFile(path.join(directory, `old-${i}.jsonl`), "old");
    await fs.writeFile(path.join(directory, "keep.txt"), "keep");
    capture.recordGate(gate()); capture.endTurn("thread"); await capture.flush();
    const names = await fs.readdir(directory);
    expect(names.filter((name) => name.endsWith(".jsonl"))).toHaveLength(24);
    expect(names).toContain("keep.txt");
    expect(names).toContain(path.basename(file));
  });

  it("fails open on write and reporting errors and recovers on the next batch", async () => {
    const append = vi.fn< (file: string, data: string) => Promise<void> >()
      .mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    const { capture } = await setup({ append, onError: () => { throw new Error("logger failure"); } });
    capture.recordGate(gate()); capture.endTurn("thread"); await expect(capture.flush()).resolves.toBeUndefined();
    capture.recordGate(gate("next")); capture.endTurn("thread"); await capture.close();
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[1][1]).toContain('"droppedQueuedRecords":1');
  });

  it("serializes writes and waits for pending writes at shutdown", async () => {
    let release!: () => void;
    const append = vi.fn(async () => { await new Promise<void>((resolve) => { release = resolve; }); });
    const { capture } = await setup({ append });
    capture.recordGate(gate()); capture.endTurn("thread");
    const first = capture.flush();
    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(1));
    capture.recordGate(gate("second"));
    const close = capture.close();
    expect(append).toHaveBeenCalledTimes(1);
    release(); await first;
    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(2));
    release(); await close;
  });
});
