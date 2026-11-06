import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * The SDK session reads a rewind needs. `dir` is the only option they pass,
 * because the reads may cross a process boundary.
 */
export type ClaudeSessionReads = {
  getSessionMessages(sessionId: string, options?: { dir?: string }): Promise<SessionMessage[]>;
  getSessionInfo(sessionId: string, options?: { dir?: string }): Promise<SDKSessionInfo | undefined>;
};

export type ClaudeSessionReader = ClaudeSessionReads & { close(): void };

export type ClaudeSessionReadRequest = {
  id: number;
  method: keyof ClaudeSessionReads;
  sessionId: string;
  options?: { dir?: string };
};

export type ClaudeSessionReadReply = { id: number; result?: unknown; error?: string };

/**
 * The reader itself failed: it did not start, stopped, timed out or was
 * closed. Unlike an SDK error for one read, it says nothing about the session.
 */
export class ClaudeSessionReaderError extends Error {}

/** The utility process, as far as the reader uses it. */
export type ClaudeSessionReaderChild = {
  postMessage(message: ClaudeSessionReadRequest): void;
  on(event: "message", listener: (reply: ClaudeSessionReadReply) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  kill(): boolean;
};

/** Reading a long session file can take seconds; a stuck reader cannot hold a rewind. */
const CLAUDE_SESSION_READ_TIMEOUT_MS = 30_000;

/**
 * Run the SDK's session reads in a utility process started with `env`.
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
  const request = async (method: ClaudeSessionReadRequest["method"], sessionId: string, readOptions?: { dir?: string }) => {
    if (ended) throw ended;
    const forked = await started;
    if (ended) throw ended;
    const id = nextId++;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => end(new ClaudeSessionReaderError("Claude's conversation could not be read in time.")), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      forked.postMessage({ id, method, sessionId, ...(readOptions?.dir ? { options: { dir: readOptions.dir } } : {}) });
    });
  };
  return {
    getSessionMessages: async (sessionId, readOptions) =>
      await request("getSessionMessages", sessionId, readOptions) as SessionMessage[],
    getSessionInfo: async (sessionId, readOptions) =>
      await request("getSessionInfo", sessionId, readOptions) as SDKSessionInfo | undefined,
    close: () => end(new ClaudeSessionReaderError("Claude's session reader was closed.")),
  };
}

/** Answer one request from the main process with the SDK's own reads. */
export async function answerClaudeSessionRead(
  request: ClaudeSessionReadRequest,
  reads: ClaudeSessionReads,
): Promise<ClaudeSessionReadReply> {
  try {
    const result = request.method === "getSessionMessages"
      ? await reads.getSessionMessages(request.sessionId, request.options)
      : await reads.getSessionInfo(request.sessionId, request.options);
    return { id: request.id, result };
  } catch (error) {
    return { id: request.id, error: error instanceof Error ? error.message : String(error) };
  }
}

async function forkClaudeSessionReader(workerPath: string, env: NodeJS.ProcessEnv): Promise<ClaudeSessionReaderChild> {
  const { utilityProcess } = await import("electron");
  const child = utilityProcess.fork(workerPath, [], {
    env,
    stdio: "ignore",
    serviceName: "PwrAgent Claude session reader",
  });
  return {
    postMessage: (message) => child.postMessage(message),
    on: (_event, listener) => child.on("message", listener),
    once: (_event, listener) => child.once("exit", listener),
    kill: () => child.kill(),
  };
}
