import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { WINDOWS_SIGNATURE_PRELUDE } from "../acp/grok-managed-runtime";

const releaseScriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "scripts",
  "release.mjs",
);

describe("Windows Authenticode verification prelude", () => {
  // The release script cannot import main-process TypeScript, so it carries its
  // own copy. Keep the two in lockstep: a v1.1.0-alpha.1 release failed because
  // `Get-AuthenticodeSignature` could not autoload Microsoft.PowerShell.Security,
  // and a repair that lands in only one caller leaves the other broken.
  it("matches the copy embedded in the release script", () => {
    const releaseScript = readFileSync(releaseScriptPath, "utf8");
    for (const statement of WINDOWS_SIGNATURE_PRELUDE) {
      expect(releaseScript).toContain(JSON.stringify(statement).slice(1, -1));
    }
  });

  it.runIf(process.platform === "win32")(
    "resolves Get-AuthenticodeSignature under Windows PowerShell",
    () => {
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const signedSystemFile = join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          [
            ...WINDOWS_SIGNATURE_PRELUDE,
            "(Get-AuthenticodeSignature -LiteralPath $env:PWRAGENT_VERIFY_EXECUTABLE).Status",
          ].join("; "),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PWRAGENT_VERIFY_EXECUTABLE: signedSystemFile,
          },
        },
      );
      expect(
        `${result.stdout ?? ""}${result.stderr ?? ""}`,
      ).not.toContain("could not be loaded");
      expect(result.status).toBe(0);
      expect((result.stdout ?? "").trim()).not.toBe("");
    },
  );
});
