import fc from "fast-check";
import type { AppServerBackendKind } from "@pwragent/shared";
import { describe, expect, it, vi } from "vitest";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

vi.mock("../log", () => ({
  getMainLogger: vi.fn(() => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() })),
}));

// No ACP agents: discovery would otherwise probe the machine.
vi.mock("../acp/acp-instance-discovery", () => ({
  discoverLocalAcpAgentRecords: vi.fn(async () => []),
}));

/**
 * Rule: a sticky launchpad choice is saved under the launchpad's own
 * provider. A provider's saved defaults only ever hold that provider's
 * models, so switching any launchpad to a provider never brings in another
 * provider's model. Access is filed the same way and never changes the
 * provider new launchpads start on. Broken before #3354: a Codex pick was
 * saved as the Claude default, and new Claude launchpads started on
 * `gpt-6.1-terra`.
 *
 * Oracle: each provider's model catalog, plus a model of the last sticky
 * pick per provider and the provider the defaults follow.
 */

type Provider = "codex" | "claude";
const PROVIDERS: Provider[] = ["codex", "claude"];
const CATALOGS: Record<Provider, string[]> = {
  codex: ["gpt-5.4", "gpt-5.5"],
  claude: ["opus", "sonnet"],
};
const DIRECTORIES = ["directory:/repo-a", "directory:/repo-b"];

type Model = {
  /** The provider each directory's launchpad runs. */
  launchpadBackend: Record<string, Provider>;
  /** The last sticky model chosen for each provider. */
  stickyModel: Record<Provider, string>;
  /** The last sticky access chosen for each provider. */
  stickyAccess: Record<Provider, string | undefined>;
  /** The provider new launchpads start on. */
  defaultsBackend: Provider;
};

type Real = {
  registry: DesktopBackendRegistry;
  store: SqliteOverlayStore;
};

async function expectAgreement(model: Model, real: Real): Promise<void> {
  const defaults = await real.store.getLaunchpadDefaults();
  for (const provider of PROVIDERS) {
    const saved = defaults.providerSettings?.[provider]?.model;
    expect(saved, `saved ${provider} default`).toBe(model.stickyModel[provider]);
    expect(
      defaults.providerSettings?.[provider]?.executionMode,
      `saved ${provider} access`,
    ).toBe(model.stickyAccess[provider]);
  }
  expect(defaults.backend).toBe(model.defaultsBackend);
  expect(CATALOGS[defaults.backend as Provider]).toContain(defaults.model);
  for (const directoryKey of DIRECTORIES) {
    const launchpad = await real.store.getDirectoryLaunchpad({ directoryKey });
    expect(launchpad?.backend).toBe(model.launchpadBackend[directoryKey]);
    expect(CATALOGS[launchpad!.backend as Provider]).toContain(launchpad!.model);
  }
}

class SwitchProvider implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly directoryKey: string,
    readonly provider: Provider,
    readonly sticky: boolean,
  ) {}
  check(): boolean {
    return true;
  }
  async run(model: Model, real: Real): Promise<void> {
    await real.registry.updateDirectoryLaunchpad({
      directoryKey: this.directoryKey,
      patch: { backend: this.provider as AppServerBackendKind },
      stickySettingsChanged: this.sticky,
    });
    model.launchpadBackend[this.directoryKey] = this.provider;
    if (this.sticky) model.defaultsBackend = this.provider;
    await expectAgreement(model, real);
  }
  toString(): string {
    return `switch(${this.directoryKey}, ${this.provider}${this.sticky ? ", sticky" : ""})`;
  }
}

/** The model menu lists only the launchpad's own provider's models. */
class PickModel implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly directoryKey: string,
    readonly choice: number,
    readonly sticky: boolean,
  ) {}
  check(): boolean {
    return true;
  }
  async run(model: Model, real: Real): Promise<void> {
    const provider = model.launchpadBackend[this.directoryKey];
    const catalog = CATALOGS[provider];
    const picked = catalog[this.choice % catalog.length];
    await real.registry.updateDirectoryLaunchpad({
      directoryKey: this.directoryKey,
      patch: { model: picked },
      stickySettingsChanged: this.sticky,
    });
    if (this.sticky) {
      model.stickyModel[provider] = picked;
      // A sticky pick makes the launchpad's provider the default one.
      model.defaultsBackend = provider;
    }
    await expectAgreement(model, real);
  }
  toString(): string {
    return `pick(${this.directoryKey}, #${this.choice}${this.sticky ? ", sticky" : ""})`;
  }
}

/** Access is per provider too, and choosing it does not change the default provider. */
class SetAccess implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly directoryKey: string,
    readonly executionMode: "auto" | "full-access",
    readonly sticky: boolean,
  ) {}
  check(): boolean {
    return true;
  }
  async run(model: Model, real: Real): Promise<void> {
    const { launchpad } = await real.registry.updateDirectoryLaunchpad({
      directoryKey: this.directoryKey,
      patch: { executionMode: this.executionMode },
      stickySettingsChanged: this.sticky,
    });
    if (this.sticky) {
      // The launchpad's own access, as its provider allows it.
      model.stickyAccess[model.launchpadBackend[this.directoryKey]] = launchpad.executionMode;
    }
    await expectAgreement(model, real);
  }
  toString(): string {
    return `access(${this.directoryKey}, ${this.executionMode}${this.sticky ? ", sticky" : ""})`;
  }
}

const directory = fc.constantFrom(...DIRECTORIES);
const commands = [
  fc.tuple(directory, fc.constantFrom(...PROVIDERS), fc.boolean())
    .map(([key, provider, sticky]) => new SwitchProvider(key, provider, sticky)),
  fc.tuple(directory, fc.nat({ max: 3 }), fc.boolean())
    .map(([key, choice, sticky]) => new PickModel(key, choice, sticky)),
  fc.tuple(directory, fc.constantFrom("auto" as const, "full-access" as const), fc.boolean())
    .map(([key, mode, sticky]) => new SetAccess(key, mode, sticky)),
];

async function setup(): Promise<{ model: Model; real: Real; dispose: () => Promise<void> }> {
  const stateDb = openInMemoryStateDb();
  const store = new SqliteOverlayStore(stateDb);
  // Saved defaults for both providers, currently on Claude.
  await store.setLaunchpadDefaults({ backend: "codex", model: "gpt-5.4" });
  await store.setLaunchpadDefaults({ backend: "claude", model: "opus" });
  const registry = new DesktopBackendRegistry({
    codexClient: {
      close: async () => {},
      getInitializeResult: async () => ({ methods: ["thread/start"] }),
      listModels: async () => CATALOGS.codex.map((id) => ({ id, label: id })),
      listThreads: async () => [],
      onNotification: () => () => {},
      onPendingRequest: () => () => {},
    } as never,
    overlayStore: store,
    agentToolMcpServer: null,
    pdfToolMcpServer: null,
    threadTitleGenerationService: null,
    claudeBackendOptions: {
      inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" }),
      discoverModels: async () => CATALOGS.claude.map((id) => ({ id, label: id })),
    },
  });
  for (const directoryKey of DIRECTORIES) {
    await registry.ensureDirectoryLaunchpad({
      directoryKey,
      directoryKind: "directory",
      directoryLabel: directoryKey,
      directoryPath: directoryKey.slice("directory:".length),
    });
  }
  const seeded = await store.getLaunchpadDefaults();
  const model: Model = {
    launchpadBackend: Object.fromEntries(DIRECTORIES.map((key) => [key, "claude"])),
    stickyModel: { codex: "gpt-5.4", claude: "opus" },
    stickyAccess: {
      codex: seeded.providerSettings?.codex?.executionMode,
      claude: seeded.providerSettings?.claude?.executionMode,
    },
    defaultsBackend: "claude",
  };
  const real = { registry, store };
  await expectAgreement(model, real);
  return {
    model,
    real,
    dispose: async () => {
      await registry.close();
      stateDb.close();
    },
  };
}

describe("launchpad sticky defaults", () => {
  it("keeps each provider's saved defaults on that provider's models", async () => {
    await fc.assert(
      fc.asyncProperty(fc.commands(commands, { maxCommands: 12 }), async (cmds) => {
        const { model, real, dispose } = await setup();
        try {
          await fc.asyncModelRun(() => ({ model, real }), cmds);
        } finally {
          await dispose();
        }
      }),
      { numRuns: 30 },
    );
  });
});
