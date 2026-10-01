import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { packageMacDryrun, signMacDryrunApp } from "./macos-dryrun-signing.mjs";
import { personalizeMacExecutableFile } from "./macos-executable-uuid.mjs";

const options = {
  cli: "/tools/electron-builder/cli.js",
  args: ["--mac", "dmg", "zip", "--universal", "--config.mac.identity=-", "--publish=never"],
  app: "/stage/dist/mac-universal/PwrAgent.app",
  entitlements: "/stage/build/entitlements.mac.plist",
  cwd: "/stage",
};

describe("macOS dry-run packaging", () => {
  it("signs and verifies the merged app before creating either artifact", async () => {
    const events = [];
    await packageMacDryrun(options, {
      runChecked: (file, args, opts) => events.push({ file, args, opts }),
      signApp: async (app, entitlements) => events.push({ app, entitlements }),
    });
    expect(events).toEqual([
      {
        file: "node",
        args: [options.cli, "--mac", "--universal", "--config.mac.identity=-", "--publish=never", "--dir"],
        opts: { cwd: options.cwd },
      },
      { app: options.app, entitlements: options.entitlements },
      {
        file: "codesign",
        args: ["--verify", "--deep", "--strict", "--verbose=2", options.app],
        opts: undefined,
      },
      {
        file: "node",
        args: [options.cli, ...options.args, "--prepackaged", options.app],
        opts: { cwd: options.cwd },
      },
    ]);
  });

  it.each(["sign", "verify"])("does not create artifacts after a %s failure", async (failure) => {
    const commands = [];
    await expect(packageMacDryrun(options, {
      runChecked: (file, args) => {
        commands.push({ file, args });
        if (file === "codesign") throw new Error("verification failed");
      },
      signApp: async () => {
        if (failure === "sign") throw new Error("signing failed");
      },
    })).rejects.toThrow(failure === "sign" ? "signing failed" : "verification failed");
    expect(commands.filter(({ args }) => args.includes("--prepackaged"))).toEqual([]);
  });
});

it.skipIf(process.platform !== "darwin")("repairs unsigned universal tools and UUID-modified code with ad-hoc signatures", async () => {
  const root = mkdtempSync(join(tmpdir(), "pwragent-dryrun-signing-"));
  try {
    const app = join(root, "PwrAgent.app");
    const plugin = join(app, "Contents", "PlugIns", "PwrAgentDockTilePlugin.plugin");
    function bundle(path, executable, identifier) {
      mkdirSync(join(path, "Contents", "MacOS"), { recursive: true });
      writeFileSync(join(path, "Contents", "Info.plist"), `<?xml version="1.0"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${executable}</string>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleVersion</key><string>1.0</string>
<key>CFBundlePackageType</key><string>${path.endsWith(".app") ? "APPL" : "BNDL"}</string>
</dict></plist>`);
      return join(path, "Contents", "MacOS", executable);
    }
    const main = bundle(app, "PwrAgent", "com.pwrdrvr.fixture");
    const dock = bundle(plugin, "PwrAgentDockTilePlugin", "com.pwrdrvr.fixture.dock");
    const source = join(root, "main.c");
    writeFileSync(source, "int main(void) { return 0; }\n");
    execFileSync("xcrun", ["clang", "-arch", "x86_64", "-arch", "arm64", source, "-o", main]);
    copyFileSync(main, dock);
    execFileSync("codesign", ["--force", "--sign", "-", plugin]);
    const tools = join(app, "Contents", "Resources", "tools");
    mkdirSync(tools, { recursive: true });
    const rg = join(tools, "rg");
    copyFileSync(main, rg);
    execFileSync("codesign", ["--remove-signature", rg]);
    await personalizeMacExecutableFile(main, "fixture/1.0/electron");
    expect(spawnSync("codesign", ["--verify", "--strict", rg]).status).not.toBe(0);
    expect(spawnSync("codesign", ["--verify", "--strict", main]).status).not.toBe(0);

    const here = dirname(fileURLToPath(import.meta.url));
    await signMacDryrunApp(app, join(here, "../build/entitlements.mac.plist"));
    for (const path of [app, main, plugin, dock, rg]) {
      execFileSync("codesign", ["--verify", "--all-architectures", "--deep", "--strict", path]);
    }
    const signature = spawnSync("codesign", ["--display", "--verbose=4", app], { encoding: "utf8" });
    expect(signature.stderr).toContain("Signature=adhoc");
    expect(signature.stderr).not.toMatch(/flags=.*runtime/);
    expect(spawnSync(main).status).toBe(0);
    expect(spawnSync(rg).status).toBe(0);
    const releaseRequirement = '=anchor apple generic and certificate leaf[subject.OU] = "T44CNHC4UH"';
    expect(spawnSync("codesign", ["--verify", "--test-requirement", releaseRequirement, rg]).status).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
