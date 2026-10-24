import { spawn } from "node:child_process";
import { readMessages, MAX_RESPONSE_BYTES } from "./wire.js";

// This adapter deliberately supports only the stable App Server job surface.
// It never reads Codex's storage or imports Electron/desktop modules.
export class Codex {
  constructor({ command, home, workspace, onNotification, onRequest, onFailure, timeout = 30000 }) {
    this.pending = new Map();
    this.sequence = 0;
    this.timeout = timeout;
    this.onFailure = onFailure;
    const env = { ...process.env, CODEX_HOME: home };
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === "ELECTRON_RENDERER_URL") delete env[key];
    }
    this.child = spawn(command, ["app-server", "--listen", "stdio://"], {
      cwd: workspace,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // A dedicated group lets shutdown reap ordinary descendants on POSIX.
      detached: true,
    });
    this.closed = new Promise((resolve) => this.child.once("close", resolve));
    this.child.on("error", () => this.fail(new Error("Could not start Codex App Server")));
    this.child.on("exit", () => this.fail(new Error("Codex App Server exited")));
    this.child.stdin.on("error", () => this.fail(new Error("Codex App Server input closed")));
    // Drain diagnostics without copying potentially sensitive provider text to
    // the journal. Request errors are returned to the private local client.
    this.child.stderr.resume();
    readMessages(this.child.stdout, MAX_RESPONSE_BYTES, (message) => {
      if (typeof message.method === "string") {
        if (message.id !== undefined) onRequest(message);
        else onNotification(message);
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) return;
      if (!("error" in message) && !("result" in message)) {
        this.fail(new Error("Invalid Codex response"));
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message || "Codex request failed"));
      else if ("result" in message) request.resolve(message.result);
    }, (error) => this.fail(error));
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    if (!this.stopping) this.onFailure(error);
  }

  send(message) {
    if (this.failure || this.stopping) throw this.failure || new Error("Codex is stopping");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  request(method, params) {
    if (this.failure || this.stopping) return Promise.reject(this.failure || new Error("Codex is stopping"));
    if (this.pending.size >= 32) return Promise.reject(new Error("Too many pending Codex requests"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timeout may mean a mutation executed but its reply was lost.
        // Stop the runtime; never retry an uncertain turn/start.
        this.fail(new Error(`Codex request timed out: ${method}`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.fail(error);
      }
    });
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "pwragent-headless", title: "PwrAgent Headless", version: "0.0.0" },
      capabilities: { experimentalApi: false },
    });
    this.send({ method: "initialized", params: {} });
  }

  async stop() {
    this.stopping = true;
    this.fail(new Error("Codex stopped"));
    const signal = (name) => {
      if (!this.child.pid) return;
      try {
        process.kill(-this.child.pid, name);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    signal("SIGTERM");
    let timer;
    await Promise.race([this.closed, new Promise((resolve) => { timer = setTimeout(resolve, 2000); })]);
    clearTimeout(timer);
    // Also reap descendants that outlived the group leader. systemd's cgroup
    // owns processes that deliberately leave this group.
    signal("SIGKILL");
    await this.closed;
  }
}
