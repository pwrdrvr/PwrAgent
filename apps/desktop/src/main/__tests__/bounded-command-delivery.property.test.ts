import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { boundedCommandTools } from "../agent-tools/bounded-command-tool";
import { BoundedCommandCapture } from "../token-miser/bounded-command";
import { TokenMiserService } from "../token-miser/token-miser-service";
import { prepareCapture } from "./fixtures/bounded-command-capture-fixture";
import { TestTokenMiserStore } from "./token-miser-test-store";

let captureDirectory: string;
beforeAll(async () => {
  captureDirectory = await mkdtemp(path.join(tmpdir(), "bounded-capture-delivery-"));
  vi.stubEnv("TMPDIR", captureDirectory);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (captureDirectory) await rm(captureDirectory, { recursive: true, force: true });
});

it.skipIf(process.platform === "win32")("records only visible Code Mode digests and exact reads", async () => {
  const store = new TestTokenMiserStore(captureDirectory);
  const reducer = new TokenMiserService({ store, isEnabled: () => true, generateSummary: async () =>
    ({ status: "failed", reason: "Unexpected reduction" }) });
  let thread = 0;
  await fc.assert(fc.asyncProperty(fc.constantFrom("raw", "quoted", "discarded", "truncated"), async (mode) => {
    const caller = { backend: "codex", transport: "codex_dynamic_tool", turnId: "turn", threadId: `capture-${++thread}` } as const;
    const direct = vi.fn(() => true);
    const capture = new BoundedCommandCapture(() => store.issueOutputHandle(), async () => true, async () => true, undefined, direct);
    try {
      const ticket = await prepareCapture(capture, caller);
      capture.observe(caller, { id: "native", command: ticket.command, completed: true, output: ticket.receipt });
      const [tool] = boundedCommandTools(capture, store);
      const send = async (args: Record<string, unknown>) => {
        const result = await tool!.dispatch({ objectId: ticket.objectId, ...args }, caller);
        const item = result.contentItems?.[0];
        if (!result.ok || item?.type !== "inputText") throw new Error("Missing capture receipt");
        return { wrapped: item.text, data: result.data };
      };
      const digest = await send({});
      const padding = ".".repeat(1024);
      const emitted = mode === "raw" || mode === "quoted";
      const visible = mode === "raw" ? digest.wrapped : mode === "quoted" ? JSON.stringify(digest.wrapped)
        : mode === "truncated" ? padding + digest.wrapped + padding : padding;
      await reducer.prepareCodeModeOutput({ version: 1, thread_id: caller.threadId, turn_id: caller.turnId,
        call_id: "cell", cell_id: "cell", script_status: "Script completed", max_output_tokens: 80, model_visible_overhead_characters: 0,
        content_items: [{ type: "input_text", text: visible }],
      });
      expect(direct).not.toHaveBeenCalled();
      const rows = await store.listMetadata(caller.threadId);
      expect(rows.length).toBe(Number(emitted));
      if (!emitted) return;
      const raw = String(digest.data);
      const digestBytes = Buffer.byteLength(mode === "quoted" ? JSON.stringify(raw).slice(1, -1) : raw);
      expect(rows[0]?.replacementCharacters).toBe(digestBytes);

      let retrieved = 0;
      for (const args of [{ startLine: 1, endLine: 1 }, { query: "second" }, { byteOffset: 0 }]) {
        const read = await send(args);
        if (typeof read.data === "string") retrieved += Buffer.byteLength(read.data);
        else retrieved += Buffer.byteLength(JSON.stringify(read.data, null, 2));
        await store.confirmModelVisibleRetrievals({ threadId: caller.threadId, output: read.wrapped });
        await store.confirmModelVisibleRetrievals({ threadId: caller.threadId, output: read.wrapped });
      }
      expect((await store.listMetadata(caller.threadId))[0]?.retrievedCharacters).toBe(retrieved);
    } finally {
      await capture.close();
    }
  }), { numRuns: 5 });
});
