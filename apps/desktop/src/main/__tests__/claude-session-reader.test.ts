import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  answerClaudeSessionRead, openClaudeSessionReader,
  type ClaudeSessionReadReply, type ClaudeSessionReadRequest,
} from "../claude/claude-session-reader";

/** A utility process that answers when the test says so. */
function fakeChild() {
  const events = new EventEmitter();
  const posted: ClaudeSessionReadRequest[] = [];
  return {
    posted,
    kill: vi.fn(() => true),
    postMessage: (message: ClaudeSessionReadRequest) => { posted.push(message); },
    on: (_event: "message", listener: (reply: ClaudeSessionReadReply) => void) => events.on("message", listener),
    once: (_event: "exit", listener: (code: number) => void) => events.once("exit", listener),
    reply: (reply: ClaudeSessionReadReply) => { events.emit("message", reply); },
    exit: (code: number) => { events.emit("exit", code); },
  };
}

const WORKER = "/app/out/main/claude-session-reader-worker.js";

/** Let the reader's start and posts settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Claude session reader", () => {
  it("starts with the given environment and answers each read by its id", async () => {
    const child = fakeChild();
    const fork = vi.fn(async (_env: NodeJS.ProcessEnv) => child);
    const env = { CLAUDE_CONFIG_DIR: "/accounts/second", PATH: "/usr/bin" };
    const reader = openClaudeSessionReader(env, { workerPath: WORKER, fork });

    const messages = reader.getSessionMessages("session-1", { dir: "/work/project" });
    const info = reader.getSessionInfo("session-1");
    await settle();
    expect(fork).toHaveBeenCalledWith(env);
    expect(child.posted).toEqual([
      { id: 1, method: "getSessionMessages", sessionId: "session-1", options: { dir: "/work/project" } },
      { id: 2, method: "getSessionInfo", sessionId: "session-1" },
    ]);
    // Answers can arrive in any order.
    child.reply({ id: 2, result: { sessionId: "session-1" } });
    child.reply({ id: 1, result: [{ uuid: "prompt" }] });
    await expect(messages).resolves.toEqual([{ uuid: "prompt" }]);
    await expect(info).resolves.toEqual({ sessionId: "session-1" });

    reader.close();
    expect(child.kill).toHaveBeenCalled();
    await expect(reader.getSessionInfo("session-1")).rejects.toThrow("closed");
  });

  it("reports the SDK's error for one read", async () => {
    const child = fakeChild();
    const reader = openClaudeSessionReader({}, { workerPath: WORKER, fork: async () => child });
    const read = reader.getSessionMessages("session-1");
    await settle();
    child.reply({ id: 1, error: "EACCES: permission denied" });
    await expect(read).rejects.toThrow("Claude's conversation could not be read: EACCES: permission denied");
    reader.close();
  });

  it("rejects every read once the reader stops", async () => {
    const child = fakeChild();
    const reader = openClaudeSessionReader({}, { workerPath: WORKER, fork: async () => child });
    const read = reader.getSessionMessages("session-1");
    await settle();
    child.exit(1);
    await expect(read).rejects.toThrow("Claude's conversation could not be read: the reader stopped.");
    await expect(reader.getSessionInfo("session-1")).rejects.toThrow("the reader stopped.");
  });

  it("stops a reader that does not answer in time", async () => {
    const child = fakeChild();
    const reader = openClaudeSessionReader({}, { workerPath: WORKER, fork: async () => child, timeoutMs: 10 });
    await expect(reader.getSessionMessages("session-1")).rejects.toThrow("Claude's conversation could not be read in time.");
    expect(child.kill).toHaveBeenCalled();
  });

  it("stops a reader that starts after it was closed", async () => {
    const child = fakeChild();
    const forked = Promise.withResolvers<typeof child>();
    const reader = openClaudeSessionReader({}, { workerPath: WORKER, fork: () => forked.promise });
    const read = reader.getSessionMessages("session-1");
    reader.close();
    forked.resolve(child);
    await expect(read).rejects.toThrow("closed");
    expect(child.kill).toHaveBeenCalled();
    expect(child.posted).toEqual([]);
  });

  it("names a failed start in each read", async () => {
    const reader = openClaudeSessionReader({}, { workerPath: WORKER, fork: async () => { throw new Error("spawn failed"); } });
    await expect(reader.getSessionMessages("session-1")).rejects.toThrow("Claude's conversation could not be read: spawn failed");
    await expect(reader.getSessionInfo("session-1")).rejects.toThrow("spawn failed");
  });

  it("answers a request with the matching SDK read", async () => {
    const reads = {
      getSessionMessages: vi.fn(async () => [{ uuid: "prompt" }] as never),
      getSessionInfo: vi.fn(async () => { throw new Error("unreadable"); }),
    };
    await expect(answerClaudeSessionRead(
      { id: 3, method: "getSessionMessages", sessionId: "session-1", options: { dir: "/work" } }, reads,
    )).resolves.toEqual({ id: 3, result: [{ uuid: "prompt" }] });
    expect(reads.getSessionMessages).toHaveBeenCalledWith("session-1", { dir: "/work" });
    await expect(answerClaudeSessionRead({ id: 4, method: "getSessionInfo", sessionId: "session-1" }, reads))
      .resolves.toEqual({ id: 4, error: "unreadable" });
  });
});
