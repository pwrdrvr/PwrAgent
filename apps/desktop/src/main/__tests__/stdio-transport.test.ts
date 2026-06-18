import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compareCodexCliVersions } from "@pwrdrvr/codex-discovery";
import { prependCodexSiblingToolDirectoryToPath } from "../codex-app-server/stdio-transport";

describe("stdio transport Codex CLI resolution", () => {
  it("orders stable Codex CLI releases ahead of prereleases with the same version", () => {
    expect(compareCodexCliVersions("0.125.0", "0.125.0-alpha.3")).toBeGreaterThan(0);
    expect(compareCodexCliVersions("0.125.0-alpha.4", "0.125.0-alpha.3")).toBeGreaterThan(0);
  });

  it("orders newer Codex.app prereleases ahead of older stable PATH releases", () => {
    expect(compareCodexCliVersions("0.126.0-alpha.1", "0.125.0")).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === "win32")("prepends a resolved Codex resource directory when sibling ripgrep is executable", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-codex-rg-"));
    try {
      const resourcesDir = path.join(
        tempDir,
        "Codex.app",
        "Contents",
        "Resources",
      );
      const codexPath = path.join(resourcesDir, "codex");
      const rgPath = path.join(resourcesDir, "rg");
      mkdirSync(resourcesDir, { recursive: true });
      writeFileSync(codexPath, "#!/bin/sh\nexit 0\n");
      writeFileSync(rgPath, "#!/bin/sh\nexit 0\n");
      chmodSync(codexPath, 0o755);
      chmodSync(rgPath, 0o755);

      const env = {
        PATH: `/usr/bin${path.delimiter}${resourcesDir}${path.delimiter}/bin`,
      };
      const nextEnv = prependCodexSiblingToolDirectoryToPath(env, codexPath);

      expect(nextEnv.PATH?.split(path.delimiter)).toEqual([
        resourcesDir,
        "/usr/bin",
        "/bin",
      ]);
      expect(env.PATH?.split(path.delimiter)).toEqual([
        "/usr/bin",
        resourcesDir,
        "/bin",
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("leaves PATH unchanged when the resolved Codex directory has no executable ripgrep", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-codex-rg-"));
    try {
      const codexPath = path.join(tempDir, "codex");
      writeFileSync(codexPath, "#!/bin/sh\nexit 0\n");
      chmodSync(codexPath, 0o755);

      const env = { PATH: "/usr/bin:/bin" };
      const nextEnv = prependCodexSiblingToolDirectoryToPath(env, codexPath);

      expect(nextEnv).toBe(env);
      expect(nextEnv.PATH).toBe("/usr/bin:/bin");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
