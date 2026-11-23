import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { AcpAgentInstance, AcpRejectedAgentInstance } from "@pwragent/shared/contracts/backend";
import { discoverAcpAgentInstances, discoverLocalAcpAgentRecords } from "../acp/acp-instance-discovery";

const external: AcpAgentInstance = { command: "/bin/agy", source: "path", version: "1.5.13" };

function discovery(
  command: string,
  instances: AcpAgentInstance[],
  rejectedInstances: AcpRejectedAgentInstance[] = [],
) {
  return {
    enabledRegistryIds: ["antigravity"],
    useManagedAntigravity: true,
    readManagedAntigravity: async () => ({ status: "installed" as const, runtime: { command, version: "1.5.14" } }),
    discover: async () => [{
      strategyId: "antigravity",
      backendId: "acp:antigravity",
      name: "Antigravity",
      args: ["acp", "--process-per-session"],
      env: {},
      instances,
      rejectedInstances,
      discoveredAt: 0,
    }],
  };
}

async function withManagedBinary(
  run: (root: string, command: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-discovery-test-"));
  const command = path.join(root, "agents", "antigravity", "versions", `1.5.14-${"a".repeat(128)}`, "agy");
  vi.stubEnv("PWRAGENT_HOME", root);
  try {
    await mkdir(path.dirname(command), { recursive: true });
    await writeFile(command, "fixture binary", { mode: 0o700 });
    await run(root, command);
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}

async function expectRejectedRuntime(
  command: string, rejected: AcpRejectedAgentInstance, fallback: boolean, env?: NodeJS.ProcessEnv,
) {
  const options = { ...discovery(command, fallback ? [external] : [], [rejected]), env };
  const [settings, [record]] = await Promise.all([
    discoverAcpAgentInstances(options),
    discoverLocalAcpAgentRecords(options),
  ]);
  const expected = fallback ? external.command : undefined;
  expect(settings.get("antigravity")).toMatchObject({
    instances: fallback ? [external] : [],
    rejectedInstances: [rejected],
  });
  expect(settings.get("antigravity")?.activeCommand).toBe(expected);
  expect(record?.launchDescriptor?.command).toBe(expected);
}

it("uses a working PATH candidate after rejecting the exact managed path", async () => {
  await withManagedBinary(async (_root, command) => {
    await expectRejectedRuntime(command, { command, source: "override", reason: "acp-probe-failed" }, true);
  });
});

it("allows fallback after pruning only for an automatically selected managed executable", async () => {
  await withManagedBinary(async (_root, command) => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("automatic", "override", "selected"), async (selection) => {
      const [record] = await discoverLocalAcpAgentRecords({
        ...discovery(command, []),
        preferences: {
          antigravity: {
            ...(selection === "override" ? { overridePath: command } : {}),
            ...(selection === "selected" ? { selectedPath: command } : {}),
          },
        },
      });
      expect(record?.launchDescriptor?.command).toBe(command);
      expect(record?.launchDescriptor?.managedAntigravityFallback).toBe(selection === "automatic" ? true : undefined);
    }), { numRuns: 15 });
  });
});

describe.skipIf(process.platform === "win32")("managed Antigravity symlinks", () => {
  it("keeps a rejected relative PATH alias out of the active selection", async () => {
    await withManagedBinary(async (root, command) => {
      const alias = path.join(root, "agy");
      await symlink(command, alias);
      const relative = path.relative(process.cwd(), alias);
      await expectRejectedRuntime(command, { command: relative, source: "path", reason: "acp-probe-failed" }, true);
    });
  });

  it("keeps rejections authoritative for direct and symlinked paths", async () => {
    await withManagedBinary(async (root, command) => {
      const alias = path.join(root, "agy");
      await symlink(command, alias);
      await fc.assert(fc.asyncProperty(
        fc.constantFrom(command, alias, path.relative(process.cwd(), command), path.relative(process.cwd(), alias), "agy"),
        fc.constantFrom("override", "path"),
        fc.constantFrom("acp-probe-failed", "version-probe-failed", "acp-help-mismatch", "probe-timed-out"),
        fc.boolean(),
        async (rejectedCommand, source, reason, fallback) => {
          await expectRejectedRuntime(command, { command: rejectedCommand, source, reason }, fallback, {
            PATH: path.relative(process.cwd(), root),
          });
        },
      ), { numRuns: 25 });
    });
  });

  it("keeps an accepted override alias as the only entry for that executable", async () => {
    await withManagedBinary(async (root, command) => {
      const alias = path.join(root, "agy");
      await symlink(command, alias);
      const override: AcpAgentInstance = { command: alias, source: "override", version: "1.5.14" };
      const [record] = await discoverLocalAcpAgentRecords(discovery(command, [override, external]));
      expect(record?.instances).toEqual([override, external]);
      expect(record?.activeCommand).toBe(alias);
    });
  });

  it("keeps one entry per accepted managed executable and preserves the selected alias", async () => {
    await withManagedBinary(async (root, command) => {
      const alias = path.join(root, "agy");
      await symlink(command, alias);
      await fc.assert(fc.asyncProperty(
        fc.constantFrom(alias, path.relative(process.cwd(), alias), "agy"),
        fc.constantFrom("path", "override"),
        fc.boolean(),
        fc.boolean(),
        async (candidate, source, externalFirst, duplicate) => {
          const managed: AcpAgentInstance = { command: candidate, source, version: "1.5.14" };
          const candidates = externalFirst ? [external, managed] : [managed, external];
          if (duplicate) candidates.unshift({ command, source: "path", version: "1.5.14" });
          const options = {
            ...discovery(command, candidates),
            env: { PATH: path.relative(process.cwd(), root) },
            preferences: { antigravity: { selectedPath: candidate } },
          };
          const [settings, [record]] = await Promise.all([
            discoverAcpAgentInstances(options), discoverLocalAcpAgentRecords(options),
          ]);
          expect(settings.get("antigravity")?.instances).toEqual([managed, external]);
          expect(record?.instances).toEqual([managed, external]);
          expect(record?.activeCommand).toBe(candidate);
          expect(record?.launchDescriptor?.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("true");
        },
      ), { numRuns: 25 });
    });
  });

  it("keeps a symlink override and disables the updater for a superseded managed release", async () => {
    await withManagedBinary(async (root, command) => {
      const alias = path.join(root, "alternate-agy");
      await symlink(command, alias);
      const options = discovery(path.join(root, "next-release", "agy"), [{ command: alias, source: "override" }]);
      const [record] = await discoverLocalAcpAgentRecords(options);
      expect(record?.launchDescriptor).toMatchObject({
        command: alias,
        env: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
      });
    });
  });

  it("derives updater ownership from the selected target while preserving the override", async () => {
    await withManagedBinary(async (root, command) => {
      const standalone = path.join(root, "standalone");
      await writeFile(standalone, "fixture binary");
      const alias = path.join(root, "alternate-agy");
      const secondAlias = path.join(root, "linked-agy");
      await symlink(alias, secondAlias);
      await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), async (managed, useSecondAlias) => {
        await rm(alias, { force: true });
        await symlink(managed ? command : standalone, alias);
        const override = useSecondAlias ? secondAlias : alias;
        const [record] = await discoverLocalAcpAgentRecords(discovery(command, [{ command: override, source: "override" }]));
        expect(record?.launchDescriptor?.command).toBe(override);
        expect(record?.launchDescriptor?.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe(managed ? "true" : undefined);
      }), { numRuns: 15 });
    });
  });
});
