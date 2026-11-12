import { spawn } from "node:child_process";

// Exit status of the probe when it could read the protected file.
const PROTECTED_FILE_READABLE = 86;

// Use Codex's native sandbox entry point, without a model turn or access to
// Codex-owned files. It applies the Outpost's workspace-write permission
// profile and proves that profile denies the Outpost's own state: the probe
// must fail to read `protectedFile` (the owner lock, never a secret; its
// output is discarded).
export function checkCodexSandbox({ command, home, workspace, permissionOverrides, profile, protectedFile, timeout = 10000, signal }) {
  const checkedAt = new Date().toISOString();
  if (!permissionOverrides?.length || !profile || !protectedFile) {
    return Promise.resolve({ status: "failed", checkedAt, error: "Codex sandbox preflight requires the Outpost permission profile." });
  }
  return new Promise((resolve) => {
    const child = spawn(command, ["sandbox", ...permissionOverrides.flatMap(value => ["-c", value]),
      "-c", "approval_policy=\"never\"", "-P", profile, "--",
      "/bin/sh", "-c", `if cat -- "$1" >/dev/null 2>&1; then exit ${PROTECTED_FILE_READABLE}; fi`, "sh", protectedFile], {
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
      else if (!failure && code === PROTECTED_FILE_READABLE) resolve({ status: "failed", checkedAt,
        error: "Codex sandbox preflight failed: sandboxed commands can read the Outpost's state directory. Use a Codex release that enforces permission-profile deny entries." });
      else resolve({ status: "failed", checkedAt,
        error: `Codex sandbox preflight failed (${failure || (exitSignal ? `signal ${exitSignal}` : `exit ${code}`)}): ${stderr.trim() || "sandbox command could not run"}` });
    });
  });
}
