import { spawn } from "node:child_process";
import { createOutpostRuntimePolicy, ownerCodexIsolationArgs } from "../dist/outpost-runtime-policy.js";

// Use Codex's native sandbox entry point, without a model turn or access to
// Codex-owned files. An unsupported permissions runtime fails closed.
export function checkCodexSandbox({ command, home, workspace, timeout = 10000, signal }) {
  const checkedAt = new Date().toISOString();
  const probe = process.platform === "darwin" ? "/usr/bin/true" : "/bin/true";
  return new Promise((resolve) => {
    const env = { ...process.env, CODEX_HOME: home, PWRAGENT_CODEX_HOME: home };
    const child = spawn(command, ["sandbox", ...ownerCodexIsolationArgs(createOutpostRuntimePolicy(env), env),
      "-P", "pwragent-workspace-write", "--", probe], {
      cwd: workspace, env,
      stdio: ["ignore", "ignore", "pipe"], detached: true,
    });
    let stderr = "";
    let failure;
    const kill = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") failure ||= error.message; }
    };
    const abort = () => { failure = "cancelled"; kill(); };
    const timer = setTimeout(() => { failure = `timed out after ${timeout} ms`; kill(); }, timeout);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(0, 4096); });
    child.on("error", error => { failure = error.message; });
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      kill();
      if (!failure && code === 0) resolve({ status: "ready", checkedAt });
      else resolve({ status: "failed", checkedAt,
        error: `Codex sandbox preflight failed (${failure || (exitSignal ? `signal ${exitSignal}` : `exit ${code}`)}): ${stderr.trim() || "sandbox command could not run"}` });
    });
  });
}
