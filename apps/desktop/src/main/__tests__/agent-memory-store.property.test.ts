import fc from "fast-check";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_MEMORY_INDEX_BYTES, AGENT_MEMORY_NOTE_BYTES } from "@pwragent/shared";
import { AgentMemoryStore } from "../app-server/agent-memory-store";

const authorize = async () => {};
const caller = { backend: "codex", threadId: "caller" } as const;
const other = { backend: "codex", threadId: "other" } as const;

async function withStore(test: (store: AgentMemoryStore) => Promise<void>) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "pwragent-memory-property-"));
  try {
    await test(new AgentMemoryStore(path.join(temp, "agent-memory")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

describe("Agent memory owner isolation", () => {
  it("any argument can affect only the memory selected by the trusted caller", async () => {
    await withStore(async (store) => {
      const oracle = await store.access(other, { action: "write_note", noteId: "progress", content: "other thread's record" }, authorize);
      const valid = fc.oneof(
        fc.record({ action: fc.constant("read_note"), noteId: fc.constant("progress") }),
        fc.record({ action: fc.constant("write_note"), noteId: fc.constant("progress"), content: fc.string() }),
        fc.record({ action: fc.constant("delete_note"), noteId: fc.constant("progress") }),
      );
      const forged = fc.oneof(
        fc.jsonValue(),
        fc.record({ action: fc.constantFrom("read_note", "write_note", "delete_note"), noteId: fc.constantFrom("../progress", "other/progress", "other\\progress"), content: fc.string() }),
        fc.record({ action: fc.constantFrom("read_note", "write_note", "delete_note"), noteId: fc.constant("progress"), threadId: fc.constant(other.threadId), backend: fc.constant(other.backend), content: fc.string() }),
      );
      await fc.assert(fc.asyncProperty(fc.oneof(valid, forged), async (args) => {
        const result = await store.access(caller, args, authorize).catch((error: unknown) => error);
        expect(result).not.toEqual(oracle);
        expect(await store.access(other, { action: "read_note", noteId: "progress" }, authorize)).toEqual(oracle);
      }));
    });
  });

  it("rejects oversize writes and stale revisions while preserving saved bytes", async () => {
    await withStore(async (store) => {
      const original = await store.access(caller, { action: "write_index", content: "previous" }, authorize);
      const cap = "é".repeat(AGENT_MEMORY_INDEX_BYTES / 2);
      await expect(store.access(caller, { action: "write_index", content: cap + "a" }, authorize)).rejects.toThrow("4096");
      expect(await store.access(caller, { action: "read_index" }, authorize)).toEqual(original);
      await store.access(caller, { action: "write_index", content: cap }, authorize);
      await expect(store.access(caller, { action: "write_index", content: "stale", revision: "revision" in original ? original.revision : "" }, authorize)).rejects.toThrow("changed");
      await expect(store.access(caller, { action: "write_note", noteId: "progress", content: "é".repeat(AGENT_MEMORY_NOTE_BYTES / 2) + "a" }, authorize)).rejects.toThrow("16384");
      await store.purge(caller);
      expect(await store.access(caller, { action: "read_index" }, authorize)).toMatchObject({ exists: false });
    });
  });
});
