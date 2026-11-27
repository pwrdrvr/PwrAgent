import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const name = "pwragent-mcp-stdio-relay";
const targets = {
  darwin: { x64: "x86_64-apple-darwin", arm64: "aarch64-apple-darwin" },
  linux: { x64: "x86_64-unknown-linux-gnu", arm64: "aarch64-unknown-linux-gnu" },
  win32: { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" },
};

export function mcpStdioRelayName(platform = process.platform) {
  return name + (platform === "win32" ? ".exe" : "");
}

export function stagedMcpStdioRelay(root, platform, arch) {
  return join(root, "build/mcp-stdio-relay/release-input", `${platform}-${arch}`, mcpStdioRelayName(platform));
}

export function buildMcpStdioRelay({ arch = process.arch, outputRoot = root, packaged = false, destination } = {}) {
  const target = targets[process.platform]?.[arch];
  if (!target || (process.platform !== "darwin" && arch !== process.arch)) {
    throw new Error(`Build the MCP stdio relay on its supported target platform and architecture (${process.platform}-${arch}).`);
  }
  const source = join(root, "native/mcp-stdio-relay");
  const buildRoot = join(outputRoot, "build/mcp-stdio-relay");
  const targetDir = join(buildRoot, "cargo");
  const filename = mcpStdioRelayName();
  const output = destination ?? join(buildRoot, packaged ? "packaged" : `${process.platform}-${arch}`, filename);
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    const result = spawnSync("cargo", [
      "build", "--locked", "--release", "--manifest-path", join(source, "Cargo.toml"),
      "--target", target, "--target-dir", targetDir,
    ], {
      env: {
        ...process.env,
        ...(process.platform === "darwin" ? { MACOSX_DEPLOYMENT_TARGET: "12.0" } : {}),
      },
      stdio: "inherit",
    });
    if (result.error || result.status !== 0) {
      throw new Error(`MCP stdio relay build failed for ${target}. Install Cargo and the target toolchain. ${result.error?.message ?? result.status}`,
        { cause: result.error });
    }
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(join(targetDir, target, "release", filename), temporary);
    renameSync(temporary, output);
    return output;
  } catch (error) {
    // A stale relay from an earlier build must not appear to be this build's
    // verified executable.
    rmSync(output, { force: true });
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    buildMcpStdioRelay();
  } catch (error) {
    if (!process.argv.includes("--optional")) throw error;
    console.warn(`Native MCP stdio is unavailable: ${error.message}`);
  }
}
