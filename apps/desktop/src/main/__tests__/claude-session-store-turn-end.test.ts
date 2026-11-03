import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppServerThreadEntry } from "@pwragent/shared";
import { ClaudeSessionStore, type ClaudeSession } from "../claude/claude-session-store";

const id = "e4444444-4444-4444-8444-444444444444";
const roots: string[] = [];

async function store(): Promise<{ root: string; store: ClaudeSessionStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-turn-end-"));
  roots.push(root);
  return { root, store: new ClaudeSessionStore(root) };
}

function message(entryId: string, turnId: string, text = entryId, status?: "in_progress"): AppServerThreadEntry {
  return {
    type: "message", id: entryId, role: "assistant", text,
    turn: { id: turnId, ...(status ? { status } : {}) },
  } as AppServerThreadEntry;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Claude history turn ends", () => {
  it("gives every entry of the turn its status, and leaves other turns alone", async () => {
    const { store: sessions } = await store();
    await sessions.append(id, [message("a", "turn-1", "a", "in_progress"), message("b", "turn-1"), message("c", "turn-2")]);
    await sessions.append(id, [], { turnId: "turn-1", status: "completed", startedAt: 10, completedAt: 20 });

    expect((await sessions.entries(id)).map((entry) => [entry.id, entry.turn])).toEqual([
      ["a", { id: "turn-1", status: "completed", startedAt: 10, completedAt: 20 }],
      ["b", { id: "turn-1", status: "completed", startedAt: 10, completedAt: 20 }],
      ["c", { id: "turn-2" }],
    ]);
  });

  it("writes entries and the turn end in one append, entries first", async () => {
    const { root, store: sessions } = await store();
    await sessions.append(id, [message("a", "turn-1")], { turnId: "turn-1", status: "cancelled", startedAt: 10, completedAt: 20 });

    const lines = (await readFile(path.join(root, `${id}.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([
      expect.objectContaining({ id: "a" }),
      { type: "pwragent_turn_end", turnId: "turn-1", status: "cancelled", startedAt: 10, completedAt: 20, createdAt: expect.any(Number) },
    ]);
    expect((await sessions.entries(id))[0].turn).toEqual({ id: "turn-1", status: "cancelled", startedAt: 10, completedAt: 20 });
  });

  it("covers a revision saved after the turn ended", async () => {
    const { store: sessions } = await store();
    await sessions.append(id, [message("task", "turn-1", "running")], { turnId: "turn-1", status: "completed", startedAt: 10, completedAt: 20 });
    // A background task's row settles after its turn, carrying the in-memory stamp.
    await sessions.append(id, [message("task", "turn-1", "settled")]);

    expect(await sessions.entries(id)).toEqual([
      expect.objectContaining({ text: "settled", turn: { id: "turn-1", status: "completed", startedAt: 10, completedAt: 20 } }),
    ]);
  });

  it("keeps truncation and its undo working around turn ends", async () => {
    const { store: sessions } = await store();
    await sessions.append(id, [message("a", "turn-1")], { turnId: "turn-1", status: "completed", startedAt: 1, completedAt: 2 });
    await sessions.append(id, [message("b", "turn-2")], { turnId: "turn-2", status: "completed", startedAt: 3, completedAt: 4 });
    const truncationId = await sessions.truncate(id, "b");
    expect((await sessions.entries(id)).map((entry) => entry.id)).toEqual(["a"]);
    expect(await sessions.canUndoTruncation(id, truncationId)).toBe(true);

    // A turn end after the truncation adds no entry, so the undo stays open.
    await sessions.append(id, [], { turnId: "turn-1", status: "completed", startedAt: 1, completedAt: 2 });
    expect(await sessions.canUndoTruncation(id, truncationId)).toBe(true);

    await sessions.undoTruncation(id, truncationId);
    expect((await sessions.entries(id)).map((entry) => [entry.id, entry.turn?.status])).toEqual([["a", "completed"], ["b", "completed"]]);

    const later = await sessions.truncate(id, "b");
    await sessions.append(id, [message("c", "turn-3")], { turnId: "turn-3", status: "completed" });
    expect(await sessions.canUndoTruncation(id, later)).toBe(false);
    expect((await sessions.entries(id)).map((entry) => [entry.id, entry.turn?.status])).toEqual([["a", "completed"], ["c", "completed"]]);
  });

  it("reads a file written before turn ends existed unchanged", async () => {
    const { root, store: sessions } = await store();
    const stamped = (entry: AppServerThreadEntry, status: string) => ({ ...entry, turn: { id: entry.turn!.id, status, startedAt: 1, completedAt: 2 } });
    const lines = [
      { ...message("a", "turn-1", "partial"), turn: { id: "turn-1", status: "in_progress" } },
      message("b", "turn-1"),
      stamped(message("a", "turn-1", "full"), "completed"),
      stamped(message("b", "turn-1"), "completed"),
      message("c", "turn-2"),
      stamped(message("c", "turn-2"), "failed"),
    ];
    await writeFile(path.join(root, `${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");

    expect(await sessions.entries(id)).toEqual([
      stamped(message("a", "turn-1", "full"), "completed"),
      stamped(message("b", "turn-1"), "completed"),
      stamped(message("c", "turn-2"), "failed"),
    ]);
  });

  it("skips a torn turn end", async () => {
    const { root, store: sessions } = await store();
    await sessions.append(id, [message("a", "turn-1", "a", "in_progress")]);
    await appendFile(path.join(root, `${id}.jsonl`), "{\"type\":\"pwragent_turn_end\",\"turnId\":\"tur");

    expect(await sessions.entries(id)).toEqual([message("a", "turn-1", "a", "in_progress")]);
  });

  it("applies turn ends to an ephemeral session's entries", async () => {
    const { store: sessions } = await store();
    const session: ClaudeSession = {
      cwd: "/fixture", ephemeral: true,
      thread: { id, source: "claude", title: "Task monitor", titleSource: "explicit", linkedDirectories: [] },
    };
    sessions.holdEphemeral(session);
    await sessions.append(id, [message("a", "turn-1", "first", "in_progress")]);
    await sessions.append(id, [message("a", "turn-1", "second")], { turnId: "turn-1", status: "failed", startedAt: 5 });

    expect(await sessions.entries(id)).toEqual([
      { ...message("a", "turn-1", "second"), turn: { id: "turn-1", status: "failed", startedAt: 5 } },
    ]);
  });
});
