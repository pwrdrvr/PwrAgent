import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppServerThreadEntry } from "@pwragent/shared";
import { ClaudeSessionStore, type ClaudeSession } from "../claude/claude-session-store";

const id = "e3333333-3333-4333-8333-333333333333";
const roots: string[] = [];

async function store(): Promise<{ root: string; store: ClaudeSessionStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-ephemeral-"));
  roots.push(root);
  return { root, store: new ClaudeSessionStore(root) };
}

function session(): ClaudeSession {
  return {
    cwd: "/fixture",
    ephemeral: true,
    thread: { id, source: "claude", title: "Task monitor", titleSource: "explicit", linkedDirectories: [] },
  };
}

function entry(text: string): AppServerThreadEntry {
  return { id: "message-1", type: "message", role: "assistant", text } as AppServerThreadEntry;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ephemeral Claude sessions", () => {
  it("live in memory, are never listed, and never touch disk", async () => {
    const { root, store: sessions } = await store();
    sessions.holdEphemeral(session());
    const read = await sessions.read(id);
    read.sdkSessionId = "sdk-1";
    await sessions.save(read);
    await sessions.append(id, [entry("first")]);
    await sessions.append(id, [entry("revised")]);

    await expect(sessions.read(id)).resolves.toMatchObject({ ephemeral: true, sdkSessionId: "sdk-1" });
    await expect(sessions.entries(id)).resolves.toEqual([entry("revised")]);
    await expect(sessions.list()).resolves.toEqual([]);
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("stay gone after they are forgotten, even if a late write arrives", async () => {
    const { root, store: sessions } = await store();
    sessions.holdEphemeral(session());
    sessions.forgetEphemeral(id);
    await sessions.save(session());
    await sessions.append(id, [entry("late")]);

    await expect(sessions.read(id)).rejects.toThrow();
    await expect(readdir(root)).resolves.toEqual([]);
  });
});
