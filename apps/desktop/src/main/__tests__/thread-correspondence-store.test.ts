import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { AppServerThreadMessageEntry, AppServerThreadReplay } from "@pwragent/shared";
import { ThreadCorrespondenceStore, type CorrespondenceRecord } from "../app-server/thread-correspondence-store";

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
    expect(replay.messages[0]?.text).toContain("**Cancelled**");
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
    expect(merged.messages.find((entry) => entry.id === message.id)?.text).toContain("**Cancelled**");
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
});
