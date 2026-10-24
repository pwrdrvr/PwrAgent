import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntegratedTerminalSessionSummary, TerminalSnapshot } from "../../shared/integrated-terminal";
import { TerminalReplay } from "../terminal/terminal-replay";
import { TerminalOutputReader, type TerminalOutputSource } from "../terminal/terminal-output-reader";
import { combineTerminalOutputSources } from "../terminal/terminal-output-source";
import { buildTerminalOutputToolDefinitions } from "../agent-tools/pwragent-terminal-output-tools";
import { resolveAgentToolCatalogs } from "../agent-tools/agent-tool-catalog-registry";
import { searchPwrAgentTools } from "../agent-tools/pwragent-tool-search";
import { AgentToolRouter } from "../agent-tools/agent-tool-router";

const context = { backend: "codex" as const, threadId: "current" };
const address = { ownerInstanceId: "owner", terminalId: "terminal" };
const replays: TerminalReplay[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(replays.splice(0).map((replay) => replay.dispose()));
});
function fixture() {
  const replay = new TerminalReplay(80, 24);
  replays.push(replay);
  const sessions: IntegratedTerminalSessionSummary[] = [{
    sessionId: "terminal", threadKey: "codex:current", name: "Build", cwd: "/repo", shell: "/bin/sh",
    createdAt: 1, status: "running", panelHidden: true,
  }, { sessionId: "other", threadKey: "codex:other", cwd: "/private", shell: "/bin/sh", createdAt: 2, panelHidden: false }];
  const source: TerminalOutputSource = {
    ownerInstanceId: () => "owner",
    list: async (ctx) => sessions.filter((session) => session.threadKey === `${ctx.backend}:${ctx.threadId}`),
    replay: (_ctx, id) => sessions.find((session) => session.sessionId === id)?.status === "running" ? replay : undefined,
    snapshot: async () => undefined,
  };
  return { source, sessions, replay, reader: new TerminalOutputReader(source) };
}

describe("current-thread terminal output", () => {
  it("lists canonical owner identity, metadata and raw cursor range only for the current backend/thread", async () => {
    const { reader, replay } = fixture();
    replay.append("hello", 123);
    const list = await reader.list(context);
    expect(list).toMatchObject({ ownerInstanceId: "owner", backend: "codex", threadId: "current", untrusted: true });
    expect(list.terminals).toHaveLength(1);
    expect(list.terminals[0]).toMatchObject({ terminalId: "terminal", launchCwd: "/repo", name: "Build", shell: "/bin/sh", createdAt: 1,
      status: "running", rawAvailable: true, availableRange: { firstSeq: 1, lastSeq: 1, firstTimestamp: 123, lastTimestamp: 123 } });
    expect((await reader.list({ ...context, backend: "acp:claude" })).terminals).toEqual([]);
  });

  it("returns raw ANSI event deltas with timestamps and bounded progress", async () => {
    const { reader, replay } = fixture();
    replay.append("\x1b[31mfirst", 10);
    replay.append("second", 20);
    const first = await reader.read(context, { ...address, format: "raw", maxChars: 10 });
    expect(first).toMatchObject({ kind: "event_delta", frames: [{ seq: 1, timestamp: 10, data: "\x1b[31mfirst" }], nextSeq: 1, truncated: false, hasMore: true });
    const second = await reader.read(context, { ...address, format: "raw", cursor: first.nextCursor!, maxChars: 10 });
    expect(second).toMatchObject({ frames: [{ seq: 2, timestamp: 20, data: "second" }], nextSeq: 2, hasMore: false });
    expect(await reader.read(context, { ...address, format: "raw", cursor: second.nextCursor! })).toMatchObject({ frames: [], hasMore: false });
  });

  it("reports eviction and oversized frames as gaps with advancing cursors", async () => {
    const { reader, replay } = fixture();
    const start = (await reader.list(context)).terminals[0]!.availableRange!.endCursor;
    replay.append("x".repeat(256 * 1024 + 1), 10);
    replay.append("too big", 20);
    replay.append("ok", 30);
    const skipped = await reader.read(context, { ...address, format: "raw", cursor: start, maxChars: 2 });
    expect(skipped).toMatchObject({ frames: [], nextSeq: 2, truncated: true, gap: true, hasMore: true });
    expect(await reader.read(context, { ...address, format: "raw", cursor: skipped.nextCursor!, maxChars: 2 }))
      .toMatchObject({ frames: [{ seq: 3, data: "ok" }], gap: false, hasMore: false });
  });

  it("normalizes the rendered screen and continues the same immutable snapshot during new output", async () => {
    const { reader, replay } = fixture();
    replay.append("old\r\x1b[2K\x1b[32mready\x1b[0m\r\nnext\x1b]52;c;SECRETDATA\x07", 10);
    const first = await reader.read(context, { ...address, format: "plain", maxChars: 5 });
    expect(first).toMatchObject({ kind: "screen_snapshot", data: "ready", seq: 1, timestamp: 10, hasMore: true, untrusted: true });
    replay.append("NEW", 20);
    const next = await reader.read(context, { ...address, format: "plain", cursor: first.nextCursor!, maxChars: 5 });
    expect(next).toMatchObject({ data: "\nnext", seq: 1, timestamp: 10, hasMore: false, nextCursor: null });
    expect(await reader.read(context, { ...address, format: "plain" })).toMatchObject({ data: "ready\nnextNEW", seq: 2 });
  });

  it("never splits Unicode and reports a gap for a budget too small for one character", async () => {
    const { reader, replay } = fixture();
    replay.append("😀ok");
    const first = await reader.read(context, { ...address, format: "plain", maxChars: 1 });
    expect(first).toMatchObject({ data: "", nextOffset: 2, gap: true, truncated: true, hasMore: true });
    expect(await reader.read(context, { ...address, format: "plain", maxChars: 2, cursor: first.nextCursor! }))
      .toMatchObject({ data: "ok", hasMore: false });
  });

  it("rejects forged terminal, owner, thread, format, runtime and tampered cursors", async () => {
    const { reader, source, replay, sessions } = fixture();
    replay.append("abcdef");
    const cursor = (await reader.read(context, { ...address, format: "raw" })).nextCursor!;
    await expect(reader.read(context, { ...address, ownerInstanceId: "other-owner", format: "raw" })).rejects.toThrow("owner");
    await expect(reader.read(context, { ...address, terminalId: "other", format: "raw" })).rejects.toThrow("scope");
    await expect(reader.read({ ...context, threadId: "other" }, { ...address, format: "raw" })).rejects.toThrow("scope");
    await expect(reader.read(context, { ...address, format: "plain", cursor })).rejects.toThrow("cursor");
    await expect(reader.read(context, { ...address, format: "raw", cursor: `${cursor}x` })).rejects.toThrow("cursor");
    await expect(new TerminalOutputReader(source).read(context, { ...address, format: "raw", cursor })).rejects.toThrow("cursor");
    sessions.push({ ...sessions[0]!, sessionId: "second" });
    await expect(reader.read(context, { ...address, terminalId: "second", format: "raw", cursor })).rejects.toThrow("cursor");
    sessions[0]!.createdAt++;
    await expect(reader.read(context, { ...address, format: "raw", cursor })).rejects.toThrow("cursor");
  });

  it.each(["exited", "restored"] as const)("reads %s saved screen without claiming persisted raw output", async (status) => {
    const { source, sessions } = fixture();
    sessions[0]!.status = status;
    const snapshot: TerminalSnapshot = { data: "\x1b[31mSaved\x1b[0m", seq: 42, timestamp: 99, cols: 80, rows: 24, truncated: true };
    source.snapshot = async () => snapshot;
    const reader = new TerminalOutputReader(source);
    expect((await reader.list(context)).terminals[0]).toMatchObject({ status, rawAvailable: false, availableRange: null });
    expect(await reader.read(context, { ...address, format: "raw" })).toMatchObject({ available: false, rawHistoryPersisted: false, frames: [], nextCursor: null });
    expect(await reader.read(context, { ...address, format: "plain" })).toMatchObject({ data: "Saved", seq: 42, timestamp: 99, truncated: true, rawAvailable: false });
  });

  it("bounds plain continuation memory and reports expired snapshots", async () => {
    const { reader, replay } = fixture();
    replay.append("abcdef");
    const first = await reader.read(context, { ...address, format: "plain", maxChars: 1 });
    for (let i = 0; i < 32; i++) await reader.read(context, { ...address, format: "plain", maxChars: 1 });
    await expect(reader.read(context, { ...address, format: "plain", cursor: first.nextCursor! })).rejects.toThrow("expired");
    const last = await reader.read(context, { ...address, format: "plain", maxChars: 1 });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_001);
    await expect(reader.read(context, { ...address, format: "plain", cursor: last.nextCursor! })).rejects.toThrow("expired");
    vi.restoreAllMocks();
  });

  it("caps frame envelope count without dropping tiny output events", async () => {
    const { reader, replay } = fixture();
    for (let i = 0; i < 140; i++) replay.append("x");
    const page = await reader.read(context, { ...address, format: "raw", maxChars: 65536 });
    expect(page).toMatchObject({ nextSeq: 128, truncated: false, hasMore: true });
    expect("frames" in page && page.frames).toHaveLength(128);
    const next = await reader.read(context, { ...address, format: "raw", cursor: page.nextCursor! });
    expect("frames" in next && next.frames).toHaveLength(12);
    expect(next).toMatchObject({ nextSeq: 140, hasMore: false, gap: false });
  });

  it("bounds oversized screen captures and revokes cached pages when a terminal closes", async () => {
    const { reader, replay, sessions } = fixture();
    replay.append("x".repeat(100_000));
    const page = await reader.read(context, { ...address, format: "plain", maxChars: 65536 });
    expect(page).toMatchObject({ truncated: true, hasMore: false });
    expect("data" in page && page.data.length).toBeLessThanOrEqual(65536);
    const first = await reader.read(context, { ...address, format: "plain", maxChars: 5 });
    sessions.splice(0, 1);
    await expect(reader.read(context, { ...address, format: "plain", cursor: first.nextCursor! })).rejects.toThrow("scope");
  });

  it("refuses to combine a source from another instance even with identical thread IDs", async () => {
    const { source } = fixture();
    const reader = new TerminalOutputReader(combineTerminalOutputSources(() => "owner", [{ ...source, ownerInstanceId: () => "other" }]));
    await expect(reader.list(context)).rejects.toThrow("different owning instance");
  });

  it("refuses ambiguous canonical IDs across owner services", async () => {
    const { source } = fixture();
    const reader = new TerminalOutputReader(combineTerminalOutputSources(() => "owner", [source, source]));
    await expect(reader.list(context)).rejects.toThrow("Ambiguous");
    await expect(reader.read(context, { ...address, format: "raw" })).rejects.toThrow("Ambiguous");
  });
});

describe("terminal tool contracts and discovery", () => {
  it("advertises exactly two read-only tools in unified thread inspection and search", () => {
    const definitions = buildTerminalOutputToolDefinitions();
    expect(definitions.map((entry) => entry.name)).toEqual(["list_thread_terminals", "read_terminal_output"]);
    expect(definitions.every((entry) => entry.namespace === "pwragent")).toBe(true);
    const catalogs = resolveAgentToolCatalogs({});
    const tools = searchPwrAgentTools(catalogs.flatMap((catalog) => catalog.dynamicTools), "list_thread_terminals read_terminal_output", 1);
    expect(tools.map((tool) => tool.name)).toEqual(definitions.map((entry) => entry.name));
    expect(catalogs.find((catalog) => catalog.id === "thread_inspection")!.router.buildMcpTools().map((tool) => tool.name))
      .toEqual(expect.arrayContaining(definitions.map((entry) => entry.name)));
    expect(searchPwrAgentTools(catalogs.flatMap((catalog) => catalog.dynamicTools), "console output logs")[0]!.name).toBe("read_terminal_output");
  });

  it.each(["codex_dynamic_tool", "mcp"] as const)("uses only authenticated current thread in %s dispatch", async (transport) => {
    const { reader, replay } = fixture();
    replay.append("safe");
    const definition = buildTerminalOutputToolDefinitions(reader).find((entry) => entry.name === "read_terminal_output")!;
    const callContext = { ...context, transport };
    expect(await definition.dispatch({ ...address, format: "plain" }, callContext)).toMatchObject({ ok: true, data: { threadId: "current", data: "safe" } });
    for (const forged of [{ threadId: "other" }, { backend: "acp:claude" }, { peerId: "peer" }, { input: "rm" }, { command: "echo" }]) {
      expect(await definition.dispatch({ ...address, format: "raw", ...forged }, callContext)).toMatchObject({ ok: false, code: "invalid_arguments" });
    }
    expect(await definition.dispatch({ ...address, format: "raw" }, { ...callContext, threadId: "" })).toMatchObject({ ok: false, code: "forbidden" });
    for (const maxChars of [0, -1, 1.5, 65537, Infinity, "100"]) {
      expect(await definition.dispatch({ ...address, format: "raw", maxChars }, callContext)).toMatchObject({ ok: false, code: "invalid_arguments" });
    }
  });

  it("dispatches identical owner-scoped reads via MCP and dynamic tool routers", async () => {
    const { reader, replay } = fixture();
    replay.append("data");
    const router = new AgentToolRouter(buildTerminalOutputToolDefinitions(reader));
    const mcp = await router.handleMcpToolCall({ ...context, tool: "read_terminal_output", args: { ...address, format: "plain" } });
    expect(mcp.isError).not.toBe(true);
    expect(mcp.structuredContent).toMatchObject({ ownerInstanceId: "owner", threadId: "current", data: "data" });
    const dynamic = await router.handleDynamicToolCall({ backend: "codex", call: { namespace: "pwragent", tool: "list_thread_terminals", arguments: {}, threadId: "current", turnId: "turn", callId: "call" } });
    expect(dynamic.success).toBe(true);
  });
});
