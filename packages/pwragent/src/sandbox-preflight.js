import { spawn } from "node:child_process";

// Use Codex's native sandbox entry point, without a model turn or access to
// Codex-owned files. The policy matches the Outpost's workspace-write turns.
export function checkCodexSandbox({ command, home, workspace, timeout = 10000, signal }) {
  const checkedAt = new Date().toISOString();
  const probe = process.platform === "darwin" ? "/usr/bin/true" : "/bin/true";
  return new Promise((resolve) => {
    const child = spawn(command, ["sandbox", "-c", "sandbox_mode=\"workspace-write\"",
      "-c", "approval_policy=\"never\"", "-c", `sandbox_workspace_write.writable_roots=${JSON.stringify([workspace])}`,
      "-c", "sandbox_workspace_write.network_access=false", "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      "-c", "sandbox_workspace_write.exclude_slash_tmp=true", "--", probe], {
      cwd: workspace, env: { ...process.env, CODEX_HOME: home },
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
