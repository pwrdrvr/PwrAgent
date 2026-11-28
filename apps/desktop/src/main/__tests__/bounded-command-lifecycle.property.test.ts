import { mkdtemp, open, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { boundedCommandTools } from "../agent-tools/bounded-command-tool";
import type { AgentToolCallContext } from "../agent-tools/agent-tool-definition";
import { BoundedCommandCapture } from "../token-miser/bounded-command";
import { TokenMiserService } from "../token-miser/token-miser-service";
import { TestTokenMiserStore } from "./token-miser-test-store";

const owner = { backend: "claude", threadId: "parent", turnId: "turn", transport: "mcp" } as const;
const output = "first line\nsecond line 💡\n";
const readModes = ["digest", "lines", "query", "bytes"] as const;
const edges = ["end", "close", "other turn"] as const;
type ReadMode = typeof readModes[number];
type Retirement = typeof edges[number];

let captureDirectory: string;
beforeAll(async () => {
  captureDirectory = await mkdtemp(path.join(tmpdir(), "bounded-capture-model-"));
  vi.stubEnv("TMPDIR", captureDirectory);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (captureDirectory) await rm(captureDirectory, { recursive: true, force: true });
});

async function prepareCapture(capture: BoundedCommandCapture, caller: AgentToolCallContext) {
  const ticket = await capture.prepare(caller, "git diff");
  // Model the native provider writing the capture and reporting the generated receipt.
  // The existing shell oracle checks this wire shape against a POSIX execution.
  const log = ticket.command.match(/pwragent-capture-[\w-]+\.log/u)![0];
  const receipt = ticket.command.match(/echo (pwragent-[a-f\d-]+):/u)![1];
  const filename = path.join(tmpdir(), log);
  await writeFile(filename, output);
  return { ...ticket, filename, receipt: receipt + ":0" };
}

async function replayRead(mode: ReadMode, retirement: Retirement) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let digestChecks = 0;
  let pauseDigest = false;
  const delivered = vi.fn(() => true);
  const capture = new BoundedCommandCapture(() => "o1", async () => {
    if (pauseDigest && ++digestChecks === 2) {
      entered.resolve();
      await release.promise;
    }
    return true;
  }, async () => true, undefined, delivered);
  try {
    const ticket = await prepareCapture(capture, owner);
    const file = await open(ticket.filename, "r");
    const prototype = Object.getPrototypeOf(file) as FileHandle;
    await file.close();
    capture.observe(owner, { id: "shell", command: ticket.command, completed: true, output: ticket.receipt });
    // Warm the summary before intercepting the byte or line read. None of the
    // retrieval paths below then shares the summary's in-flight descriptor IO.
    if (mode !== "digest") await capture.inspect(owner, ticket.objectId);
    pauseDigest = mode === "digest";
    const method = mode === "bytes" ? "read" : "stat";
    const fileOperation = prototype[method] as (this: FileHandle, ...args: unknown[]) => Promise<unknown>;
    const io = pauseDigest ? undefined : vi.spyOn(prototype, method).mockImplementation((async function (this: FileHandle, ...args: unknown[]) {
      const result = await fileOperation.apply(this, args);
      entered.resolve();
      await release.promise;
      return result;
    }) as FileHandle[typeof method]);

    try {
      const [tool] = boundedCommandTools(capture);
      const objectId = ticket.objectId;
      const args = {
        digest: { objectId }, lines: { objectId, startLine: 1 },
        query: { objectId, query: "second" }, bytes: { objectId, byteOffset: 0 },
      }[mode];
      const pending = tool!.dispatch(args, owner);
      await entered.promise;
      if (retirement === "close") await capture.close();
      else await capture.endTurn(retirement === "end" ? owner : { ...owner, turnId: "different" });
      release.resolve();
      const result = await pending;
      expect({ mode, retirement, ok: result.ok, deliveries: delivered.mock.calls.length }).toEqual({
        mode, retirement, ok: retirement === "other turn",
        deliveries: Number(retirement === "other turn"),
      });
    } finally {
      release.resolve();
      io?.mockRestore();
    }
  } finally {
    await capture.close();
  }
}

it.skipIf(process.platform === "win32").each([
  ["digest", "end"],
  ["lines", "end"],
  ["bytes", "close"],
] as const)("withdraws an in-flight %s read at %s", replayRead);

it.skipIf(process.platform === "win32")("keeps tool delivery inside the lifetime of its issuing turn", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom(...readModes), fc.constantFrom(...edges), replayRead), {
    numRuns: Number(process.env.MBT_RUNS ?? 5),
  });
});

const outcomes = ["allow", "decline", "deadline", "transport abort", "turn end"] as const;
type ApprovalOutcome = typeof outcomes[number];

async function replayApprovals(actions: readonly [ApprovalOutcome, ApprovalOutcome], reverse: boolean) {
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  const deadlines = [new AbortController(), new AbortController()];
  const entries = deadlines.map((deadline, index) => ({
    deadline, caller: { ...owner, backend: "codex" as const, transport: "codex_dynamic_tool" as const, turnId: "turn-" + index },
    transport: new AbortController(),
    entered: Promise.withResolvers<AbortSignal>(),
    answer: Promise.withResolvers<boolean>(),
  }));
  let timerIndex = 0;
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
    ms === 30_000 ? deadlines[timerIndex++]!.signal : nativeTimeout(ms));
  let handle = 0;
  const capture = new BoundedCommandCapture(() => "o" + ++handle, async () => true, async (caller, _command, _helper, signal) => {
    const entry = entries.find((current) => current.caller.turnId === caller.turnId)!;
    entry.entered.resolve(signal);
    return await entry.answer.promise;
  });
  try {
    const [tool] = boundedCommandTools(capture);
    const started = [];
    for (const entry of entries) {
      const result = tool!.dispatch({ command: "git diff" }, { ...entry.caller, signal: entry.transport.signal });
      started.push({ ...entry, result, signal: await entry.entered.promise });
    }
    for (const index of reverse ? [1, 0] : [0, 1]) {
      const entry = started[index]!;
      const action = actions[index]!;
      if (action === "deadline") entry.deadline.abort();
      else if (action === "transport abort") entry.transport.abort();
      else if (action === "turn end") await capture.endTurn(entry.caller);
      else entry.answer.resolve(action === "allow");
      expect({ action, ok: (await entry.result).ok, aborted: entry.signal.aborted }).toEqual({
        action, ok: action === "allow", aborted: action === "deadline" || action === "transport abort" || action === "turn end",
      });
      entry.answer.resolve(true);
    }
    expect(handle).toBe(actions.filter((action) => action === "allow").length);
  } finally {
    timeout.mockRestore();
    for (const entry of entries) entry.answer.resolve(false);
    await capture.close();
  }
}

it.skipIf(process.platform === "win32")("settles independent approvals in either order and ignores late acceptance", async () => {
  const action = fc.constantFrom(...outcomes);
  await fc.assert(fc.asyncProperty(fc.tuple(action, action), fc.boolean(), replayApprovals), {
    numRuns: Number(process.env.MBT_RUNS ?? 5),
  });
});

const receiptEvents = ["start", "complete", "duplicate completion", "foreign completion", "wrong item",
  "other turn end", "end", "read", "repeat read"] as const;

it.skipIf(process.platform === "win32")("agrees with a capture model across receipt redelivery and repeated reads", async () => {
  await fc.assert(fc.asyncProperty(fc.shuffledSubarray([...receiptEvents], { minLength: 5 }), async (events) => {
    const delivered = vi.fn(() => true);
    const capture = new BoundedCommandCapture(() => "o1", async () => true, async () => true, undefined, delivered);
    try {
      const ticket = await prepareCapture(capture, owner);
      const scopedCommand = "cd '/tmp/path with space' && " + ticket.command;
      const [tool] = boundedCommandTools(capture);
      const foreign = { ...owner, turnId: "other" };
      let retired = false;
      let completed = false;
      let sentDigests = 0;
      for (const step of events) {
        if (step === "read" || step === "repeat read") {
          const ready = completed && !retired;
          const result = await tool!.dispatch({ objectId: ticket.objectId }, owner);
          expect(result.ok, events.join(", ")).toBe(ready);
          if (ready) sentDigests++;
        } else if (step === "end" || step === "other turn end") {
          await capture.endTurn(step === "end" ? owner : foreign);
          if (step === "end") retired = true;
        } else {
          // Completion can be the first native event the owner observes.
          const ownReceipt = step === "complete" || step === "duplicate completion";
          capture.observe(step === "foreign completion" ? foreign : owner, {
            id: step === "wrong item" ? "unrelated" : "shell",
            command: step === "wrong item" ? "git diff" : scopedCommand,
            completed: step !== "start", output: ticket.receipt,
          });
          if (ownReceipt && !retired) completed = true;
        }
        expect(delivered.mock.calls, events.join(", ")).toHaveLength(sentDigests);
      }
    } finally {
      await capture.close();
    }
  }), { numRuns: Number(process.env.MBT_RUNS ?? 5) });
});

it.skipIf(process.platform === "win32")("records only visible Code Mode digests and exact reads", async () => {
  const store = new TestTokenMiserStore(captureDirectory);
  const reducer = new TokenMiserService({ store, isEnabled: () => true, generateSummary: async () =>
    ({ status: "failed", reason: "Unexpected reduction" }) });
  let thread = 0;
  await fc.assert(fc.asyncProperty(fc.constantFrom("raw", "quoted", "discarded", "truncated"), async (mode) => {
    const caller = { ...owner, backend: "codex", transport: "codex_dynamic_tool", threadId: `capture-${++thread}` } as const;
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

it.skipIf(process.platform === "win32").each([true, false])("credits a direct MCP digest only after a successful flush (%s)", async (sent) => {
  const flushed = Promise.withResolvers<void>();
  const delivered = vi.fn();
  const capture = new BoundedCommandCapture(() => "o1", async () => true, async () => true, undefined, delivered);
  try {
    const ticket = await prepareCapture(capture, owner);
    capture.observe(owner, { id: "native", command: ticket.command, completed: true, output: ticket.receipt });
    const [tool] = boundedCommandTools(capture);
    expect((await tool!.dispatch({ objectId: ticket.objectId }, { ...owner, responseFlushed: flushed.promise })).ok).toBe(true);
    expect(delivered).not.toHaveBeenCalled();
    if (sent) flushed.resolve();
    else flushed.reject(new Error("Client disconnected"));
    await flushed.promise.catch(() => {});
    expect(delivered).toHaveBeenCalledTimes(Number(sent));
  } finally {
    await capture.close();
  }
});
