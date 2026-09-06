import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenMiserStore } from "../token-miser/token-miser-store";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pwragent-miser-pressure-"));
  roots.push(root);
  const writer = new TokenMiserStore(root);
  const records = [];
  for (const threadId of ["thread-a", "thread-b"]) {
    const metadata = await addObject(writer, threadId);
    const observation = await addObservation(writer, threadId);
    records.push({ threadId, metadata, observation });
  }
  return { root, writer, records, reader: new TokenMiserStore(root) };
}

async function addObject(store: TokenMiserStore, threadId: string) {
  return await store.store({
    threadId,
    turnId: "turn-1",
    toolUseId: "tool-1",
    toolName: "Bash",
    output: "fixture output",
    replacementCharacters: 10,
    summary: { summary: "fixture summary", usefulDetails: [] },
  });
}

async function addObservation(store: TokenMiserStore, threadId: string, callId = "call-1") {
  return await store.recordCodeModeObservation({
    threadId,
    turnId: "turn-1",
    callId,
    cellId: callId,
    outputCharacters: 100,
    maxOutputTokens: 1_000,
    scriptStatus: "completed",
    retrieval: false,
    capturedNestedInvocationCount: 1,
  });
}

describe("Token Miser storage I/O budgets", () => {
  it("reads only the requested thread's JSON after discovery", async () => {
    const { reader, records } = await fixture();
    await reader.summarizeThreadUsage("thread-a");
    const other = records[1]!;
    const readFile = fs.readFile.bind(fs);
    const reads = vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
      const name = path.basename(String(file));
      if ([`${other.metadata.objectId}.json`, `${other.observation.observationId}.json`].includes(name)) {
        throw new Error("unrelated thread record must not be opened");
      }
      return await readFile(file, options);
    });

    const usage = await reader.summarizeThreadUsage("thread-a");
    expect(usage.interceptionCount).toBe(1);
    expect(usage.codeMode.callCount).toBe(1);
    expect(reads).toHaveBeenCalledTimes(2);
    reads.mockClear();
    expect(await reader.readGroupBatch({
      groupId: "missing-group",
      threadId: "thread-a",
      operations: [],
    })).toBeUndefined();
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("shares cold discovery across overlapping thread queries", async () => {
    const { reader, records } = await fixture();
    const reads = vi.spyOn(fs, "readFile");
    const summaries = await Promise.all([
      reader.summarizeThreadUsage("thread-a"),
      reader.summarizeThreadUsage("thread-b"),
    ]);
    expect(summaries.map((summary) => summary.interceptionCount)).toEqual([1, 1]);
    const counts = new Map<string, number>();
    for (const [file] of reads.mock.calls) {
      const name = path.basename(String(file));
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    for (const { metadata, observation } of records) {
      expect(counts.get(`${metadata.objectId}.json`)).toBe(1);
      expect(counts.get(`${observation.observationId}.json`)).toBe(1);
    }
  });

  it("discovers external additions and removals and reads changed counters fresh", async () => {
    const { root, writer, reader, records } = await fixture();
    await reader.summarizeThreadUsage("thread-a");
    const original = records[0]!.metadata;
    await writer.recordParentModelRequest({ objectId: original.objectId, cumulativeInputTokens: 100 });
    await writer.recordParentModelRequest({ objectId: original.objectId, cumulativeInputTokens: 200 });
    await writer.recordParentModelRequest({ objectId: original.objectId, cumulativeInputTokens: 300 });
    const added = await addObject(writer, "thread-a");
    await addObservation(writer, "thread-a", "call-2");
    expect(await reader.summarizeThreadUsage("thread-a")).toMatchObject({
      interceptionCount: 2,
      cachedReplayCount: 1,
      codeMode: { callCount: 2 },
    });
    await fs.rm(path.join(root, `${added.objectId}.json`));
    await fs.rm(path.join(root, "code-mode-observations", `${records[0]!.observation.observationId}.json`));
    expect(await reader.summarizeThreadUsage("thread-a")).toMatchObject({
      interceptionCount: 1,
      cachedReplayCount: 1,
      codeMode: { callCount: 1 },
    });
  });

  it("bounds writes and reads together across stores", async () => {
    const { reader, writer } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let peak = 0;
    const track = async <T>(run: () => Promise<T>): Promise<T> => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await gate;
        return await run();
      } finally {
        active -= 1;
      }
    };
    const readFile = fs.readFile.bind(fs);
    const writeFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation((file, options) => track(() => readFile(file, options)));
    vi.spyOn(fs, "writeFile").mockImplementation((file, data, options) => track(() => writeFile(file, data, options)));
    const work = Promise.all([
      reader.summarizeThreadUsage("thread-a"),
      ...Array.from({ length: 40 }, (_, index) => addObservation(writer, "thread-b", `burst-${index}`)),
    ]);
    try {
      await vi.waitFor(() => expect(active).toBeGreaterThan(0));
      release();
      await work;
      expect(peak).toBeLessThanOrEqual(16);
      expect(active).toBe(0);
    } finally {
      release();
      await work;
    }
  });

  it.each(["local", "external"])("includes %s commits in a query started during an older discovery", async (owner) => {
    const { root, reader, writer, records } = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const readFile = fs.readFile.bind(fs);
    let blocked = false;
    vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
      if (!blocked && String(file) === path.join(root, `${records[0]!.metadata.objectId}.json`)) {
        blocked = true;
        entered();
        await gate;
      }
      return await readFile(file, options);
    });
    const older = reader.listMetadata("thread-a");
    try {
      await started;
      const added = await addObject(owner === "local" ? reader : writer, "thread-a");
      const pending = reader.listMetadata("thread-a");
      release();
      const current = await pending;
      expect(current.map((record) => record.objectId)).toContain(added.objectId);
      expect(current).toHaveLength(2);
    } finally {
      release();
      await older;
    }
  });

  it("releases write slots and removes temporary files after failed renames", async () => {
    const { root, writer } = await fixture();
    const rename = vi.spyOn(fs, "rename").mockRejectedValue(
      Object.assign(new Error("rename failed"), { code: "EIO" }),
    );
    const results = await Promise.allSettled(Array.from(
      { length: 40 },
      (_, index) => addObservation(writer, "thread-a", `failed-${index}`),
    ));
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect((await fs.readdir(path.join(root, "code-mode-observations")))
      .some((name) => name.endsWith(".tmp"))).toBe(false);
    rename.mockRestore();
    await addObservation(writer, "thread-a", "successful");
    expect(await writer.listCodeModeObservations("thread-a")).toHaveLength(2);
  });
});
