// A `gh` that is installed but not logged in, for `PWRAGENT_GH_COMMAND`.
//
// Discovery accepts it, because `--version` answers the way gh does. Every
// other command fails, so the PR status poller's token read raises the
// "GitHub PR status unavailable" notice whatever the runner's own `gh` can
// do. A shell script, so POSIX only.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const STAND_IN_GH = [
  "#!/bin/sh",
  "if [ \"$1\" = \"--version\" ]; then",
  "  echo \"gh version 2.99.0 (2026-10-01)\"",
  "  exit 0",
  "fi",
  "echo \"You are not logged into any GitHub hosts.\" >&2",
  "exit 1",
  "",
].join("\n");

/** Write the stand-in under `root` and return its path. */
export async function writeLoggedOutGh(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const ghPath = path.join(root, "pwragent-e2e-gh");
  await writeFile(ghPath, STAND_IN_GH);
  await chmod(ghPath, 0o755);
  return ghPath;
}
