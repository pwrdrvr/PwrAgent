import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { spawn } from "node-pty";
import { FederationPtyService } from "../dist/federation-core.js";

const request = { backend: "codex", threadId: "fixture", cols: 80, rows: 24 };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// Model: shutdown owns every admitted spawn until its exit is observed,
// including shells that have already left the viewer's session list.
for (const phase of ["registered", "spawning", "disconnected", "reaped", "worktree-removal"]) {
  test(`PTY shutdown waits for owner-observed exit: ${phase}`, async () => {
    const spawning = deferred();
    const admission = deferred();
    const listeners = new Set();
    const pty = {
      write() {}, resize() {}, pause() {}, resume() {}, kill() {}, destroy() {},
      onData: () => ({ dispose() {} }),
      onExit: (listener) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    };
    const service = new FederationPtyService({
      resolveThreadCwd: async () => process.cwd(),
      spawnPty: async () => { admission.resolve(); await spawning.promise; return { pty, cwd: process.cwd(), shell: { file: "/bin/bash", args: [] } }; },
      sendNotification: () => true,
      graceMs: 0,
    });
    const opening = service.open("viewer", request).catch(() => undefined);
    await admission.promise;
    if (phase !== "spawning") { spawning.resolve(); await opening; }
    if (phase === "disconnected" || phase === "reaped") service.notifyPeerDisconnected("viewer");
    if (phase === "reaped") await new Promise((resolve) => setTimeout(resolve, 0));
    const removing = phase === "worktree-removal"
      ? service.withWorktreeClosed(process.cwd(), async () => {}) : Promise.resolve();
    if (phase === "worktree-removal") await setImmediate();
    let stopped = false;
    const disposal = service.disposeAll();
    const stopping = disposal.then(() => { stopped = true; });
    spawning.resolve();
    await setImmediate();
    try {
      assert.equal(stopped, false, "shutdown returned while its PTY was still alive");
      assert.equal(service.disposeAll(), disposal, "concurrent shutdown shares one completion");
    } finally {
      for (const listener of [...listeners]) listener({ exitCode: 0 });
      await opening;
      await stopping;
      await removing;
    }
    assert.equal(stopped, true);
    assert.equal(listeners.size, 0);
  });
}

test("PTY shutdown uses OS exit as its oracle even when bash ignores SIGHUP", { skip: process.platform === "win32", timeout: 5000 }, async (t) => {
  const pty = spawn("/bin/bash", ["--noprofile", "--norc"], {
    cwd: process.cwd(), cols: 80, rows: 24, env: { ...process.env, TERM: "xterm-256color" },
  });
  const exited = deferred();
  const exitListener = pty.onExit(() => exited.resolve());
  // The fixture owns forced cleanup even if readiness or shutdown regresses.
  t.after(() => { pty.kill("SIGKILL"); pty.destroy(); });
  const ready = deferred();
  let output = "";
  const dataListener = pty.onData((data) => { output += data; if (output.includes("\r\nHUP_IGNORED\r\n")) ready.resolve(); });
  const service = new FederationPtyService({
    resolveThreadCwd: async () => process.cwd(),
    spawnPty: async () => ({ pty, cwd: process.cwd(), shell: { file: "/bin/bash", args: [] } }),
    sendNotification: () => true,
  });
  try {
    await service.open("viewer", request);
    pty.write("trap '' HUP; printf '\\nHUP_IGNORED\\n'\n");
    await ready.promise;
    await service.disposeAll();
    assert.throws(() => process.kill(pty.pid, 0), { code: "ESRCH" }, "shutdown returned with a live shell");
  } finally {
    pty.kill("SIGKILL");
    pty.destroy();
    await exited.promise;
    dataListener.dispose();
    exitListener.dispose();
    await service.disposeAll();
  }
});
