import type { AcpPathExecutableLister } from "@pwrdrvr/agent-acp";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AcpAgentInstance, AcpBackendId } from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpAgentStore } from "../acp/acp-agent-store";
import { discoverLocalAcpAgentRecords } from "../acp/acp-instance-discovery";
import type { AcpInstalledAgentRecord } from "../acp/acp-registry-types";
import { AcpSessionStore } from "../acp/acp-session-store";
import {
  createExecutableAcpProviderFixture,
  type ExecutableAcpProviderFixture,
} from "../acp/testing/executable-acp-agent-fixture";
import { AcpBackendAdapter } from "../app-server/acp-backend-adapter";
import { installedAcpAgentSettingsEntry } from "../ipc/settings";
import { StateDb } from "../state/state-db";

type ProviderCase = {
  expectedArgs: string[];
  registryId: "gemini" | "grok" | "kimi" | "qwen";
};

const PROVIDERS: ProviderCase[] = [
  { registryId: "gemini", expectedArgs: ["--acp", "--skip-trust"] },
  { registryId: "grok", expectedArgs: ["agent", "stdio"] },
  { registryId: "kimi", expectedArgs: ["acp"] },
  { registryId: "qwen", expectedArgs: ["--acp"] },
];

const tempDirs: string[] = [];

// These fixtures intentionally exercise direct execution of Node shebang
// files, matching the macOS/Linux CLI installations involved in this bug.
// Windows cannot execute extensionless shebang files through execFile/spawn;
// a Windows runtime test needs a real native executable fixture, not a .cmd
// shim that would change the production launch semantics under test.
const describeExecutableAcp = process.platform === "win32"
  ? describe.skip
  : describe;

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describeExecutableAcp("ACP runtime path overrides", () => {
  it.each(PROVIDERS)(
    "launches the $registryId absolute override after startup with a stale cached default",
    async ({ expectedArgs, registryId }) => {
      const tempDir = makeTempDir(`pwragent-${registryId}-override-`);
      const fixture = createExecutableAcpProviderFixture({
        rootDir: tempDir,
        registryId,
      });
      const env = fixtureDiscoveryEnv(fixture);
      const stateDb = StateDb.open(path.join(tempDir, "state.db"));
      const agentStore = new AcpAgentStore(stateDb);
      const sessionStore = new AcpSessionStore(stateDb);
      let adapter: AcpBackendAdapter | undefined;

      try {
        adapter = createAdapter({
          agentStore,
          sessionStore,
          discover: async () => [
            await discoverSingleProvider({ env, registryId, rootDir: tempDir }),
          ],
        });
        await adapter.listAvailableAgents();
        await adapter.close();
        adapter = undefined;

        // The fixture's own version proves discovery resolved the fixture
        // binary rather than an agent CLI installed on this machine.
        expect(
          agentStore.getInstalledAgent(`acp:${registryId}` as AcpBackendId),
        ).toMatchObject({
          activeCommand: fixture.defaultCommand,
          instances: [
            {
              command: fixture.defaultCommand,
              source: "path",
              version: "0.1.0-default",
            },
          ],
          version: "0.1.0-default",
        });
        const persistDiscovered = vi.spyOn(agentStore, "upsertInstalledAgent");

        adapter = createAdapter({
          agentStore,
          sessionStore,
          discover: async () => [
            await discoverSingleProvider({
              env,
              overridePath: fixture.overrideCommand,
              registryId,
              rootDir: tempDir,
            }),
          ],
        });

        const client = await adapter.getClient(
          `acp:${registryId}` as AcpBackendId,
        );
        await client.startSession({
          cwd: tempDir,
          executionMode: "default",
          mcpServers: "none",
        });

        const persisted = agentStore.getInstalledAgent(
          `acp:${registryId}` as AcpBackendId,
        );
        expect(persisted).toMatchObject({
          activeCommand: fixture.overrideCommand,
          launchDescriptor: {
            command: fixture.overrideCommand,
            args: expectedArgs,
          },
        });
        // Exact, not `arrayContaining`: an extra instance here means discovery
        // reached outside the fixture and found a real installation.
        expect(persisted?.instances).toEqual([
          {
            command: fixture.overrideCommand,
            source: "override",
            version: "0.2.0-override",
          },
          {
            command: fixture.defaultCommand,
            source: "path",
            version: "0.1.0-default",
          },
        ]);

        const settingsEntry = installedAcpAgentSettingsEntry(
          persisted as AcpInstalledAgentRecord,
        );
        const settingsUsing = settingsEntry.instances?.find(
          (instance) => instance.command === settingsEntry.activeCommand,
        );
        expect(settingsUsing).toMatchObject({
          command: fixture.overrideCommand,
          source: "override",
        });

        expect(acpLaunchMarkers(fixture)).toEqual([
          expect.objectContaining({
            argv: expectedArgs,
            executable: fixture.overrideCommand,
            id: `${registryId}-override`,
            version: "0.2.0-override",
          }),
        ]);
        const writesBeforeCachedLookup = persistDiscovered.mock.calls.length;
        await adapter.listAvailableAgents();
        expect(persistDiscovered).toHaveBeenCalledTimes(writesBeforeCachedLookup);
      } finally {
        await adapter?.close();
        stateDb.close();
      }
    },
    30_000,
  );

  it("disposes a memoized client when the Grok override changes", async () => {
    const tempDir = makeTempDir("pwragent-grok-override-change-");
    const first = createExecutableAcpProviderFixture({
      rootDir: tempDir,
      registryId: "grok",
      suffix: "first",
    });
    const second = createExecutableAcpProviderFixture({
      rootDir: tempDir,
      registryId: "grok",
      suffix: "second",
    });
    const env = fixtureDiscoveryEnv(first);
    const stateDb = StateDb.open(path.join(tempDir, "state.db"));
    const agentStore = new AcpAgentStore(stateDb);
    const sessionStore = new AcpSessionStore(stateDb);
    let overridePath = first.overrideCommand;
    let adapter: AcpBackendAdapter | undefined;

    try {
      agentStore.upsertInstalledAgent(
        await discoverSingleProvider({
          env,
          registryId: "grok",
          rootDir: tempDir,
        }),
      );
      expect(agentStore.getInstalledAgent("acp:grok")).toMatchObject({
        activeCommand: first.defaultCommand,
        instances: [
          {
            command: first.defaultCommand,
            source: "path",
            version: "0.1.0-default",
          },
        ],
      });
      adapter = createAdapter({
        agentStore,
        sessionStore,
        discover: async () => [
          await discoverSingleProvider({
            env,
            overridePath,
            registryId: "grok",
            rootDir: tempDir,
          }),
        ],
      });

      const firstClient = await adapter.getClient("acp:grok");
      await firstClient.startSession({
        cwd: tempDir,
        executionMode: "default",
        mcpServers: "none",
      });

      overridePath = second.overrideCommand;
      adapter.invalidateLocalAgentDiscovery();
      const secondClient = await adapter.getClient("acp:grok");
      await secondClient.startSession({
        cwd: tempDir,
        executionMode: "default",
        mcpServers: "none",
      });

      expect(secondClient).not.toBe(firstClient);
      await vi.waitFor(() => {
        expect(
          first.readMarkers().some((marker) => marker.kind === "disposed"),
        ).toBe(true);
      });
      expect(acpLaunchMarkers(first)).toEqual([
        expect.objectContaining({
          argv: ["agent", "stdio"],
          executable: first.overrideCommand,
        }),
      ]);
      expect(acpLaunchMarkers(second)).toEqual([
        expect.objectContaining({
          argv: ["agent", "stdio"],
          executable: second.overrideCommand,
        }),
      ]);
      expect(agentStore.getInstalledAgent("acp:grok")).toMatchObject({
        activeCommand: second.overrideCommand,
        launchDescriptor: { command: second.overrideCommand },
      });
    } finally {
      await adapter?.close();
      stateDb.close();
    }
  }, 30_000);
});

function createAdapter(params: {
  agentStore: AcpAgentStore;
  discover: () => Promise<AcpInstalledAgentRecord[]>;
  sessionStore: AcpSessionStore;
}): AcpBackendAdapter {
  return new AcpBackendAdapter({
    acpAgentStore: params.agentStore,
    acpRolloutStore: null,
    acpSessionStore: params.sessionStore,
    captureStores: [],
    checkGrokCliUpdate: null,
    discoverLocalAcpAgents: params.discover,
    emit: async () => undefined,
    handleServerRequest: async () => ({ decision: "accept" }),
  });
}

/**
 * Runs the real discovery pipeline, confined to `rootDir`.
 *
 * An `env.PATH` override alone does NOT sandbox discovery: the kit also probes
 * well-known `$HOME` bin dirs and each strategy's absolute fallback candidates
 * (`~/.kimi-code/bin/kimi`, `/opt/homebrew/bin/qwen`, …). Left unconfined this
 * `execFile`s whichever agent CLIs the developer has installed — hundreds of
 * real `kimi` / `grok` / `qwen` processes per suite run — and asserts against
 * their versions instead of the fixture's. `listExecutables` + `fallbackRootDir`
 * are the seams that keep every candidate inside the fixture; the
 * agent-cli-spawn guard in `setup/agent-cli-spawn-guard.ts` fails the test if
 * one escapes anyway.
 */
async function discoverSingleProvider(params: {
  env: NodeJS.ProcessEnv;
  overridePath?: string;
  registryId: ProviderCase["registryId"];
  rootDir: string;
}): Promise<AcpInstalledAgentRecord> {
  const records = await discoverLocalAcpAgentRecords({
    enabledRegistryIds: [params.registryId],
    env: params.env,
    bundledGrokCommand: null,
    fallbackRootDir: params.rootDir,
    listExecutables: fixtureListExecutables(params.rootDir),
    ...(params.overridePath
      ? { preferences: { [params.registryId]: { overridePath: params.overridePath } } }
      : {}),
  });
  const record = records.find(
    (candidate) => candidate.registryId === params.registryId,
  );
  if (!record) {
    throw new Error(`Fake ${params.registryId} executable was not discovered`);
  }
  expectInstancesInside(params.rootDir, record.instances ?? []);
  return record;
}

/**
 * `PATH` lister that only ever yields executables under `rootDir`. The kit's
 * default lister appends the operator's well-known bin dirs to `env.PATH`, and
 * the fixture `PATH` itself has to carry the Node bin dir so the fixtures'
 * `#!/usr/bin/env node` shebang resolves — which is exactly where a globally
 * installed `gemini` or `qwen` lives.
 */
function fixtureListExecutables(rootDir: string): AcpPathExecutableLister {
  return (command, env) => {
    if (command.includes(path.sep)) {
      return [];
    }
    const found: string[] = [];
    for (const dir of (env.PATH ?? "").split(path.delimiter)) {
      const candidate = path.join(dir, command);
      if (!isInside(rootDir, candidate)) {
        continue;
      }
      try {
        const stat = statSync(candidate);
        if (stat.isFile() && (stat.mode & 0o111) !== 0) {
          found.push(candidate);
        }
      } catch {
        // Not installed in this directory.
      }
    }
    return found;
  };
}

function expectInstancesInside(
  rootDir: string,
  instances: readonly AcpAgentInstance[],
): void {
  for (const instance of instances) {
    expect(
      isInside(rootDir, instance.command),
      `discovered ${instance.command} outside the fixture root ${rootDir}`,
    ).toBe(true);
  }
}

function isInside(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return (
    relative.length > 0
    && !relative.startsWith("..")
    && !path.isAbsolute(relative)
  );
}

function fixtureDiscoveryEnv(
  fixture: ExecutableAcpProviderFixture,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [
      path.dirname(fixture.defaultCommand),
      path.dirname(process.execPath),
      "/usr/bin",
      "/bin",
    ].join(path.delimiter),
  };
}

function acpLaunchMarkers(fixture: ExecutableAcpProviderFixture) {
  return fixture.readMarkers().filter((marker) => marker.kind === "acp");
}

function makeTempDir(prefix: string): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}
