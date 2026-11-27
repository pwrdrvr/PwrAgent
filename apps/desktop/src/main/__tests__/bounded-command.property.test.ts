import * as mcpConnections from "@pwragent/shared/contracts/mcp-connections";
import { spawnSync } from "node:child_process";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { boundedCommandTools } from "../agent-tools/bounded-command-tool";
import { BoundedCommandLines } from "../token-miser/bounded-command-lines";
import { BoundedCommandCapture } from "../token-miser/bounded-command";
import { TokenMiserService } from "../token-miser/token-miser-service";
import { TestTokenMiserStore } from "./token-miser-test-store";

const caller = { backend: "acp:antigravity", threadId: "thread", turnId: "turn" } as const;
const shell = "/bin/sh";

it("keeps line previews equal to a full UTF-8 decode across block and range boundaries", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bounded-line-pages-"));
  const file = await open(path.join(dir, "capture"), "wx+");
  try {
    const bytes = Buffer.concat([
      Buffer.from("a".repeat(65535) + "😀\r\n\nshort\n"),
      Buffer.from([0xff]), Buffer.from("π".repeat(40000) + "\nlast\r"),
    ]);
    await file.writeFile(bytes);
    const lines = new BoundedCommandLines(file);
    const expected = bytes.toString("utf8").split("\n").map((line, index, all) => {
      const preview = line.slice(0, 2048);
      return index + 1 === all.length ? preview : preview.replace(/\r$/u, "");
    });
    const collect = async (start: number) => {
      const result: string[] = [];
      for await (const line of lines.from(start)) result.push(line);
      return result;
    };
    const [full, late] = await Promise.all([collect(1), collect(4)]);
    expect(full).toEqual(expected);
    expect(late).toEqual(expected.slice(3));
    expect(await collect(2)).toEqual(expected.slice(1));
    expect(await collect(6)).toEqual([]);
  } finally {
    await file.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("retains the native command's bytes and exit code only on the issuing turn", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bounded-oracle-"));
  let enabled = true;
  let approved = false;
  const select = vi.fn(async () => 0);
  const store = new TestTokenMiserStore(dir);
  const capture = new BoundedCommandCapture(() => store.issueOutputHandle(), async () => enabled, async () => approved,
    () => ({ identity: "fixture", label: "fixture", select }));
  const generateSummary = vi.fn(async () => ({ status: "failed" as const, reason: "unexpected helper call" }));
  const managed = new TokenMiserService({ store, isEnabled: () => true, generateSummary });
  const run = (cmd: string) => spawnSync(shell, ["-c", cmd], {
    cwd: dir, env: { ...process.env, BOUNDED_COMMAND_FIXTURE: "environment preserved" },
  });
  try {
    await expect(capture.prepare(caller, "git diff")).rejects.toThrow("declined");
    expect(capture.pending).toBe(false);
    approved = true;
    expect(run("git init -q").status).toBe(0);
    await writeFile(path.join(dir, "headers.css"), "thead { position: sticky }\n");
    expect(run("git add headers.css").status).toBe(0);
    await writeFile(path.join(dir, "headers.css"), "thead { position: static }\n" + ".row { color: teal }\n".repeat(5000));
    await writeFile(path.join(dir, "fail.test.cjs"), [
      'const test = require("node:test");',
      'test("sticky table header", () => {',
      '  process.stderr.write(process.env.BOUNDED_COMMAND_FIXTURE + " in " + process.cwd() + "\\n");',
      '  for (let i = 0; i < 1200; i++) console.log("rendering π");',
      '  throw new Error("expected sticky, got static");',
      '});',
    ].join("\n"));

    for (const command of ["git diff", "node --test fail.test.cjs"]) {
      const { objectId, command: native } = await capture.prepare(caller, command);
      await expect(capture.inspect(caller, objectId)).rejects.toThrow("completion receipt");
      const result = run(native);
      expect(result.status).toBe(command === "git diff" ? 0 : 1);
      expect(objectId).toMatch(/^o[0-9]+$/u);
      expect(result.stdout.toString().trim()).toMatch(/^pwragent-[a-f0-9-]{36}:[01]$/u);
      expect(result.stdout.toString()).not.toContain(`pwragent-${objectId}:`);
      // A different tool, thread, or item cannot turn its stdout into a completion receipt.
      capture.observe(caller, { id: "foreign", command: "echo", completed: true, output: result.stdout.toString() });
      await expect(capture.inspect(caller, objectId)).rejects.toThrow("completion receipt");
      capture.observe(caller, { id: "call", command: native, completed: false });
      capture.observe(caller, { id: "call", completed: true, output: `pwragent-${objectId}:0` });
      await expect(capture.inspect(caller, objectId)).rejects.toThrow("completion receipt");
      capture.observe(caller, { id: "other", completed: true, output: result.stdout.toString() });
      await expect(capture.inspect(caller, objectId)).rejects.toThrow("completion receipt");
      capture.observe(caller, { id: "call", completed: true, output: result.stdout.toString() });
      const summary = await capture.inspect(caller, objectId);
      expect(Buffer.byteLength(summary)).toBeLessThan(1600);
      expect(summary).toContain(command === "git diff" ? "headers.css" : "expected sticky, got static");
      if (command === "git diff") {
        // The summary just visited the final block. Reading that block again needs no prefix replay.
        const file = await open(path.join(dir, "headers.css"));
        const reads = vi.spyOn(Object.getPrototypeOf(file) as typeof file, "read");
        try {
          expect(await capture.inspect(caller, objectId, { start: 4900, end: 4900 })).toBe("+.row { color: teal }");
          expect(reads).not.toHaveBeenCalled();
        } finally {
          reads.mockRestore();
          await file.close();
        }
      }
      const first = await capture.inspect(caller, objectId, { start: 1, end: 1 });
      expect(first.split("\n")).toHaveLength(1);
      const needle = command === "git diff" ? "headers.css" : "expected sticky, got static";
      expect(await capture.inspect(caller, objectId, { start: 1, end: 2, query: needle })).toContain(needle);
      const chunks: Buffer[] = [];
      let offset = 0;
      for (;;) {
        const page = await capture.readBytes(caller, objectId, offset);
        const chunk = Buffer.from(page.base64, "base64");
        chunks.push(chunk);
        offset += chunk.length;
        if (offset === page.totalBytes) break;
      }
      const raw = Buffer.concat(chunks);
      for (const [tool, output] of [
        ["Bash", result.stdout.toString()], ["capture_token_miser_command", summary],
        ["capture_token_miser_command", JSON.stringify(await capture.readBytes(caller, objectId, 0))],
      ] as const) {
        expect(await managed.preparePostToolUse({
          session_id: caller.threadId, turn_id: caller.turnId, hook_event_name: "PostToolUse",
          tool_name: tool, tool_use_id: "fixture", is_code_mode_nested: false,
          token_miser_acceptance_version: 1, token_miser_exact_tool_response_version: 1,
          tool_input: tool === "Bash" ? { command: native } : { objectId },
          tool_response: output, token_miser_exact_tool_response: output,
        })).toBeUndefined();
      }
      expect(generateSummary).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      if (command === "git diff") expect(raw.equals(run(command).stdout)).toBe(true);
      else {
        expect(raw.toString().match(/rendering π/g)).toHaveLength(1200);
        expect(raw.toString()).toContain("environment preserved in ");
        expect(raw.toString()).toContain(path.basename(dir));
      }
      await expect(capture.inspect({ ...caller, backend: "claude" }, objectId)).rejects.toThrow("unavailable");
      await expect(capture.inspect({ ...caller, turnId: "next" }, objectId)).rejects.toThrow("unavailable");
      enabled = false;
      await expect(capture.readBytes(caller, objectId, 0)).rejects.toThrow("unavailable");
      enabled = true;
      await capture.endTurn(caller);
      await expect(capture.inspect(caller, objectId)).rejects.toThrow("unavailable");
    }
    for (const cmd of ["git diff &", "git diff; pwd", "git diff\n", "pnpm test --watch", "node --test ../x.test.js"]) {
      await expect(capture.prepare(caller, cmd)).rejects.toThrow("unavailable");
    }
  } finally {
    await capture.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("on terminal delivery stops only the still-running native capture identified by this turn", async () => {
  const owner = { ...caller, backend: "codex" as const };
  const store = new TestTokenMiserStore("terminal-capture");
  const capture = new BoundedCommandCapture(() => store.issueOutputHandle(), async () => true, async () => true);
  try {
    const { command, objectId } = await capture.prepare(owner, "git diff");
    capture.observe(owner, { id: "item", processId: "123", command, completed: false });
    const stop = vi.fn();
    await capture.endTurn({ ...owner, turnId: "other" }, stop);
    expect(stop).not.toHaveBeenCalled();
    await capture.endTurn(owner, async (matches) => {
      const owned = { itemId: "item", processId: "123", command };
      for (const candidate of [owned, { ...owned, itemId: "other" }, { ...owned, processId: "456" }, { ...owned, command: "git diff" }]) {
        if (matches(candidate)) stop(candidate);
      }
    });
    expect(stop.mock.calls).toEqual([[{ itemId: "item", processId: "123", command }]]);
    await expect(capture.inspect(owner, objectId)).rejects.toThrow("unavailable");
  } finally {
    await capture.close();
  }
});

it.skipIf(process.platform === "win32")("classifies ambiguous hunks once within the approved helper scope", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bounded-hunks-"));
  const caller = { backend: "codex", threadId: "thread", turnId: "turn", transport: "codex_dynamic_tool" } as const;
  const select = vi.fn(async (_command: string, excerpts: string[], _signal: AbortSignal) => {
    expect(excerpts.length).toBe(3);
    expect(Buffer.byteLength(excerpts.join("\n"))).toBeLessThan(3000);
    return 1;
  });
  let helper = { identity: "fixture", label: "fixture", select };
  const approve = vi.fn(async () => true);
  const store = new TestTokenMiserStore(dir);
  const capture = new BoundedCommandCapture(() => store.issueOutputHandle(), async () => true, approve, () => helper);
  const run = (cmd: string) => spawnSync(shell, ["-c", cmd], { cwd: dir });
  try {
    run("git init -q");
    for (const file of ["a", "b", "c"]) await writeFile(path.join(dir, file), "old\n");
    run("git add a b c");
    for (const file of ["a", "b", "c"]) {
      await writeFile(path.join(dir, file), Array.from({ length: 700 }, (_, i) => `${file} detail ${i}\n`).join(""));
    }
    const captureDiff = async () => {
      const issued = await capture.prepare(caller, "git diff");
      const output = run(issued.command);
      capture.observe(caller, { id: issued.objectId, command: issued.command, completed: true, output: output.stdout.toString() });
      return issued.objectId;
    };
    const id = await captureDiff();
    expect(approve).toHaveBeenCalledWith(caller, "git diff", "fixture");
    const summaries = await Promise.all([capture.inspect(caller, id), capture.inspect(caller, id)]);
    expect(summaries[0]).toBe(summaries[1]);
    expect(summaries[0]).toContain("+b detail 0");
    store.startTurn(caller.threadId, caller.turnId);
    const [tool] = boundedCommandTools(capture, store);
    const deliveries = [];
    for (let i = 0; i < 16; i++) {
      const item = (await tool!.dispatch({ objectId: id }, caller)).contentItems?.[0];
      if (item?.type !== "inputText") throw new Error("Expected a native text result.");
      deliveries.push(i % 2 === 0 ? item.text : JSON.stringify({ objectId: id, summary: item.text }));
    }
    const cell = deliveries.join("\n");
    expect(cell.length).toBeGreaterThan(5000);
    const evaluate = vi.fn(async () => ({ status: "failed" as const, reason: "Unrelated output" }));
    const reducer = new TokenMiserService({ store, isEnabled: () => true, generateSummary: evaluate });
    const payload = { version: 1 as const, thread_id: caller.threadId, turn_id: caller.turnId, call_id: "cell-call",
      cell_id: "cell", script_status: "Script completed", max_output_tokens: 10000, model_visible_overhead_characters: 0 };
    await reducer.prepareCodeModeOutput({ ...payload, content_items: [{ type: "input_text", text: cell }] });
    expect(evaluate).not.toHaveBeenCalled();
    await reducer.prepareCodeModeOutput({ ...payload, call_id: "unrelated", content_items: [
      { type: "input_text", text: "unrelated output\n".repeat(1200) },
    ] });
    expect(evaluate).toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(1);
    const other = await captureDiff();
    helper = { ...helper, identity: "new provider" };
    expect(await capture.inspect(caller, other)).not.toContain("+b detail 0");
    expect(select).toHaveBeenCalledTimes(1);
    const failed = await captureDiff();
    select.mockRejectedValueOnce(new Error("offline"));
    expect(await capture.inspect(caller, failed)).toContain("git diff exited 0");
    expect(select).toHaveBeenCalledTimes(2);
    const pending = await captureDiff();
    const entered = Promise.withResolvers<AbortSignal>();
    select.mockImplementationOnce(async (_command, _excerpts, signal) => {
      entered.resolve(signal);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return 0;
    });
    const result = expect(capture.inspect(caller, pending)).rejects.toThrow("expired");
    const signal = await entered.promise;
    await capture.endTurn(caller);
    expect(signal.aborted).toBe(true);
    await result;
  } finally {
    await capture.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("keeps concurrent capture handles distinct through expiry and reissue", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "concurrent-captures-"));
  const store = new TestTokenMiserStore(dir);
  const capture = new BoundedCommandCapture(() => store.issueOutputHandle(), async () => true, async () => true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const tickets = await Promise.all(Array.from({ length: 24 }, () => capture.prepare(caller, "git diff")));
    expect(new Set(tickets.map((ticket) => ticket.objectId)).size).toBe(24);
    const split = vi.spyOn(mcpConnections, "splitMcpCommandLine");
    try {
      capture.observe(caller, { id: "unrelated", command: "/bin/sh -lc 'pwd'", completed: false });
      expect(split.mock.calls.length).toBeLessThanOrEqual(1);
    } finally { split.mockRestore(); }
    for (const ticket of tickets) {
      await expect(capture.inspect({ ...caller, threadId: "foreign" }, ticket.objectId)).rejects.toThrow("unavailable");
    }
    const ticket = tickets[0]!;
    expect(spawnSync("git", ["init", "-q"], { cwd: dir }).status).toBe(0);
    const executed = spawnSync(shell, ["-c", ticket.command], { cwd: dir, encoding: "utf8" });
    capture.observe(caller, { id: "first", command: ticket.command, completed: true, output: executed.stdout });
    expect(await capture.inspect(caller, ticket.objectId)).toContain("git diff exited");
    vi.advanceTimersByTime(300_001);
    const next = await capture.prepare(caller, "git diff");
    expect(tickets.some(({ objectId }) => objectId === next.objectId)).toBe(false);
    await expect(capture.readBytes(caller, ticket.objectId, 0)).rejects.toThrow("unavailable");
  } finally {
    vi.useRealTimers();
    await capture.close();
    await rm(dir, { recursive: true, force: true });
  }
});
