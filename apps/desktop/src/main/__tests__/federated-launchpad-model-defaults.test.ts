import { expect, it, onTestFinished, vi } from "vitest";
import { FEDERATION_BACKEND_METHOD_CAPABILITIES } from "@pwragent/federation/federation-backend-methods";
import { applyNavigationLaunchpadProviderSettingsPatch, type NavigationLaunchpadDraft } from "@pwragent/shared/contracts/navigation";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { NavigationDetailService } from "../app-server/navigation-detail-service";
import {
  FederationRemoteBackendClient,
  registerFederationBackendHandlers,
  type FederationBackendOperations,
} from "../federation/federation-backend-bridge";
import { registerNavigationBackendHandlers } from "../federation/federation-navigation-handlers";
import { FederationRouter } from "../federation/federation-router";
import { FederationRpcEndpoint } from "../federation/federation-rpc";
import { StateDb } from "../state/state-db";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createOverlayStoreMock, MockBackendClient } from "./helpers/backend-registry-fixture";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

const stores = vi.hoisted(() => ({ owner: undefined as SqliteOverlayStore | undefined }));
vi.mock("../storage/desktop-overlay-store", () => ({
  getDesktopOverlayStore: () => stores.owner,
  getOwnerOverlayStore: () => stores.owner,
}));
vi.mock("../acp/acp-instance-discovery", () => ({
  discoverLocalAcpAgentRecords: vi.fn(async () => []),
}));

const terra = "gpt-6.1-terra";
const sol = "gpt-6.2-sol";
const target = { scope: "remote", instanceId: "m2" } as const;
const launchpad = {
  directoryKey: "project",
  directoryKind: "directory",
  directoryLabel: "Project",
  backend: "codex",
  executionMode: "default",
  model: terra,
  reasoningEffort: "low",
  prompt: "",
  workMode: "local",
  createdAt: 1,
  updatedAt: 1,
} satisfies NavigationLaunchpadDraft;

async function setup() {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const temp = createTempStateDb("federated-launchpad-defaults-");
  const db = StateDb.open(temp.dbPath);
  const store = new SqliteOverlayStore(db);
  stores.owner = store;
  const codexClient = new MockBackendClient({
    models: [terra, sol].map((id) => ({ id, reasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" })),
  });
  const start = vi.spyOn(codexClient, "startThread");
  const makeRegistry = (overlayStore: SqliteOverlayStore | ReturnType<typeof createOverlayStoreMock>, client: MockBackendClient) =>
    createDesktopBackendRegistry({
      codexClient: client, overlayStore, agentToolMcpServer: null, pdfToolMcpServer: null,
      threadTitleGenerationService: null,
      gitDirectoryService: { prepareLaunchpadWorkspace: async () => ({ cwd: "/fixture/project", workMode: "local" }) } as never,
    });
  const owner = makeRegistry(store, codexClient);
  const viewerStore = createOverlayStoreMock();
  const viewer = makeRegistry(viewerStore, new MockBackendClient({ models: [{ id: "viewer-only" }] }));
  onTestFinished(async () => {
    await Promise.all([owner.close(), viewer.close()]);
    db.close();
    removeTempStateDbDir(temp.tempDir);
    stores.owner = undefined;
    vi.unstubAllEnvs();
  });
  const detail = new NavigationDetailService(owner);
  const router = new FederationRouter({ localInstanceId: target.instanceId, methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES });
  registerFederationBackendHandlers({
    router, backend: {
      materializeDirectoryLaunchpad: (request, options) => owner.materializeDirectoryLaunchpad(request, options),
    } as FederationBackendOperations,
  });
  registerNavigationBackendHandlers({ router, backend: { getNavigationLaunchpadConfig: (request) => detail.readLaunchpadConfig(request) } });
  const rpc = new FederationRpcEndpoint({
    localInstanceId: "m5", remoteInstanceId: target.instanceId,
    sendEnvelope: (envelope) => { void router.routeEnvelope({ envelope: JSON.parse(JSON.stringify(envelope)), sourcePeerId: "m5" }); },
  });
  router.registerConnection({
    peerId: "m5", capabilities: ["environment_actions", "thread_detail"],
    sendEnvelope: (envelope) => { rpc.receiveEnvelope(JSON.parse(JSON.stringify(envelope))); },
  });
  const remote = new FederationRemoteBackendClient(rpc);
  const read = async () => (await remote.getNavigationLaunchpadConfig({ protocol: 2, directoryKey: "next-project" })).defaults!;
  await store.setLaunchpadDefaults({ ...pick(terra, "low"), backend: "codex", executionMode: "default" });
  const open = async (model: string, reasoningEffort: string) => {
    await viewer.resetDirectoryLaunchpad({ directoryKey: launchpad.directoryKey }, { owner: target });
    await viewer.ensureDirectoryLaunchpad(launchpad, { owner: target, skipFilesystemInspection: true, skipMcpConnectionDefaults: true });
    return (await viewer.updateDirectoryLaunchpad({ directoryKey: launchpad.directoryKey, patch: { ...pick(model, reasoningEffort), backend: "codex" } }, { owner: target })).launchpad;
  };
  const edit = async (patch: Parameters<typeof viewer.updateDirectoryLaunchpad>[0]["patch"], sticky = true, explicit = sticky) =>
    (await viewer.updateDirectoryLaunchpad({ directoryKey: launchpad.directoryKey, patch, stickySettingsChanged: sticky, explicitModelSelection: explicit }, { owner: target })).launchpad;
  const submit = (draft: NavigationLaunchpadDraft, operationId: string = crypto.randomUUID()) =>
    remote.materializeDirectoryLaunchpad({
      directoryKey: draft.directoryKey, launchpad: draft, operationId,
    });
  await open(terra, "low");
  return { start, store, viewer, viewerStore, read, open, edit, submit };
}

function pick(model: string, reasoningEffort: string) {
  return { model, reasoningEffort };
}

it("serves the model and effort from an accepted peer launch to the next composer", async () => {
  const { start, viewerStore, read, open, edit, submit } = await setup();
  const viewerDefaults = await viewerStore.getLaunchpadDefaults();
  await open(terra, "low");
  const draft = await edit(pick(sol, "high"));
  const { result, writes } = await measureSqliteWrites(() => submit(draft, "peer-launch"));
  expect(start).toHaveBeenCalledWith(expect.objectContaining(pick(sol, "high")));
  expect(await read()).toMatchObject(pick(sol, "high"));
  expect(await viewerStore.getLaunchpadDefaults()).toEqual(viewerDefaults);
  expectSqliteWriteBudget({
    scenario: "federated-launchpad-model-defaults",
    note: "One peer launch with an explicit model choice, including the ordinary thread creation writes.",
    writes,
  });

  await submit(await edit(pick(terra, "low")), "different-launch");
  expect(await submit(draft, "peer-launch")).toEqual(result);
  expect(await read()).toMatchObject(pick(terra, "low"));
  expect(start).toHaveBeenCalledTimes(2);
});

it("files a peer effort pick under the model's provider without changing the default provider", async () => {
  const { store, viewer, read, open, edit, submit } = await setup();
  await store.setLaunchpadDefaults({ backend: "claude", model: "opus" });
  await open(terra, "low");
  await edit({ reasoningEffort: "high" });
  await submit(await edit({ executionMode: "full-access" }));
  const ownerDefaults = await read();
  expect(ownerDefaults).toMatchObject({
    backend: "claude",
    model: "opus",
    providerSettings: { codex: { ...pick(terra, "high"), executionMode: "default" } },
  });
  await open(sol, "low");
  const fresh = await viewer.updateDirectoryLaunchpad({
    directoryKey: launchpad.directoryKey,
    patch: { backend: "claude", model: "opus" },
  }, { owner: target, ownerProviderSettings: ownerDefaults.providerSettings });
  expect(applyNavigationLaunchpadProviderSettingsPatch(fresh.launchpad, { backend: "codex" }))
    .toMatchObject(pick(terra, "high"));
});

it("does not learn a rejected model, an inherited choice, or an access-only edit", async () => {
  const { start, read, open, edit, submit } = await setup();
  await open(terra, "low");
  await expect(submit(await edit(pick("viewer-only", "high")))).rejects.toThrow("not available");
  start.mockRejectedValueOnce(new Error("Provider refused the thread"));
  await expect(submit(await edit(pick(sol, "high")))).rejects.toThrow("Provider refused the thread");
  expect(await read()).toMatchObject(pick(terra, "low"));

  await open(sol, "high");
  await submit(await edit(pick(sol, "high"), true, false));
  expect(await read()).toMatchObject(pick(terra, "low"));
  await submit(await edit({ executionMode: "full-access" }));
  expect(await read()).toMatchObject({ ...pick(terra, "low"), executionMode: "default" });

  const changedByRefresh = { ...await edit(pick(sol, "high")), model: terra, providerSettings: undefined };
  await submit(changedByRefresh);
  expect(await read()).toMatchObject(pick(terra, "low"));
});
