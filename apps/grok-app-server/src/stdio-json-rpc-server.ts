import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ProcessAppServer } from "./process-app-server.js";

type JsonRpcId = string | number | null;

type JsonRpcEnvelope = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

export type StdioJsonRpcServerOptions = {
  server: ProcessAppServer;
  input?: Readable;
  output?: Writable;
  diagnostics?: Writable;
  exit?: (code: number) => void;
};

export function runStdioJsonRpcServer(
  options: StdioJsonRpcServerOptions,
): () => void {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const diagnostics = options.diagnostics ?? process.stderr;
  const exit = options.exit ?? ((code) => process.exit(code));
  const reader = readline.createInterface({ input });
  const pendingClientResponses = new Map<
    JsonRpcId,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
    }
  >();
  let requestCounter = 0;
  let stopped = false;
  let outputQueue = Promise.resolve();

  const writeEnvelope = async (envelope: JsonRpcEnvelope): Promise<void> => {
    outputQueue = outputQueue.then(
      async () =>
        await new Promise<void>((resolve, reject) => {
          output.write(`${JSON.stringify(envelope)}\n`, (error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    );
    await outputQueue;
  };

  const unsubscribeNotification = options.server.onNotification(
    async (notification) => {
      await writeEnvelope({
        jsonrpc: "2.0",
        method: notification.method,
        params: notification.params ?? {},
      });
    },
  );
  const unsubscribeRequest = options.server.onRequest(async (method, params) => {
    const id = `server-${++requestCounter}`;
    const response = new Promise<unknown>((resolve, reject) => {
      pendingClientResponses.set(id, { resolve, reject });
    });
    await writeEnvelope({
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    });
    return await response;
  });

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    reader.close();
    unsubscribeNotification();
    unsubscribeRequest();
    for (const pending of pendingClientResponses.values()) {
      pending.reject(new Error("Grok app-server transport closed"));
    }
    pendingClientResponses.clear();
  };

  reader.on("line", (line) => {
    void handleLine(line).catch((error) => {
      writeDiagnostic(diagnostics, "failed to handle JSON-RPC message", error);
    });
  });
  reader.on("close", stop);
  reader.on("error", (error) => {
    writeDiagnostic(diagnostics, "stdin failed", error);
    stop();
  });

  async function handleLine(line: string): Promise<void> {
    let envelope: JsonRpcEnvelope;
    try {
      envelope = JSON.parse(line) as JsonRpcEnvelope;
    } catch {
      await writeEnvelope({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    if (typeof envelope.method === "string") {
      if (envelope.id === undefined) {
        await options.server.notify(envelope.method, envelope.params);
        return;
      }
      try {
        const result = await options.server.request(envelope.method, envelope.params);
        await writeEnvelope({
          jsonrpc: "2.0",
          id: envelope.id,
          result: result ?? {},
        });
        if (options.server.shouldShutdown()) {
          stop();
          setTimeout(() => exit(0), 0);
        }
      } catch (error) {
        await writeEnvelope({
          jsonrpc: "2.0",
          id: envelope.id,
          error: {
            code: readErrorCode(error),
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }

    if (envelope.id === undefined) {
      return;
    }
    const pending = pendingClientResponses.get(envelope.id);
    if (!pending) {
      return;
    }
    pendingClientResponses.delete(envelope.id);
    if (envelope.error) {
      pending.reject(new Error(envelope.error.message ?? "Desktop request failed"));
      return;
    }
    pending.resolve(envelope.result);
  }

  return stop;
}

function readErrorCode(error: unknown): number {
  if (
    error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "number"
  ) {
    return error.code;
  }
  return -32603;
}

export function writeDiagnostic(
  output: Writable,
  message: string,
  error?: unknown,
): void {
  const suffix =
    error === undefined
      ? ""
      : `: ${error instanceof Error ? error.message : String(error)}`;
  output.write(`[grok-app-server] ${message}${suffix}\n`);
}
