import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { CodexAppServerClient } from "../dist/federation-core.js";
import { readMessages, MAX_RESPONSE_BYTES } from "./wire.js";

// The Outpost owns launch settings and process-group shutdown. RPC state and
// Codex normalization belong to the shared owner client.
class OutpostCodexTransport {
  constructor({ command, home, workspace, onFailure, onUnexpectedExit }) {
    Object.assign(this, { command, home, workspace, onFailure, onUnexpectedExit });
  }

  setMessageHandler(handler) { this.messageHandler = handler; }
  setCloseHandler(handler) { this.closeHandler = handler; }

  async connect() {
    if (this.child) return;
    this.stopping = false;
    const env = { ...process.env, CODEX_HOME: this.home };
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === "ELECTRON_RENDERER_URL") delete env[key];
    }
    this.child = spawn(this.command, ["app-server", "--listen", "stdio://"], {
      cwd: this.workspace, env, stdio: ["pipe", "pipe", "pipe"], detached: true,
    });
    this.closed = new Promise((resolve) => this.child.once("close", resolve));
    const fail = (error) => {
      this.closeHandler(error);
      if (!this.stopping) this.onFailure(error);
    };
    this.child.on("error", () => fail(new Error("Could not start Codex App Server")));
    this.child.on("exit", (code, signal) => {
      const unexpected = !this.stopping;
      // Record the host's uncertain outcome before the shared client emits
      // synthetic turn failures for a lost process.
      fail(new Error("Codex App Server exited"));
      if (unexpected) this.onUnexpectedExit({ code, signal, stderrPreview: [] });
    });
    this.child.stdin.on("error", () => fail(new Error("Codex App Server input closed")));
    // Provider diagnostics can contain private text; drain without journaling.
    this.child.stderr.resume();
    readMessages(this.child.stdout, MAX_RESPONSE_BYTES,
      (message) => {
        if (message.id !== undefined && typeof message.method !== "string" && !("result" in message) && !("error" in message)) {
          fail(new Error("Invalid Codex response"));
          return;
        }
        this.messageHandler(JSON.stringify(message));
      }, fail);
  }

  send(message) {
    if (this.stopping || !this.child) throw new Error("Codex is stopping");
    this.child.stdin.write(message + "\n");
  }

  async close() {
    if (!this.child) return;
    this.stopping = true;
    const signal = (name) => {
      if (!this.child.pid) return;
      try { process.kill(-this.child.pid, name); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    signal("SIGTERM");
    let timer;
    await Promise.race([this.closed, new Promise((resolve) => { timer = setTimeout(resolve, 2000); })]);
    clearTimeout(timer);
    signal("SIGKILL");
    await this.closed;
    this.child = null;
  }
}

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

export class Codex extends CodexAppServerClient {
  constructor({ command, home, workspace, onNotification, onRequest, onFailure, timeout = 30000 }) {
    const optionalTitleWork = new AsyncLocalStorage();
    const transport = new OutpostCodexTransport({ command, home, workspace, onFailure,
      onUnexpectedExit: () => {} });
    super({ env: { ...process.env, CODEX_HOME: home }, requestTimeoutMs: timeout,
      helperExecutionPolicy: { approvalPolicy: "never", sandbox: "read-only" } }, {
      createTransport: (callbacks) => { transport.onUnexpectedExit = callbacks.onUnexpectedExit; return transport; },
      clientInfo: { name: "pwragent-headless", title: "PwrAgent Headless" },
      onRequestFailure: (error) => {
        // Optional title setup, execution, cleanup and application can fail
        // without losing a user's turn. The async scope belongs to each caller,
        // so concurrent user requests retain their uncertain-outcome handling.
        if (!optionalTitleWork.getStore() && error instanceof Error && error.message.startsWith("json-rpc timeout:")) onFailure(error);
      },
      logger: quietLogger,
      rpcLogger: quietLogger,
      listingDiagnostics: { trace: (_stage, _fields, work) => work(), link() {} },
      authState: { isBlocked: () => false, assertAvailable() {} },
      signInRequiredMessage: "Codex is logged out. Please sign in again to resume operations.",
      buildShellEnvironment: (env) => env,
      buildSandboxPolicy: (sandbox, cwd = workspace) => {
        if (sandbox === undefined) return undefined;
        if (sandbox === "read-only") return { type: "readOnly", networkAccess: false };
        if (sandbox !== "workspace-write") throw new Error("Unsupported Outpost sandbox policy");
        return { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false,
          excludeTmpdirEnvVar: true, excludeSlashTmp: true };
      },
      enrichThreadDirectory: async () => ({ linkedDirectories: [] }),
      sampleAppServerProcessTree: async () => ({}),
    });
    this.hostTransport = transport;
    this.optionalTitleWork = optionalTitleWork;
    this.onNotification(onNotification);
    this.onRequest(onRequest);
  }

  get child() { return this.hostTransport.child; }
  runOptionalTitleWork(work) { return this.optionalTitleWork.run(true, work); }
  initialize() { return this.getInitializeResult(); }
  stop() { return this.close(); }
}
