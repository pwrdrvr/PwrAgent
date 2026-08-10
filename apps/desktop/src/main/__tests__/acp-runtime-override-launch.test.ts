import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AcpBackendId } from "@pwragent/shared";
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

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("ACP runtime path overrides", () => {
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
            await discoverSingleProvider({ env, registryId }),
          ],
        });
        await adapter.listAvailableAgents();
        await adapter.close();
        adapter = undefined;

        expect(
          agentStore.getInstalledAgent(`acp:${registryId}` as AcpBackendId)
            ?.activeCommand,
        ).toBe(fixture.defaultCommand);
        const persistDiscovered = vi.spyOn(agentStore, "upsertInstalledAgent");

        adapter = createAdapter({
          agentStore,
          sessionStore,
          discover: async () => [
            await discoverSingleProvider({
              env,
              overridePath: fixture.overrideCommand,
              registryId,
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
        expect(persisted?.instances).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              command: fixture.overrideCommand,
              source: "override",
            }),
            expect.objectContaining({
              command: fixture.defaultCommand,
              source: "path",
            }),
          ]),
        );

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
        await discoverSingleProvider({ env, registryId: "grok" }),
      );
      adapter = createAdapter({
        agentStore,
        sessionStore,
        discover: async () => [
          await discoverSingleProvider({
            env,
            overridePath,
            registryId: "grok",
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

async function discoverSingleProvider(params: {
  env: NodeJS.ProcessEnv;
  overridePath?: string;
  registryId: ProviderCase["registryId"];
}): Promise<AcpInstalledAgentRecord> {
  const records = await discoverLocalAcpAgentRecords({
    enabledRegistryIds: [params.registryId],
    env: params.env,
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
  return record;
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
