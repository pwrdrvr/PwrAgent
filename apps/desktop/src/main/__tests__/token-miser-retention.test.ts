import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TokenMiserStore } from "../token-miser/token-miser-store";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "token-miser-retention-"));
  roots.push(root);
  return { root, store: new TokenMiserStore(root) };
}
const params = {
  threadId: "owner", turnId: "turn", toolUseId: "tool", toolName: "Bash",
  output: "PRIVATE_RAW_CANARY", replacementCharacters: 10,
  summary: { summary: "PRIVATE_SUMMARY_CANARY", usefulDetails: ["PRIVATE_DETAILS_CANARY"] },
};
it("never writes raw output, summaries, scripts or previews, including pass-through", async () => {
  const { store } = await fixture();
  const writes = vi.spyOn(fs, "writeFile");
  try {
    await store.store(params);
    await store.store({ ...params, disposition: "passed_through" });
    await store.recordCodeModeObservation({
      threadId: "owner", turnId: "turn", callId: "call", cellId: "cell",
      outputCharacters: 10, outputPreview: "PRIVATE_PREVIEW_CANARY",
      script: "PRIVATE_SCRIPT_CANARY", maxOutputTokens: 100,
      scriptStatus: "completed", retrieval: false, capturedNestedInvocationCount: 1,
    });
    expect(writes.mock.calls.map((call) => String(call[1])).join("\n")).not.toContain("PRIVATE_");
    expect(writes.mock.calls.some((call) => String(call[0]).includes(".txt"))).toBe(false);
  } finally { writes.mockRestore(); }
});
it("expires originals after five minutes and cannot retrieve them in a fresh store", async () => {
  const { store, root } = await fixture();
  const entry = await store.store(params);
  expect(await store.readAll({ objectId: entry.objectId, threadId: "owner" })).toBeDefined();
  expect((await store.summarizeThreadUsage("owner")).interceptions[0]?.originalOutputAvailableUntil).toBeGreaterThan(Date.now());
  expect(await new TokenMiserStore(root).readAll({ objectId: entry.objectId, threadId: "owner" })).toBeUndefined();
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
  expect(await store.readAll({ objectId: entry.objectId, threadId: "owner" })).toBeUndefined();
  expect((await store.summarizeThreadUsage("owner")).interceptions[0]?.originalOutputAvailableUntil).toBeUndefined();
  expect((await store.listMetadata("owner"))[0]?.baselineParentTokens).toBe(entry.baselineParentTokens);
});
it("retains accepted accounting across archive but rejects pending and late originals", async () => {
  const { store, root } = await fixture();
  const accepted = await store.store(params);
  const pending = await store.stage(params);
  await pending.persist();
  await store.archiveThread("owner");
  await expect(pending.persist()).rejects.toThrow("unavailable");
  await expect(new TokenMiserStore(root).stage(params)).rejects.toThrow("archived");
  expect(await store.readAll({ objectId: accepted.objectId, threadId: "owner" })).toBeUndefined();
  expect(await new TokenMiserStore(root).listMetadata("owner")).toHaveLength(1);
});
it("cold thread queries never enumerate or open unrelated thread directories", async () => {
  const { store, root } = await fixture();
  await store.store(params);
  await store.store({ ...params, threadId: "other" });
  const read = vi.spyOn(fs, "readFile");
  const list = vi.spyOn(fs, "readdir");
  try {
    const cold = new TokenMiserStore(root);
    expect(await cold.listMetadata("owner")).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(String(list.mock.calls[0]![0])).toMatch(/threads\/[a-f0-9]{64}$/);
    await store.store({ ...params, threadId: "owner" });
    expect(await cold.listMetadata("owner")).toHaveLength(2);
  } finally { read.mockRestore(); list.mockRestore(); }
});
it("migrates contrived legacy content while preserving historical costs and deleting originals", async () => {
  const { store, root } = await fixture();
  const metadata = await store.store({ ...params, helperUsage: { model: "test", tokenUsage: { inputTokens: 10, outputTokens: 2 } } });
  await fs.rm(path.join(root, "threads"), { recursive: true, force: true });
  await fs.writeFile(path.join(root, `${metadata.objectId}.txt`), "PRIVATE_LEGACY_RAW");
  await fs.writeFile(path.join(root, `${metadata.objectId}.json`), JSON.stringify({
    ...metadata, summary: params.summary, extraPreview: "PRIVATE_EXTRA", helperUsage: { model: "test", tokenUsage: { inputTokens: 10, outputTokens: 2, secret: "PRIVATE_USAGE" } },
  }));
  const writes = vi.spyOn(fs, "writeFile");
  try {
    await store.prune({ maxAgeMs: 0, maxBytes: 0 });
    expect(writes.mock.calls.map((call) => String(call[1])).join("\n")).not.toContain("PRIVATE_");
    expect(await fs.readdir(root)).toEqual(["threads"]);
    const [restored] = await new TokenMiserStore(root).listMetadata("owner");
    expect(restored?.helperUsage?.tokenUsage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(restored?.originalCharacters).toBe(metadata.originalCharacters);
    writes.mockClear();
    await store.prune({ maxAgeMs: 0, maxBytes: 0 });
    expect(writes).not.toHaveBeenCalled();
  } finally { writes.mockRestore(); }
});
it("bounds filesystem bytes and writes at acceptance and lifecycle boundaries", async () => {
  const { store } = await fixture();
  const writes = vi.spyOn(fs, "writeFile");
  try {
    const entry = await store.store(params);
    expect(writes).toHaveBeenCalledTimes(1);
    const acceptedBytes = Buffer.byteLength(String(writes.mock.calls[0]![1]));
    expect(acceptedBytes).toBeLessThan(1024);
    writes.mockClear();
    for (let request = 1; request <= 100; request += 1) {
      await store.recordParentModelRequest({ objectId: entry.objectId, cumulativeInputTokens: request * 100 });
    }
    expect(writes).not.toHaveBeenCalled();
    await store.flushThread("owner");
    expect(writes).toHaveBeenCalledTimes(1);
    expect(Buffer.byteLength(String(writes.mock.calls[0]![1]))).toBeLessThan(1024);
  } finally { writes.mockRestore(); }
});
it("never publishes a failed acceptance or exposes another thread's payload", async () => {
  const { store } = await fixture();
  const staged = await store.stage(params);
  await staged.persist();
  const rename = vi.spyOn(fs, "rename").mockRejectedValue(new Error("fixture failure"));
  try { await expect(staged.commit()).rejects.toThrow("fixture failure"); }
  finally { rename.mockRestore(); }
  expect(await store.readAll({ objectId: staged.metadata.objectId, threadId: "owner" })).toBeUndefined();
  await staged.discard();
  const accepted = await store.store(params);
  expect(await store.readAll({ objectId: accepted.objectId, threadId: "other" })).toBeUndefined();
  expect(await store.readAll({ objectId: accepted.objectId, threadId: "owner" })).toBeDefined();
});
it("shares the payload byte budget across cache instances and bounds individual entries", async () => {
  const { TokenMiserOutputCache, TOKEN_MISER_OUTPUT_ENTRY_BYTES } = await import("../token-miser/token-miser-output-cache");
  const first = new TokenMiserOutputCache();
  const second = new TokenMiserOutputCache();
  expect(first.put("oversized", "x".repeat(TOKEN_MISER_OUTPUT_ENTRY_BYTES))).toBe(false);
  const payload = "x".repeat(1024 * 1024);
  expect(first.put("oldest", payload)).toBe(true);
  for (let index = 0; index < 12; index += 1) expect(second.put(String(index), payload)).toBe(true);
  expect(first.get("oldest")).toBeUndefined();
  expect(second.get("11")).toBe(payload);
  for (let index = 0; index < 12; index += 1) second.remove(String(index));
});
it("does not write grouped member output or helper facts", async () => {
  const { store } = await fixture();
  const writes = vi.spyOn(fs, "writeFile");
  try {
    await store.store({ ...params, groupId: "group", output: JSON.stringify({ version: 1, groupId: "group", members: [{ objectId: "member", toolCallId: "call", toolName: "Bash", output: "PRIVATE_GROUP_RAW" }] }), groupMembers: [{ objectId: "member", toolCallId: "call", toolName: "Bash", summary: "PRIVATE_GROUP_FACT" }] });
    expect(writes.mock.calls.map((call) => String(call[1])).join("\n")).not.toContain("PRIVATE_");
  } finally { writes.mockRestore(); }
});

it("rejects cross-thread reuse of a staged id", async () => {
  const { store } = await fixture();
  const first = await store.stage({ ...params, objectId: "00000000-0000-4000-8000-000000000001" });
  await expect(store.stage({ ...params, objectId: "00000000-0000-4000-8000-000000000001", threadId: "other" })).rejects.toThrow("reserved");
  await first.commit();
  expect((await store.readAll({ objectId: "00000000-0000-4000-8000-000000000001", threadId: "owner" }))?.text).toBe(params.output);
});
