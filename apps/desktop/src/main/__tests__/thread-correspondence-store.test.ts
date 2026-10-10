import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { AppServerThreadMessageEntry, AppServerThreadReplay } from "@pwragent/shared";
import { ThreadCorrespondenceStore, type CorrespondenceRecord } from "../app-server/thread-correspondence-store";
import { extractThreadReplayFromReadResult } from "../codex-app-server/client";

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
    expect(replay.messages[0]?.origin).toEqual({ kind: "pwragent", systemReason: "thread-correspondence" });
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
});
