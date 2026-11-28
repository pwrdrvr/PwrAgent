import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DesktopCodexInstaller } from "@pwragent/shared/contracts/settings";
import {
  CODEX_RUNNABLE_UPDATE_INSTALLERS,
  deriveCodexUserUpdateOffer,
} from "../../shared/codex-user-update";
import { classifyCodexInstaller } from "../settings/codex-version-advisory";

// Words that name an installer layout. A generated folder name must not be
// one, or a "plain" path would really be a recognized install.
const MARKERS = new Set([
  "caskroom", "cellar", "node_modules", "packages", "standalone", "programs",
  ".bun", "pnpm", "global", "install", "lib", "openai", "@openai", "codex",
]);
const segment = fc.stringMatching(/^[a-z][a-z0-9 ._-]{0,8}$/u)
  .filter((name) => !MARKERS.has(name.toLowerCase()) && name.trim() === name);
const posixHome = fc.array(segment, { minLength: 1, maxLength: 4 })
  .map((parts) => `/${parts.join("/")}`);
const windowsHome = fc.tuple(fc.constantFrom("C", "D"), fc.array(segment, { minLength: 1, maxLength: 3 }))
  .map(([drive, parts]) => `${drive}:\\${parts.join("\\")}`);
const version = fc.tuple(fc.nat(2), fc.nat(300), fc.nat(9)).map((parts) => parts.join("."));

type Layout = {
  command: string;
  resolvedPath: string;
  installer: DesktopCodexInstaller;
  upgradeCommand: string;
  installRoot: string;
  platform: NodeJS.Platform;
};

const POSIX_SH = "curl -fsSL https://chatgpt.com/codex/install.sh | sh";
const WINDOWS_PS1 = "irm https://chatgpt.com/codex/install.ps1 | iex";

/** Each install the way its installer lays it out on disk. */
const layout: fc.Arbitrary<Layout> = fc.oneof(
  fc.tuple(posixHome, version).map(([prefix, v]) => ({
    command: `${prefix}/bin/codex`,
    resolvedPath: `${prefix}/Caskroom/codex/${v}/codex-aarch64-apple-darwin`,
    installer: "homebrew" as const,
    upgradeCommand: "brew upgrade --cask codex",
    installRoot: prefix,
    platform: "darwin" as const,
  })),
  fc.tuple(posixHome, version).map(([prefix, v]) => ({
    command: `${prefix}/bin/codex`,
    resolvedPath: `${prefix}/Cellar/codex/${v}/bin/codex`,
    installer: "homebrew" as const,
    upgradeCommand: "brew upgrade codex",
    installRoot: prefix,
    platform: "linux" as const,
  })),
  posixHome.map((prefix) => ({
    command: `${prefix}/bin/codex`,
    resolvedPath: `${prefix}/lib/node_modules/@openai/codex/bin/codex.js`,
    installer: "npm" as const,
    upgradeCommand: "npm install -g @openai/codex@latest",
    installRoot: prefix,
    platform: "darwin" as const,
  })),
  windowsHome.map((prefix) => ({
    command: `${prefix}\\codex.cmd`,
    resolvedPath: `${prefix}\\node_modules\\@openai\\codex\\bin\\codex.js`,
    installer: "npm" as const,
    upgradeCommand: "npm install -g @openai/codex@latest",
    installRoot: prefix,
    platform: "win32" as const,
  })),
  fc.tuple(posixHome, fc.nat(9)).map(([home, store]) => ({
    command: `${home}/pnpm/codex`,
    resolvedPath: `${home}/pnpm/global/${store}/node_modules/@openai/codex/bin/codex.js`,
    installer: "pnpm" as const,
    upgradeCommand: "pnpm add -g @openai/codex@latest",
    installRoot: `${home}/pnpm`,
    platform: "linux" as const,
  })),
  posixHome.map((home) => ({
    command: `${home}/.bun/bin/codex`,
    resolvedPath: `${home}/.bun/install/global/node_modules/@openai/codex/bin/codex.js`,
    installer: "bun" as const,
    upgradeCommand: "bun add -g @openai/codex@latest",
    installRoot: `${home}/.bun`,
    platform: "darwin" as const,
  })),
  fc.tuple(posixHome, version, fc.constantFrom("aarch64-apple-darwin", "x86_64-unknown-linux-musl"))
    .map(([home, v, target]) => ({
      command: `${home}/.local/bin/codex`,
      resolvedPath: `${home}/.codex/packages/standalone/releases/${v}-${target}/codex`,
      installer: "standalone" as const,
      upgradeCommand: POSIX_SH,
      installRoot: `${home}/.codex`,
      platform: "darwin" as const,
    })),
  fc.tuple(windowsHome, version).map(([home, v]) => ({
    command: `${home}\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe`,
    resolvedPath: `${home}\\.codex\\packages\\standalone\\releases\\${v}-x86_64-pc-windows-msvc\\codex.exe`,
    installer: "standalone" as const,
    upgradeCommand: WINDOWS_PS1,
    installRoot: `${home}\\.codex`,
    platform: "win32" as const,
  })),
);

describe("Codex installer detection", () => {
  it("names each installer, its command, and its root from the layout it leaves", () => {
    fc.assert(fc.property(layout, (install) => {
      expect(classifyCodexInstaller({
        command: install.command,
        resolvedPath: install.resolvedPath,
        platform: install.platform,
      })).toEqual({
        installer: install.installer,
        upgradeCommand: install.upgradeCommand,
        installRoot: install.installRoot,
      });
    }));
  });

  it("reads a POSIX layout written with Windows separators the same way, keeping its spelling", () => {
    fc.assert(fc.property(layout.filter((install) => install.platform !== "win32"), (install) => {
      const flip = (entry: string): string => `C:${entry.replaceAll("/", "\\")}`;
      const classified = classifyCodexInstaller({
        command: flip(install.command),
        resolvedPath: flip(install.resolvedPath),
        platform: install.platform,
      });
      expect(classified.installer).toBe(install.installer);
      expect(classified.installRoot).toBe(flip(install.installRoot));
    }));
  });

  it("recognizes a standalone Windows install from its visible bin folder alone", () => {
    fc.assert(fc.property(windowsHome, (home) => {
      const command = `${home}\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe`;
      expect(classifyCodexInstaller({ command, platform: "win32" })).toEqual({
        installer: "standalone",
        upgradeCommand: WINDOWS_PS1,
      });
    }));
  });

  it("never names a command for a path no installer laid out", () => {
    fc.assert(fc.property(
      fc.oneof(posixHome, windowsHome),
      fc.option(fc.oneof(posixHome, windowsHome), { nil: undefined }),
      fc.constantFrom(undefined, "path" as const, "application" as const, "config" as const),
      (command, resolvedPath, source) => {
        const classified = classifyCodexInstaller({
          command,
          ...(resolvedPath ? { resolvedPath } : {}),
          ...(source ? { source } : {}),
        });
        expect(classified.upgradeCommand).toBeUndefined();
        expect(classified.installRoot).toBeUndefined();
        expect(["unknown", "application"]).toContain(classified.installer);
      },
    ));
  });

  it("leaves PwrAgent's own build to PwrAgent whatever its path looks like", () => {
    fc.assert(fc.property(layout, (install) => {
      expect(classifyCodexInstaller({
        command: install.command,
        resolvedPath: install.resolvedPath,
        managedByPwrAgent: true,
      })).toEqual({ installer: "pwragent" });
    }));
  });

  it("treats a legacy npm-tarball standalone release as standalone, not npm", () => {
    expect(classifyCodexInstaller({
      command: "/Users/x/.local/bin/codex",
      resolvedPath: "/Users/x/.codex/packages/standalone/releases/0.170.0-x86_64-apple-darwin/node_modules/@openai/codex/bin/codex.js",
      platform: "darwin",
    }).installer).toBe("standalone");
  });
});

const INSTALLERS: DesktopCodexInstaller[] = [
  "homebrew", "npm", "pnpm", "bun", "standalone", "application", "pwragent", "pwragent-openai", "unknown",
];
const anyVersion = fc.oneof(
  version,
  version.map((v) => `codex-cli ${v}`),
  version.map((v) => `${v}-alpha.2`),
  fc.constant("garbage"),
  fc.constant(undefined),
);

function core(value: string | undefined): number[] | undefined {
  const match = value ? /(\d+)\.(\d+)\.(\d+)/u.exec(value) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function before(a: number[], b: number[]): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! < b[index]!;
  }
  return false;
}

describe("Codex update offer", () => {
  it("offers exactly when a stock Codex is behind the latest release", () => {
    fc.assert(fc.property(
      anyVersion,
      anyVersion,
      fc.constantFrom(...INSTALLERS),
      fc.option(fc.constantFrom("brew upgrade codex", POSIX_SH), { nil: undefined }),
      fc.boolean(),
      (installedVersion, latestVersion, installer, upgradeCommand, runnable) => {
        const offer = deriveCodexUserUpdateOffer({
          installedVersion,
          latestVersion,
          installer,
          ...(upgradeCommand ? { upgradeCommand } : {}),
          runnable,
        });
        const installed = core(installedVersion);
        const latest = core(latestVersion);
        const behind = installer !== "pwragent"
          && installer !== "pwragent-openai"
          && installed !== undefined
          && latest !== undefined
          && before(installed, latest);
        expect(offer !== undefined).toBe(behind);
        if (!offer) return;
        expect(offer.installedVersion).toBe(installed!.join("."));
        expect(offer.latestVersion).toBe(latest!.join("."));
        // Run only what a recognized installer names, with its tool found.
        expect(offer.canRunUpdate).toBe(
          runnable
          && upgradeCommand !== undefined
          && CODEX_RUNNABLE_UPDATE_INSTALLERS.has(installer),
        );
      },
    ));
  });

  it.each(["application", "unknown", "pwragent", "pwragent-openai"] as const)(
    "never runs an update for a %s Codex",
    (installer) => {
      expect(deriveCodexUserUpdateOffer({
        installedVersion: "0.150.0",
        latestVersion: "0.172.0",
        installer,
        upgradeCommand: "brew upgrade codex",
        runnable: true,
      })?.canRunUpdate ?? false).toBe(false);
    },
  );
});
