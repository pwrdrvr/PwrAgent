import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  AppServerThreadMessageEntry,
  AppServerThreadReplay,
} from "@pwragent/shared/contracts/normalized-app-server";
import * as threadSystemMessages from "@pwragent/shared/contracts/thread-system-messages";
import { stackFileReadsFromItem, ThreadCorrespondenceStore, type CorrespondenceRecord } from "../app-server/thread-correspondence-store";
import { extractThreadReplayFromReadResult } from "../codex-app-server/desktop-client";

const emptyReplay: AppServerThreadReplay = {
  entries: [], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false },
};

function record(): CorrespondenceRecord {
  return {
    id: "correspondence:fixture",
    source: { backend: "acp:grok", threadId: "sender" },
    destination: { backend: "codex", threadId: "recipient", title: "Recipient" },
    input: [
      { type: "text", text: `# Unicode Ω\n\n${"full paragraph ".repeat(200)}\n\nTail.` },
      { type: "image", name: "diagram.png", url: "data:image/png;base64,AQID" },
      { type: "file", name: "notes.txt", mimeType: "text/plain", data: "AQID" },
    ],
    createdAt: 1_000,
    state: "sending",
  };
}

describe("PwrAgent correspondence persistence", () => {
  it("records successful provider-reported file reads and ignores searches and failed reads", () => {
    const item = { type: "commandExecution", commandActions: [
      { type: "read", path: "src/example.ts" }, { type: "search", path: "src" },
    ] };
    expect(stackFileReadsFromItem({ ...item, exitCode: 0 })).toEqual(["src/example.ts"]);
    expect(stackFileReadsFromItem({ ...item, exitCode: 1 })).toEqual([]);
    expect(stackFileReadsFromItem({ toolName: "read_file", arguments: { file_path: "README.md" } })).toEqual(["README.md"]);
    expect(stackFileReadsFromItem({ toolName: "write_file", data: { path: "README.md" } })).toEqual([]);
  });
  it("replays file-read provenance and deduplicates stack notices across a restart", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-stack-notice-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const message = record();
    const store = new ThreadCorrespondenceStore(directory);
    store.rememberStackReads(message.source, ["old.ts", "old.ts"]);
    store.flushStackReads(message.source);
    const reopened = new ThreadCorrespondenceStore(directory);
    expect(reopened.readStackPaths(message.source)).toEqual(["old.ts"]);
    const notice: CorrespondenceRecord = { ...message, id: "stack:op:layer", input: [], state: "started", stackNotice: {
      opId: "op", kind: "restack", branch: "layer", stack: "stack", by: { threadId: "lead", actor: "agent" },
      from: "old", to: "new", changedFiles: ["old.ts"], staleReads: ["old.ts"], undo: "refs/pwragent/undo/op",
    } };
    expect(reopened.record(notice)).toBe(true);
    reopened.rememberStackReads(message.source, ["new.ts"]);
    reopened.flushStackReads(message.source);
    const names = readdirSync(directory);
    expect(names.filter((name) => name.endsWith(".stack-reads.json"))).toHaveLength(1);
    for (const name of names.filter((name) => name.endsWith(".jsonl"))) {
      const entries = readFileSync(path.join(directory, name), "utf8").trim().split("\n");
      expect(entries.every((entry) => ["message", "status"].includes(JSON.parse(entry).type))).toBe(true);
    }
    const final = new ThreadCorrespondenceStore(directory);
    expect(final.record(notice)).toBe(false);
    expect(final.readStackPaths(message.source)).toEqual(["new.ts"]);
    expect(final.pendingStackNotices(message.source)).toEqual([
      { id: notice.id, text: expect.stringContaining('Reread "old.ts"') },
    ]);
  });
  it("replays a completion after the terminal turn as a standalone system item", () => {
    const turn = { id: "closed", startedAt: 10, completedAt: 30 };
    const entry: AppServerThreadMessageEntry = { type: "message", id: "response", role: "assistant", text: "Done", turn };
    const replay = { ...emptyReplay, messages: [entry], entries: [entry],
      pagination: { supportsPagination: true, hasPreviousPage: false } };
    for (const backend of ["codex", "claude", "acp:grok"] as const) {
      const source = { backend, threadId: "fixture" };
      const store = new ThreadCorrespondenceStore();
      store.record({ ...record(), id: "stack:op:", source, destination: source, createdAt: 50,
        input: [], state: "started", stackNotice: { opId: "op", kind: "add_branch", branch: "", stack: "",
          by: { threadId: source.threadId, actor: "agent" }, from: null, to: null, changedFiles: [],
          undo: "refs/pwragent/undo/op", completion: {} } });
      const merged = store.appendToReplay(source, replay);
      expect(merged.entries.map(({ id }) => id)).toEqual(["response", "stack:op:"]);
      expect(merged.entries[1]?.turn).toBeUndefined();
      expect(store.appendToReplay(source, replay, undefined, [], { before: "older" })).toEqual(replay);
    }
  });
  it("bounds legacy receipts on older pages without pricing for newer turns", () => {
    const store = new ThreadCorrespondenceStore();
    const message = record();
    store.record({ ...message, id: "older-send", createdAt: 1_500 });
    store.record({ ...message, id: "newer-send", createdAt: 3_500 });
    const page = (id: string, startedAt: number, completedAt?: number): AppServerThreadReplay => {
      const turn = { id, startedAt, completedAt };
      const entries: AppServerThreadMessageEntry[] = [
        { type: "message", id: `${id}-prompt`, role: "user", text: "Prompt", turn },
        { type: "message", id: `${id}-response`, role: "assistant", text: "Response", turn },
      ];
      return { entries, messages: entries, pagination: { supportsPagination: true, hasPreviousPage: false } };
    };
    const older = page("older", 1_000, 2_000);
    const merged = store.appendToReplay(message.source, older, undefined, [], { before: "newer-page" });
    expect(merged.entries.map((entry) => entry.id)).toEqual(["older-prompt", "older-response", "older-send"]);
    expect(merged.messages.map((entry) => entry.id)).toEqual(merged.entries.map((entry) => entry.id));

    const withoutBoundary = new ThreadCorrespondenceStore();
    withoutBoundary.record({ ...message, id: "older-send", createdAt: 1_500 });
    withoutBoundary.record({ ...message, id: "newer-send", createdAt: 3_500 });
    const undatedEnd = page("older", 1_000);
    expect(withoutBoundary.appendToReplay(message.source, undatedEnd, undefined, [], { before: "newer-page" })).toEqual(undatedEnd);
    // Reading the newer page supplies an upper boundary even when pricing and
    // provider completion times are both absent.
    withoutBoundary.appendToReplay(message.source, page("newer", 3_000));
    const bounded = withoutBoundary.appendToReplay(message.source, undatedEnd, undefined, [], { before: "newer-page" });
    expect(bounded.entries.map((entry) => entry.id)).toEqual(["older-prompt", "older-response", "older-send"]);
  });

  it("restores stored sends made while the source thread was idle", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-correspondence-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const source = { backend: "codex" as const, threadId: "sender" };
    const writer = new ThreadCorrespondenceStore(directory);
    const sends = [
      { id: "between-turns", createdAt: 30 },
      { id: "during-turn", createdAt: 50, sourceTurnId: "second" },
      { id: "after-turns-first", createdAt: 70 },
      { id: "after-turns-second", createdAt: 80 },
    ];
    for (const send of sends) {
      writer.record({ ...record(), ...send, source });
      writer.update(source, send.id, { state: "started" });
      expect(writer.message(source, send.id)?.text).toContain("Receiving thread started work");
    }

    const first: AppServerThreadMessageEntry = { type: "message", id: "first-response", role: "assistant",
      text: "First", turn: { id: "first", startedAt: 10, completedAt: 20 } };
    const second: AppServerThreadMessageEntry = { type: "message", id: "second-response", role: "assistant",
      text: "Second", createdAt: 60, turn: { id: "second", startedAt: 40, completedAt: 60 } };
    const page = (entries: AppServerThreadMessageEntry[], hasPreviousPage: boolean): AppServerThreadReplay => ({
      ...emptyReplay, entries, messages: entries, pagination: { supportsPagination: true, hasPreviousPage },
    });
    const reader = new ThreadCorrespondenceStore(directory);
    const latest = reader.appendToReplay(source, page([second], true));
    const coldOlder = writer.appendToReplay(source, page([first], false), undefined, [], { before: "cursor" });
    expect(coldOlder.entries).toEqual([first]);
    const older = reader.appendToReplay(source, page([first], false), undefined, [], { before: "cursor" });
    const expectedOrder = ["first-response", "between-turns", "during-turn", "second-response", "after-turns-first", "after-turns-second"];
    // A complete read and a newest-to-oldest traversal own the same receipts once.
    expect([...older.entries, ...latest.entries].map(({ id }) => id)).toEqual(expectedOrder);
    expect([...older.messages, ...latest.messages].map(({ id }) => id)).toEqual(expectedOrder);
    const merged = reader.appendToReplay(source, page([first, second], false));
    expect(merged.entries.map(({ id }) => id)).toEqual(expectedOrder);
    expect(merged.entries.filter(({ id }) => sends.some((send) => send.id === id)).map(({ turn }) => turn?.id))
      .toEqual([undefined, "second", undefined, undefined]);
    expect(merged.messages.filter(({ id }) => sends.some((send) => send.id === id)).map(({ text }) => text))
      .toEqual(sends.map(({ id }) => writer.message(source, id)?.text));
    expect(reader.appendToReplay(source, merged)).toEqual(merged);
  });

  it("formats only receipts owned by the requested page", () => {
    const heading = vi.spyOn(threadSystemMessages, "buildThreadCorrespondenceHeading");
    onTestFinished(() => { heading.mockRestore(); });
    const store = new ThreadCorrespondenceStore();
    const message = record();
    for (const id of ["older", "latest"]) {
      store.record({ ...message, id: `send-${id}`, sourceTurnId: id });
    }
    const entry: AppServerThreadMessageEntry = { type: "message", id: "latest-response", role: "assistant",
      text: "Latest", turn: { id: "latest", startedAt: 500 } };
    const replay = { ...emptyReplay, entries: [entry], messages: [entry],
      pagination: { supportsPagination: true, hasPreviousPage: true } };
    const merged = store.appendToReplay(message.source, replay);
    expect(merged.entries.map(({ id }) => id)).toEqual(["latest-response", "send-latest"]);
    expect(heading).toHaveBeenCalledTimes(1);
  });

  it("assigns a receipt to the same Codex turn on split and full reads when start seconds tie", () => {
    const store = new ThreadCorrespondenceStore();
    const source = { backend: "codex" as const, threadId: "sender" };
    const turnRow = (id: string, startedAt: number): AppServerThreadMessageEntry => ({
      type: "message", id: id.slice(-1), role: "assistant", text: "Reply",
      turn: { id, startedAt, completedAt: startedAt + 200 },
    });
    const older = turnRow("00000000-03e9-7000-8000-000000000001", 1_000);
    const later = turnRow("00000000-03ea-7000-8000-000000000002", 1_000);
    const newest = turnRow("00000000-07d0-7000-8000-000000000003", 2_000);
    const receipt = { ...record(), source, createdAt: 1_500 };
    store.record(receipt);
    const page = (entries: AppServerThreadMessageEntry[], hasPreviousPage: boolean): AppServerThreadReplay => ({
      ...emptyReplay, entries, messages: entries, pagination: { supportsPagination: true, hasPreviousPage },
    });
    store.appendToReplay(source, page([newest], true));
    const middle = store.appendToReplay(source, page([later], true), undefined, [], { before: "newest" });
    const oldest = store.appendToReplay(source, page([older], false), undefined, [], { before: "later" });
    expect(middle.entries.map(({ id }) => id)).toEqual([later.id, receipt.id]);
    expect(oldest.entries.map(({ id }) => id)).toEqual([older.id]);
    expect(store.appendToReplay(source, page([older, later, newest], false)).entries.map(({ id }) => id))
      .toEqual([older.id, later.id, receipt.id, newest.id]);
  });

  it("returns to a warm page without scanning older receipts or discarding newer sends", () => {
    const store = new ThreadCorrespondenceStore();
    const message = record();
    store.record({ ...message, id: "older-send", createdAt: 1_100 });
    store.record({ ...message, id: "latest-send", createdAt: 3_500 });
    const entry: AppServerThreadMessageEntry = { type: "message", id: "latest-response", role: "assistant",
      text: "Latest", turn: { id: "latest", startedAt: 3_000, completedAt: 3_200 } };
    const replay = { ...emptyReplay, entries: [entry], messages: [entry],
      pagination: { supportsPagination: true, hasPreviousPage: true } };
    store.appendToReplay(message.source, replay);

    const stored: Map<string, Map<string, CorrespondenceRecord>> = Reflect.get(store, "records");
    const scan = vi.spyOn(stored.values().next().value!, "values");
    onTestFinished(() => { scan.mockRestore(); });
    store.record({ ...message, id: "late-recorded-send", createdAt: 3_400 });
    store.record({ ...message, id: "tied-send", createdAt: 3_500 });
    store.update(message.source, "latest-send", { state: "started" });
    const returned = store.appendToReplay(message.source, replay);
    expect(returned.entries.map(({ id }) => id)).toEqual([
      "latest-response", "late-recorded-send", "latest-send", "tied-send",
    ]);
    expect(returned.messages.find(({ id }) => id === "latest-send")?.text).toContain("Receiving thread started work");
    expect(scan).not.toHaveBeenCalled();
  });

  it("restores idle sends on the first page of a thread with no provider rows", () => {
    const store = new ThreadCorrespondenceStore();
    const message = record();
    store.record(message);
    const page = { ...emptyReplay, pagination: { supportsPagination: true, hasPreviousPage: false } };
    const merged = store.appendToReplay(message.source, page);
    expect(merged.entries).toEqual([store.message(message.source, message.id)]);
    expect(merged.messages).toEqual(merged.entries);
    expect(store.appendToReplay(message.source, page, undefined, [], { before: "exhausted" })).toEqual(page);
    expect(store.appendToReplay(message.source, page, undefined, [], { limit: 0 })).toEqual(page);
  });

  it("places legacy sends after earlier request usage and before the turn total", () => {
    const store = new ThreadCorrespondenceStore();
    const message = { ...record(), createdAt: 3_000 };
    store.record(message);
    const turn = { id: "source-turn", startedAt: 1_000, completedAt: 5_000 };
    const prompt: AppServerThreadMessageEntry = { type: "message", id: "prompt", role: "user", text: "Prompt", turn };
    const response: AppServerThreadMessageEntry = { type: "message", id: "response", role: "assistant", text: "Response", createdAt: 4_000, turn };
    const replay: AppServerThreadReplay = {
      ...emptyReplay,
      entries: [
        prompt,
        { type: "activity", id: "live-token-usage-request", summary: "Latest request usage: 100 tokens", details: [], createdAt: 2_000, turn },
        response,
        { type: "activity", id: "live-turn-usage-source-turn", summary: "Turn usage: 200 tokens", details: [], createdAt: 5_000, turn },
      ],
      messages: [prompt, response],
    };
    const merged = store.appendToReplay(message.source, replay);
    expect(merged.entries.map((entry) => entry.id)).toEqual([
      "prompt", "live-token-usage-request", message.id, "response", "live-turn-usage-source-turn",
    ]);
    expect(merged.messages.map((entry) => entry.id)).toEqual(["prompt", message.id, "response"]);
  });

  it("preserves exhausted and zero-limit pages while supporting standalone receipt lookup", () => {
    const store = new ThreadCorrespondenceStore();
    const message = record();
    store.record(message);
    const exhausted: AppServerThreadReplay = { ...emptyReplay, pagination: { supportsPagination: true, hasPreviousPage: false } };
    expect(store.appendToReplay(message.source, exhausted, undefined, [], { before: "unknown-cursor" })).toEqual(exhausted);
    expect(store.appendToReplay(message.source, exhausted, undefined, [], { limit: 0 })).toEqual(exhausted);
    expect(store.message(message.source, message.id)?.id).toBe(message.id);
  });

  it("weaves legacy deliveries through undated Codex turns across days and pages after reload", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-correspondence-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const store = new ThreadCorrespondenceStore(directory);
    const source = { backend: "codex" as const, threadId: "sender" };
    const starts = [7, 8, 9, 10].map((day) => Date.UTC(2026, 9, day, 12));
    const turns = starts.map((startedAt, index) => {
      const hex = startedAt.toString(16).padStart(12, "0");
      return {
        id: `${hex.slice(0, 8)}-${hex.slice(8)}-7000-8000-000000000000`,
        status: "completed",
        items: [
          { type: "userMessage", id: `user-${index}`, content: [{ type: "text", text: "Prompt" }] },
          { type: "agentMessage", id: `response-${index}`, text: `Response ${index}`, phase: "final" },
        ],
      };
    });
    starts.forEach((startedAt, index) => store.record({
      ...record(), source, id: `delivery-${index}`, createdAt: startedAt + 60_000,
    }));
    const restored = new ThreadCorrespondenceStore(directory);
    const replay = extractThreadReplayFromReadResult({ thread: { id: source.threadId, turns } });
    expect(replay.entries.every((entry) => entry.createdAt === undefined)).toBe(true);
    const merged = restored.appendToReplay(source, replay);
    expect(merged.entries.map((entry) => entry.id)).toEqual(turns.flatMap((_turn, index) => [
      `user-${index}`, `response-${index}`, `delivery-${index}`,
    ]));
    expect(merged.messages.map((entry) => entry.id)).toEqual(merged.entries.map((entry) => entry.id));
    expect(restored.appendToReplay(source, merged)).toEqual(merged);

    const knownTurns = turns.map((turn, index) => ({ id: turn.id, startedAt: starts[index] }));
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const page = extractThreadReplayFromReadResult({ thread: { id: source.threadId, turns: [turns[index]] } });
      page.pagination = { supportsPagination: true, hasPreviousPage: index > 0 };
      const result = restored.appendToReplay(source, page, undefined, knownTurns);
      expect(result.entries.map((entry) => entry.id)).toEqual([
        `user-${index}`, `response-${index}`, `delivery-${index}`,
      ]);
      expect(result.messages.map((entry) => entry.id)).toEqual(result.entries.map((entry) => entry.id));
    }
  });

  it("anchors a send to its source tool call within a multi-day turn without item timestamps", () => {
    const store = new ThreadCorrespondenceStore();
    const message = { ...record(), sourceTurnId: "source-turn", sourceItemId: "send-call" };
    store.record(message);
    const replay = extractThreadReplayFromReadResult({ thread: { turns: [{
      id: "source-turn", status: "completed", items: [
        { type: "userMessage", id: "prompt", content: [{ type: "text", text: "Prompt" }] },
        { type: "dynamicToolCall", id: "send-call", tool: "send_message_to_thread", arguments: {} },
        { type: "agentMessage", id: "response", text: "Response", phase: "final" },
      ],
    }] } });
    const merged = store.appendToReplay(message.source, replay);
    expect(merged.entries.map((entry) => entry.id)).toEqual([
      "prompt", "activity-send-call", message.id, "response",
    ]);
    expect(merged.messages.map((entry) => entry.id)).toEqual(["prompt", message.id, "response"]);
    expect(store.appendToReplay(message.source, merged)).toEqual(merged);
    const otherPage = { ...replay, entries: replay.entries.map((entry) => ({ ...entry, turn: { id: "other-turn" } })) };
    expect(store.appendToReplay(message.source, otherPage).entries.map((entry) => entry.id)).not.toContain(message.id);
  });

  it("writes the body once, retains terminal evidence over a late queued receipt, and reloads after rollup", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-correspondence-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const store = new ThreadCorrespondenceStore(directory);
    const message = record();
    store.record(message);
    store.update(message.source, message.id, { state: "queued", queueEntryId: "queue-one" });
    store.update(message.source, message.id, { state: "cancelled" });
    store.update(message.source, message.id, { state: "queued" }, true);
    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]+\.jsonl$/);
    const lines = readFileSync(path.join(directory, files[0]!), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.filter((event) => event.record?.input)).toHaveLength(1);
    const replay = new ThreadCorrespondenceStore(directory).appendToReplay(message.source, emptyReplay);
    expect(replay.messages[0]?.origin).toEqual({
      kind: "pwragent", systemReason: "thread-correspondence", sourceThread: message.source, correspondenceRevision: 4,
    });
    expect(store.message(message.source, message.id)?.origin).toEqual(replay.messages[0]?.origin);
    expect(replay.messages[0]?.text).toContain("**Message to [Recipient]");
    expect(replay.messages[0]?.text).toContain(" · Cancelled");
    expect(replay.messages[0]?.text).toContain("Tail.");
    expect(replay.messages[0]?.parts).toContainEqual({ type: "image", url: "data:image/png;base64,AQID", alt: "diagram.png" });
    expect(store.appendToReplay(message.source, replay).entries).toHaveLength(1);
  });

  it("merges historical correspondence chronologically after reload without reordering provider entries", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-correspondence-"));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const store = new ThreadCorrespondenceStore(directory);
    const message = record();
    // Arrival order need not match creation order.
    store.record({ ...message, id: "later-send", createdAt: 3_000 });
    store.record(message);
    store.update(message.source, message.id, { state: "cancelled" });
    const providerMessages: AppServerThreadMessageEntry[] = [
      { type: "message", id: "first-user", role: "user", text: "First", createdAt: 500 },
      { type: "message", id: "first-response", role: "assistant", text: "Response", createdAt: 1_000 },
      { type: "message", id: "next-user", role: "user", text: "Next", turn: { id: "next-turn", startedAt: 2_000 } },
      { type: "message", id: "next-response", role: "assistant", text: "Response", createdAt: 4_000 },
    ];
    const replay: AppServerThreadReplay = {
      ...emptyReplay,
      entries: [
        ...providerMessages.slice(0, 2),
        { type: "activity", id: "undated-activity", summary: "Work", details: [] },
        ...providerMessages.slice(2),
      ],
      messages: providerMessages.map(({ turn: _turn, ...entry }) => entry),
    };
    const restored = new ThreadCorrespondenceStore(directory);
    const merged = restored.appendToReplay(message.source, replay);
    expect(merged.entries.map((entry) => entry.id)).toEqual([
      "first-user", "first-response", "undated-activity", message.id,
      "next-user", "later-send", "next-response",
    ]);
    expect(merged.messages.map((entry) => entry.id)).toEqual([
      "first-user", "first-response", message.id, "next-user", "later-send", "next-response",
    ]);
    expect(merged.messages.find((entry) => entry.id === message.id)?.text).toContain(" · Cancelled");
    expect(restored.appendToReplay(message.source, merged)).toEqual(merged);
  });

  it("does not let a peer with the same thread id update local correspondence", () => {
    const store = new ThreadCorrespondenceStore();
    const message = record();
    store.record(message);
    store.update({ ...message.source, instanceId: "peer-instance" }, message.id, { state: "cancelled" });
    expect(store.message(message.source, message.id)?.text).toContain("Send outcome unknown");
    expect(store.message({ ...message.source, instanceId: "peer-instance" }, message.id)).toBeUndefined();
  });

  it("keeps message-only replays in timestamp order and leaves arbitrary provider turn ids opaque", () => {
    const store = new ThreadCorrespondenceStore();
    const message = record();
    store.record(message);
    const messages: AppServerThreadMessageEntry[] = [
      { type: "message", id: "before", role: "user", text: "Before", createdAt: 500 },
      { type: "message", id: "after", role: "assistant", text: "After", createdAt: 1_500 },
    ];
    const replay = { ...emptyReplay, messages };
    const merged = store.appendToReplay(message.source, replay);
    expect(merged.messages.map((entry) => entry.id)).toEqual(["before", message.id, "after"]);
    expect(store.appendToReplay(message.source, merged)).toEqual(merged);
    const codexSource = { ...message.source, backend: "codex" as const };
    store.record({ ...message, source: codexSource });
    const opaque = store.appendToReplay(codexSource, {
      ...emptyReplay, entries: messages.map((entry) => ({ ...entry, turn: { id: "ffffffff-ffff-4000-8000-000000000000" } })), messages,
    });
    expect(opaque.entries.map((entry) => entry.id)).toEqual(["before", message.id, "after"]);
    expect(opaque.entries.find((entry) => entry.id === message.id)?.turn).toBeUndefined();
  });

  it("reports unknown send outcomes, held and failed states without calling a queue delivered", () => {
    const store = new ThreadCorrespondenceStore();
    const message = record();
    store.record(message);
    expect(store.appendToReplay(message.source, emptyReplay).messages[0]?.text).toContain("Send outcome unknown");
    store.update(message.source, message.id, { state: "held" });
    expect(store.appendToReplay(message.source, emptyReplay).messages[0]?.text).toContain("Held for retry");
    store.update(message.source, message.id, { state: "failed" });
    expect(store.appendToReplay(message.source, emptyReplay).messages[0]?.text).toContain("Failed to send");
  });

  it("names the destination and distinguishes a started turn from its reply", () => {
    const store = new ThreadCorrespondenceStore();
    const message = record();
    store.record(message);
    store.update(message.source, message.id, { state: "started", turnId: "turn-one" });
    const entry = store.appendToReplay(message.source, emptyReplay).messages[0];
    expect(entry?.text).toContain("**Message to [Recipient]");
    expect(entry?.text).toContain("Receiving thread started work");
  });

  it("writes a heading the transcript can parse back", () => {
    const store = new ThreadCorrespondenceStore();
    const message = record();
    store.record(message);
    store.update(message.source, message.id, { state: "started", turnId: "turn-one" });
    const entry = store.appendToReplay(message.source, emptyReplay).messages[0];
    const parsed = threadSystemMessages.parseThreadCorrespondenceMessage(entry?.text ?? "");
    expect(parsed).toMatchObject({
      destination: {
        backend: message.destination.backend,
        threadId: message.destination.threadId,
        messageId: "user:turn-one",
        title: "Recipient",
      },
      state: "started",
    });
    expect(parsed?.body).toBe(message.input.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n"));
  });
});
