import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("../fixtures/compile-app-icon.cjs", import.meta.url));

export function compileAppIcon(iconPackage, outputDir, timeoutMs) {
  return new Promise((resolve, reject) => {
    // electron-builder owns the actool invocation but exposes no cancellation.
    // Keep that call in a macOS process group owned by the test.
    const child = spawn(process.execPath, [helper, iconPackage, outputDir], {
      detached: true,
      env: { ...process.env, TMPDIR: outputDir },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    const deadline = setTimeout(() => {
      timedOut = true;
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") reject(error);
      }
    }, timeoutMs);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      if (timedOut) reject(new Error(`actool icon compilation timed out after ${timeoutMs} ms`));
      else if (code === 0) resolve();
      else reject(new Error(`electron-builder icon compilation failed (${signal ?? code})\n${stderr}`));
    });
  });
}
