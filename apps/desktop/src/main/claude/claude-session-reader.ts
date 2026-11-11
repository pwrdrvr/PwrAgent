import { getOwnerHostServices } from "../owner-host";
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSessionReads, ClaudeSessionReader, ClaudeSessionReadRequest, ClaudeSessionReadReply, ClaudeSessionReaderChild } from "./claude-session-reader-contracts";
export type { ClaudeSessionReads, ClaudeSessionReader, ClaudeSessionReadRequest, ClaudeSessionReadReply, ClaudeSessionReaderChild } from "./claude-session-reader-contracts";

/**
 * The reader itself failed: it did not start, stopped, timed out or was
 * closed. Unlike an SDK error for one read, it says nothing about the session.
 */
export class ClaudeSessionReaderError extends Error {}

/** Reading a long session file can take seconds; a stuck reader cannot hold a rewind. */
const CLAUDE_SESSION_READ_TIMEOUT_MS = 30_000;

/**
 * Run the SDK's session reads in a Node child process started with `env`.
 *
 * The SDK reads sessions under its own process's CLAUDE_CONFIG_DIR, not the
 * environment Claude launches with, and has no option to point it elsewhere.
 * Changing this process's environment would race other SDK calls and leak
 * into every child, so the reads run where Claude's environment applies.
 */
export function openClaudeSessionReader(
  env: NodeJS.ProcessEnv,
  options: {
    /** The built `claude-session-reader-worker.js`, next to the main entry. */
    workerPath: string;
    fork?: (env: NodeJS.ProcessEnv) => Promise<ClaudeSessionReaderChild>;
    timeoutMs?: number;
  },
): ClaudeSessionReader {
  const timeoutMs = options.timeoutMs ?? CLAUDE_SESSION_READ_TIMEOUT_MS;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let nextId = 1;
  let ended: Error | undefined;
  let child: ClaudeSessionReaderChild | undefined;
  const end = (error: Error) => {
    ended ??= error;
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      pending.delete(id);
      request.reject(ended);
    }
    child?.kill();
  };
  const fork = options.fork ?? (async (forkEnv: NodeJS.ProcessEnv) => await forkClaudeSessionReader(options.workerPath, forkEnv));
  const started = fork(env).then((forked) => {
    child = forked;
    if (ended) {
      forked.kill();
      throw ended;
    }
    forked.on("message", (reply) => {
      const request = pending.get(reply.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(reply.id);
      if (reply.error !== undefined) request.reject(new Error(`Claude's conversation could not be read: ${reply.error}`));
      else request.resolve(reply.result);
    });
    forked.once("exit", () => end(new ClaudeSessionReaderError("Claude's conversation could not be read: the reader stopped.")));
    return forked;
  }, (error: unknown) => {
    throw ended ?? new ClaudeSessionReaderError(`Claude's conversation could not be read: ${error instanceof Error ? error.message : String(error)}`);
  });
  // A failed start rejects each read; it must not also go unhandled here.
  started.catch(() => {});
  const request = async (
    method: ClaudeSessionReadRequest["method"], sessionId: string, readOptions?: { dir?: string }, agentId?: string,
  ) => {
    if (ended) throw ended;
    const forked = await started;
    if (ended) throw ended;
    const id = nextId++;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => end(new ClaudeSessionReaderError("Claude's conversation could not be read in time.")), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      forked.postMessage({
        id, method, sessionId, ...(agentId ? { agentId } : {}),
        ...(readOptions?.dir ? { options: { dir: readOptions.dir } } : {}),
      });
    });
  };
  return {
    getSessionMessages: async (sessionId, readOptions) =>
      await request("getSessionMessages", sessionId, readOptions) as SessionMessage[],
    getSessionInfo: async (sessionId, readOptions) =>
      await request("getSessionInfo", sessionId, readOptions) as SDKSessionInfo | undefined,
    getSubagentMessages: async (sessionId, agentId, readOptions) =>
      await request("getSubagentMessages", sessionId, readOptions, agentId) as SessionMessage[],
    close: () => end(new ClaudeSessionReaderError("Claude's session reader was closed.")),
  };
}

/** Answer one request from the main process with the SDK's own reads. */
export async function answerClaudeSessionRead(
  request: ClaudeSessionReadRequest,
  reads: ClaudeSessionReads,
): Promise<ClaudeSessionReadReply> {
  try {
    let result: unknown;
    if (request.method === "getSessionMessages") {
      result = await reads.getSessionMessages(request.sessionId, request.options);
    } else if (request.method === "getSubagentMessages") {
      if (!request.agentId) throw new Error("A sub-agent read needs the agent's id.");
      result = await reads.getSubagentMessages(request.sessionId, request.agentId, request.options);
    } else {
      result = await reads.getSessionInfo(request.sessionId, request.options);
    }
    return { id: request.id, result };
  } catch (error) {
    return { id: request.id, error: error instanceof Error ? error.message : String(error) };
  }
}

async function forkClaudeSessionReader(workerPath: string, env: NodeJS.ProcessEnv): Promise<ClaudeSessionReaderChild> {
  return await getOwnerHostServices().workers.forkClaudeSessionReader(workerPath, env);
}
