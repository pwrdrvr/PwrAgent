import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_ACP_PACKAGE_INTEGRITY,
  CLAUDE_ACP_PACKAGE_NAME,
  CLAUDE_ACP_PACKAGE_SPEC,
  CLAUDE_ACP_VERSION,
  claudeAcpManagedRuntimeSummary,
  claudeAcpPlaceholderSettingsEntry,
  discoverManagedClaudeAcpRuntime,
  installManagedClaudeAcpRuntime,
  isClaudeAcpAuthenticationError,
} from "../acp/claude-acp-runtime";

const temporaryDirectories: string[] = [];
const TEST_PACKAGE_CONTENT_DIGEST =
  "sha256-64o0mY8Wcu6Gu1V+70nzTHfuRs+Ot5OnqVUlNZPmWQI=";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("managed Claude ACP runtime", () => {
  it("publishes the exact managed package and credential policy", () => {
    const entry = claudeAcpPlaceholderSettingsEntry();

    expect(entry).toMatchObject({
      backendId: "acp:claude-acp",
      registryId: "claude-acp",
      name: "Claude Agent",
      version: "0.60.0",
      distributionSource: CLAUDE_ACP_PACKAGE_SPEC,
      installable: true,
      installed: false,
      verificationStatus: "verified",
      managedRuntime: {
        packageName: CLAUDE_ACP_PACKAGE_NAME,
        pinnedVersion: CLAUDE_ACP_VERSION,
        integrity: CLAUDE_ACP_PACKAGE_INTEGRITY,
        credentialScope: "owning-instance",
        supportLevel: "experimental",
        authMethod: "local-terminal",
        subscriptionAuthBlocked: false,
      },
    });
  });

  it("installs atomically, verifies integrity, and exposes local auth", async () => {
    const runtimeDirectory = await temporaryRuntimeDirectory();
    const runInstaller = vi.fn(
      async (params: { cwd: string; args: string[] }) => {
        await writePackageFixture(params.cwd, CLAUDE_ACP_PACKAGE_INTEGRITY);
      },
    );

    const installed = await installManagedClaudeAcpRuntime({
      runtimeDirectory,
      expectedPackageContentDigest: TEST_PACKAGE_CONTENT_DIGEST,
      installId: () => "test-install",
      now: () => 1234,
      resolveToolchain: async () => ({
        nodeCommand: process.execPath,
        npmCommand: "/usr/bin/npm",
        npmArgsPrefix: [],
      }),
      runInstaller,
    });

    expect(runInstaller).toHaveBeenCalledOnce();
    const args = runInstaller.mock.calls[0]?.[0].args ?? [];
    expect(args).toContain("--ignore-scripts");
    expect(args).toContain("--save-exact");
    expect(args).toContain(CLAUDE_ACP_PACKAGE_SPEC);
    expect(installed).toMatchObject({
      backendId: "acp:claude-acp",
      installStatus: "installed",
      authStatus: "required",
      verificationStatus: "verified",
      installedAt: 1234,
      launchDescriptor: {
        command: process.execPath,
        args: [expect.stringContaining(path.join("dist", "index.js"))],
      },
    });
    const summary = claudeAcpManagedRuntimeSummary(installed);
    expect(summary.consoleAuthCommand).toContain("--cli auth login --console");
    expect(summary.subscriptionAuthCommand).toContain(
      "--cli auth login --claudeai",
    );

    const discovered = await discoverManagedClaudeAcpRuntime({
      runtimeDirectory,
      expectedPackageContentDigest: TEST_PACKAGE_CONTENT_DIGEST,
      now: () => 5678,
    });
    expect(discovered).toMatchObject({
      version: CLAUDE_ACP_VERSION,
      installedAt: 1234,
      updatedAt: 5678,
    });
  });

  it("rejects an integrity mismatch without promoting the staging directory", async () => {
    const runtimeDirectory = await temporaryRuntimeDirectory();

    await expect(
      installManagedClaudeAcpRuntime({
        runtimeDirectory,
        expectedPackageContentDigest: TEST_PACKAGE_CONTENT_DIGEST,
        installId: () => "bad-integrity",
        resolveToolchain: async () => ({
          nodeCommand: process.execPath,
          npmCommand: "/usr/bin/npm",
          npmArgsPrefix: [],
        }),
        runInstaller: async ({ cwd }) => {
          await writePackageFixture(cwd, "sha512-not-the-pinned-package");
        },
      }),
    ).rejects.toThrow("failed integrity verification");

    await expect(readFile(runtimeDirectory, "utf8")).rejects.toThrow();
    await expect(
      readFile(
        path.join(path.dirname(runtimeDirectory), ".install-bad-integrity"),
        "utf8",
      ),
    ).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "rejects a package entrypoint symlink that escapes the managed runtime",
    async () => {
      const runtimeDirectory = await temporaryRuntimeDirectory();
      const escapedEntrypoint = path.join(
        path.dirname(runtimeDirectory),
        "escaped-entrypoint.js",
      );
      await writeFile(escapedEntrypoint, "");

      await expect(
        installManagedClaudeAcpRuntime({
          runtimeDirectory,
          expectedPackageContentDigest: TEST_PACKAGE_CONTENT_DIGEST,
          installId: () => "escaped-entrypoint",
          resolveToolchain: async () => ({
            nodeCommand: process.execPath,
            npmCommand: "/usr/bin/npm",
            npmArgsPrefix: [],
          }),
          runInstaller: async ({ cwd }) => {
            await writePackageFixture(cwd, CLAUDE_ACP_PACKAGE_INTEGRITY);
            const entrypoint = path.join(
              cwd,
              "node_modules",
              "@agentclientprotocol",
              "claude-agent-acp",
              "dist",
              "index.js",
            );
            await rm(entrypoint);
            await symlink(escapedEntrypoint, entrypoint);
          },
        }),
      ).rejects.toThrow("escapes its package");
    },
  );

  it("rejects modified installed package bytes during rediscovery", async () => {
    const runtimeDirectory = await temporaryRuntimeDirectory();
    await installManagedClaudeAcpRuntime({
      runtimeDirectory,
      expectedPackageContentDigest: TEST_PACKAGE_CONTENT_DIGEST,
      installId: () => "tamper-check",
      resolveToolchain: async () => ({
        nodeCommand: process.execPath,
        npmCommand: "/usr/bin/npm",
        npmArgsPrefix: [],
      }),
      runInstaller: async ({ cwd }) => {
        await writePackageFixture(cwd, CLAUDE_ACP_PACKAGE_INTEGRITY);
      },
    });
    await writeFile(
      path.join(
        runtimeDirectory,
        "node_modules",
        "@agentclientprotocol",
        "claude-agent-acp",
        "dist",
        "index.js",
      ),
      "tampered",
    );

    await expect(
      discoverManagedClaudeAcpRuntime({
        runtimeDirectory,
        expectedPackageContentDigest: TEST_PACKAGE_CONTENT_DIGEST,
      }),
    ).resolves.toBeUndefined();
  });

  it("formats Windows authentication commands for PowerShell", () => {
    const entrypoint =
      "C:\\Program Files\\PwrAgent\\claude-agent-acp\\dist\\index.js";
    const record = {
      launchDescriptor: {
        command: "C:\\Program Files\\nodejs\\node.exe",
        args: [entrypoint],
      },
    } as Parameters<typeof claudeAcpManagedRuntimeSummary>[0];

    const summary = claudeAcpManagedRuntimeSummary(record, {
      platform: "win32",
    });

    expect(summary.subscriptionAuthCommand).toBe(
      `& 'C:\\Program Files\\nodejs\\node.exe' '${entrypoint}' --cli auth login --claudeai`,
    );
    expect(summary.consoleAuthCommand).toBe(
      `& 'C:\\Program Files\\nodejs\\node.exe' '${entrypoint}' --cli auth login --console`,
    );
  });

  it(
    "classifies local credential and blocked-subscription failures as auth setup",
    () => {
      expect(
        isClaudeAcpAuthenticationError(new Error("Authentication required")),
      ).toBe(true);
      expect(
        isClaudeAcpAuthenticationError(
          new Error(
            "This integration does not support using claude.ai subscriptions",
          ),
        ),
      ).toBe(true);
      expect(
        isClaudeAcpAuthenticationError(new Error("connection reset")),
      ).toBe(false);
    },
  );
});

async function temporaryRuntimeDirectory(): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-acp-"));
  temporaryDirectories.push(parent);
  return path.join(parent, "runtime");
}

async function writePackageFixture(
  runtimeDirectory: string,
  integrity: string,
): Promise<void> {
  const packageDirectory = path.join(
    runtimeDirectory,
    "node_modules",
    "@agentclientprotocol",
    "claude-agent-acp",
  );
  await mkdir(path.join(packageDirectory, "dist"), { recursive: true });
  await writeFile(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({
      name: CLAUDE_ACP_PACKAGE_NAME,
      version: CLAUDE_ACP_VERSION,
      bin: { "claude-agent-acp": "dist/index.js" },
    }),
  );
  await writeFile(path.join(packageDirectory, "dist", "index.js"), "");
  await writeFile(
    path.join(runtimeDirectory, "package-lock.json"),
    JSON.stringify({
      packages: {
        "../../resolved/profile/node_modules/@agentclientprotocol/claude-agent-acp": {
          version: CLAUDE_ACP_VERSION,
          integrity,
        },
      },
    }),
  );
}
