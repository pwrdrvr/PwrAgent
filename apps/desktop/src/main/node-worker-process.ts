import { fork, type Serializable } from "node:child_process";
import { getMainLogger } from "./log";

const log = getMainLogger("pwragent:owner-worker");
export interface NodeOwnerWorker<Request = unknown, Reply = unknown> {
  postMessage(message: Request): void;
  on(event: "message", listener: (reply: Reply) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  kill(): boolean;
}

/** Node IPC in both hosts. Packaged Electron explicitly supports runAsNode. */
export function forkOwnerWorker<Request = unknown, Reply = unknown>(entry: string, env: NodeJS.ProcessEnv = process.env): NodeOwnerWorker<Request, Reply> {
  const child = fork(entry, [], {
    env: { ...env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
    execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
  });
  const exited = new Promise<number>((resolve) => {
    child.once("exit", (code) => resolve(code ?? -1));
    child.once("error", (error) => {
      log.warn("owner worker failed", { entry, error: error.message });
      resolve(-1);
    });
  });
  return {
    postMessage: (message) => { child.send(message as Serializable); },
    on: (_event, listener) => child.on("message", (message) => listener(message as Reply)),
    once: (_event, listener) => exited.then(listener),
    kill: () => child.kill(),
  };
}
