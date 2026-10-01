import { describe, expect, it, vi } from "vitest";
import {
  CODEX_MINIMUM_RECOMMENDED_VERSION,
  buildCodexVersionAdvisory,
  classifyCodexInstaller,
  isCodexVersionBelowMinimum,
  parseCodexVersionCore,
} from "../settings/codex-version-advisory";

describe("Codex version floor", () => {
  it("pins the floor the new models need", () => {
    expect(CODEX_MINIMUM_RECOMMENDED_VERSION).toBe("0.159.0");
  });

  it("parses the number out of what `codex --version` prints", () => {
    expect(parseCodexVersionCore("codex-cli 0.152.0")).toEqual([0, 152, 0]);
    expect(parseCodexVersionCore("0.200.0-pwragent.1")).toEqual([0, 200, 0]);
    expect(parseCodexVersionCore("not a version")).toBeUndefined();
    expect(parseCodexVersionCore(undefined)).toBeUndefined();
  });

  it("compares numbers, not strings", () => {
    expect(isCodexVersionBelowMinimum("0.155.0")).toBe(true);
    expect(isCodexVersionBelowMinimum("0.158.9")).toBe(true);
    expect(isCodexVersionBelowMinimum("0.99.0")).toBe(true);
    expect(isCodexVersionBelowMinimum("0.159.0")).toBe(false);
    expect(isCodexVersionBelowMinimum("0.159.1")).toBe(false);
    expect(isCodexVersionBelowMinimum("0.160.0")).toBe(false);
    expect(isCodexVersionBelowMinimum("1.0.0")).toBe(false);
  });

  it("does not call a prerelease of the floor old, or an unknown version old", () => {
    expect(isCodexVersionBelowMinimum("0.159.0-alpha.2")).toBe(false);
    expect(isCodexVersionBelowMinimum("garbage")).toBe(false);
    expect(isCodexVersionBelowMinimum(undefined)).toBe(false);
  });
});

describe("Codex installer classification", () => {
  it("names a Homebrew formula and cask from the resolved path", () => {
    expect(classifyCodexInstaller({
      command: "/opt/homebrew/bin/codex",
      resolvedPath: "/opt/homebrew/Cellar/codex/0.152.0/bin/codex",
    })).toEqual({ installer: "homebrew", upgradeCommand: "brew upgrade codex" });
    expect(classifyCodexInstaller({
      command: "/opt/homebrew/bin/codex",
      resolvedPath: "/opt/homebrew/Caskroom/codex/0.152.0/codex-aarch64-apple-darwin",
    })).toEqual({ installer: "homebrew", upgradeCommand: "brew upgrade --cask codex" });
  });

  it("names each JavaScript package manager, most specific root first", () => {
    expect(classifyCodexInstaller({
      command: "/Users/x/.bun/bin/codex",
      resolvedPath: "/Users/x/.bun/install/global/node_modules/@openai/codex/bin/codex.js",
    }).upgradeCommand).toBe("bun add -g @openai/codex@latest");
    expect(classifyCodexInstaller({
      command: "/Users/x/Library/pnpm/codex",
      resolvedPath: "/Users/x/Library/pnpm/global/5/node_modules/@openai/codex/bin/codex.js",
    }).upgradeCommand).toBe("pnpm add -g @openai/codex@latest");
    expect(classifyCodexInstaller({
      command: "/Users/x/.nvm/versions/node/v24/bin/codex",
      resolvedPath: "/Users/x/.nvm/versions/node/v24/lib/node_modules/@openai/codex/bin/codex.js",
    })).toEqual({
      installer: "npm",
      upgradeCommand: "npm install -g @openai/codex@latest",
    });
  });

  it("reads Windows paths", () => {
    expect(classifyCodexInstaller({
      command: "C:\\Users\\x\\AppData\\Roaming\\npm\\codex.cmd",
      resolvedPath: "C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
    }).installer).toBe("npm");
  });

  it("gives an app or an unknown install no command to run", () => {
    expect(classifyCodexInstaller({
      command: "/Applications/Codex.app/Contents/Resources/codex",
      source: "application",
    })).toEqual({ installer: "application" });
    expect(classifyCodexInstaller({
      command: "/usr/local/bin/codex",
      resolvedPath: "/usr/local/bin/codex",
      source: "path",
    })).toEqual({ installer: "unknown" });
  });

  it("leaves PwrAgent's own build to PwrAgent, whatever its path looks like", () => {
    expect(classifyCodexInstaller({
      command: "/Users/x/.pwragent/codex/versions/v1/codex",
      managedByPwrAgent: true,
    })).toEqual({ installer: "pwragent" });
  });
});

describe("Codex version advisory", () => {
  it("is absent for a current or unidentified Codex", async () => {
    const resolvePath = vi.fn(async () => undefined);
    await expect(buildCodexVersionAdvisory({
      command: "/bin/codex", version: "0.160.0", resolvePath,
    })).resolves.toBeUndefined();
    await expect(buildCodexVersionAdvisory({
      command: "/bin/codex", version: undefined, resolvePath,
    })).resolves.toBeUndefined();
    await expect(buildCodexVersionAdvisory({
      command: undefined, version: "0.100.0", resolvePath,
    })).resolves.toBeUndefined();
    // No need to touch the filesystem for a Codex that is fine.
    expect(resolvePath).not.toHaveBeenCalled();
  });

  it("carries the number, the floor, and the command that updates it", async () => {
    await expect(buildCodexVersionAdvisory({
      command: "/opt/homebrew/bin/codex",
      version: "codex-cli 0.152.0",
      source: "path",
      resolvePath: async () => "/opt/homebrew/Cellar/codex/0.152.0/bin/codex",
    })).resolves.toEqual({
      version: "0.152.0",
      minimumVersion: "0.159.0",
      command: "/opt/homebrew/bin/codex",
      installer: "homebrew",
      upgradeCommand: "brew upgrade codex",
    });
  });

  it("does not resolve links for PwrAgent's own build", async () => {
    const resolvePath = vi.fn(async () => "/somewhere/Cellar/codex/x");
    const advisory = await buildCodexVersionAdvisory({
      command: "/Users/x/.pwragent/codex/versions/v1/codex",
      version: "0.150.0-pwragent.1",
      managedByPwrAgent: true,
      resolvePath,
    });
    expect(advisory).toMatchObject({ installer: "pwragent", version: "0.150.0" });
    expect(resolvePath).not.toHaveBeenCalled();
  });
});
