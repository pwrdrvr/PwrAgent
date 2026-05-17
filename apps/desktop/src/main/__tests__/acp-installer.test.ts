import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpAgentStore } from "../acp/acp-agent-store";
import { AcpInstaller } from "../acp/acp-installer";
import { StateDb } from "../state/state-db";
import type {
  AcpBinaryPlatformDistribution,
  AcpPackageDistribution,
  AcpRegistryAgent,
} from "../acp/acp-registry-types";

let tempDir: string;
let stateDb: StateDb;
let store: AcpAgentStore;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-acp-installer-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new AcpAgentStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("AcpInstaller", () => {
  it("prepares npx launch descriptors without shell strings", async () => {
    const installer = new AcpInstaller({
      store,
      now: () => 1000,
      prerequisiteProbe: async () => ({ stdout: "10.9.4" }),
    });
    const agent = buildAgent();
    const distribution: AcpPackageDistribution = {
      kind: "npx",
      packageName: "@zed-industries/codex-acp@0.14.0",
      args: ["--flag"],
      env: { CODEX_HOME: "/tmp/codex" },
    };

    const result = await installer.install({
      agent,
      distribution,
      allowlistRuleId: "codex-rule",
      installRoot: path.join(tempDir, "agents"),
      confirmed: true,
    });

    expect(result).toMatchObject({
      ok: true,
      record: {
        backendId: "acp:codex-acp",
        installStatus: "installed",
        distributionKind: "npx",
        distributionSource: "@zed-industries/codex-acp@0.14.0",
        verificationStatus: "not-applicable",
        launchDescriptor: {
          command: "npx",
          args: ["--yes", "@zed-industries/codex-acp@0.14.0", "--flag"],
          env: { CODEX_HOME: "/tmp/codex" },
        },
      },
    });
    expect(store.getInstalledAgent("acp:codex-acp")).toEqual(result.record);
  });

  it("records recoverable missing-prerequisite failures", async () => {
    const error = new Error("missing") as Error & { code: string };
    error.code = "ENOENT";
    const installer = new AcpInstaller({
      store,
      now: () => 1000,
      prerequisiteProbe: async () => {
        throw error;
      },
    });

    const result = await installer.install({
      agent: buildAgent(),
      distribution: {
        kind: "uvx",
        packageName: "fast-agent-acp==0.7.4",
        args: ["-x"],
        env: {},
      },
      allowlistRuleId: "fast-agent-rule",
      installRoot: path.join(tempDir, "agents"),
      confirmed: true,
    });

    expect(result).toMatchObject({
      ok: false,
      record: {
        installStatus: "install-failed",
        lastError: "uvx-missing:not-found",
      },
    });
  });

  it("installs binaries through staging and promotes only after validation", async () => {
    const installer = new AcpInstaller({
      store,
      now: () => 1000,
      archiveDownloader: async ({ destinationPath }) => {
        await writeFile(destinationPath, "archive");
      },
      archiveExtractor: async ({ destinationDir }) => {
        await writeFile(path.join(destinationDir, "codex-acp"), "#!/bin/sh\n");
      },
    });
    const installRoot = path.join(tempDir, "agents");
    const distribution = buildBinaryDistribution("./codex-acp");

    const result = await installer.install({
      agent: buildAgent(),
      distribution,
      allowlistRuleId: "codex-rule",
      installRoot,
      confirmed: true,
    });

    expect(result).toMatchObject({
      ok: true,
      record: {
        installStatus: "installed",
        distributionKind: "binary",
        distributionSource: distribution.archiveUrl,
        verificationStatus: "unverified-allowed",
        launchDescriptor: {
          command: path.join(installRoot, "codex-acp", "codex-acp"),
          installPath: path.join(installRoot, "codex-acp"),
        },
      },
    });
  });

  it("verifies binary archive checksums before extraction", async () => {
    let extracted = false;
    const installer = new AcpInstaller({
      store,
      now: () => 1000,
      archiveDownloader: async ({ destinationPath }) => {
        await writeFile(destinationPath, "archive");
      },
      archiveExtractor: async ({ destinationDir }) => {
        extracted = true;
        await writeFile(path.join(destinationDir, "codex-acp"), "#!/bin/sh\n");
      },
    });
    const installRoot = path.join(tempDir, "agents");
    const distribution = {
      ...buildBinaryDistribution("./codex-acp"),
      checksum: "sha256:0eb3e36bfb24dcd9bb1d1bece1531216b59539a8fde17ee80224af0653c92aa3",
    };

    const result = await installer.install({
      agent: buildAgent(),
      distribution,
      allowlistRuleId: "codex-rule",
      installRoot,
      confirmed: true,
    });

    expect(extracted).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      record: {
        installStatus: "installed",
        verificationStatus: "verified",
      },
    });
  });

  it("does not extract or promote binaries with checksum mismatches", async () => {
    let extracted = false;
    const installer = new AcpInstaller({
      store,
      now: () => 1000,
      archiveDownloader: async ({ destinationPath }) => {
        await writeFile(destinationPath, "archive");
      },
      archiveExtractor: async () => {
        extracted = true;
      },
    });

    const result = await installer.install({
      agent: buildAgent(),
      distribution: {
        ...buildBinaryDistribution("./codex-acp"),
        checksum: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      },
      allowlistRuleId: "codex-rule",
      installRoot: path.join(tempDir, "agents"),
      confirmed: true,
    });

    expect(extracted).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      record: {
        installStatus: "install-failed",
        lastError: "binary archive checksum verification failed",
      },
    });
  });

  it("rejects binary command paths that escape the install directory", async () => {
    const installer = new AcpInstaller({
      store,
      now: () => 1000,
      archiveDownloader: async ({ destinationPath }) => {
        await mkdir(path.dirname(destinationPath), { recursive: true });
        await writeFile(destinationPath, "archive");
      },
      archiveExtractor: async ({ destinationDir }) => {
        await writeFile(path.join(destinationDir, "codex-acp"), "#!/bin/sh\n");
      },
    });

    const result = await installer.install({
      agent: buildAgent(),
      distribution: buildBinaryDistribution("../evil"),
      allowlistRuleId: "codex-rule",
      installRoot: path.join(tempDir, "agents"),
      confirmed: true,
    });

    expect(result).toMatchObject({
      ok: false,
      record: {
        installStatus: "install-failed",
        lastError: "binary command escapes install directory",
      },
    });
    expect(store.listInstalledAgents()).toHaveLength(1);
  });

  it("requires explicit confirmation before recording an installable descriptor", async () => {
    const installer = new AcpInstaller({
      store,
      now: () => 1000,
      prerequisiteProbe: async () => ({ stdout: "10.9.4" }),
    });

    const result = await installer.install({
      agent: buildAgent(),
      distribution: {
        kind: "npx",
        packageName: "@zed-industries/codex-acp@0.14.0",
        args: [],
        env: {},
      },
      allowlistRuleId: "codex-rule",
      installRoot: path.join(tempDir, "agents"),
      confirmed: false,
    });

    expect(result).toMatchObject({
      ok: false,
      record: {
        installStatus: "install-failed",
        lastError: "install-not-confirmed",
      },
    });
  });
});

function buildAgent(): AcpRegistryAgent {
  return {
    id: "codex-acp",
    backendId: "acp:codex-acp",
    name: "Codex CLI",
    version: "0.14.0",
    authors: ["OpenAI"],
    distributions: [],
    distributionKinds: [],
    auth: { required: false, methods: [] },
    raw: {},
  };
}

function buildBinaryDistribution(
  command: string,
): AcpBinaryPlatformDistribution {
  return {
    kind: "binary",
    platform: "darwin-aarch64",
    archiveUrl: "https://github.com/zed-industries/codex-acp/releases/codex-acp.tar.gz",
    command,
    args: [],
    env: {},
  };
}
