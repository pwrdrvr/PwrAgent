import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const drivers = [
  { name: "explicit identity", load: async () => (await import("../../../e2e/fixtures/queue-explicit-identity-driver")).exerciseExplicitQueueIdentity },
  { name: "held identity", load: async () => (await import("../../../e2e/fixtures/queue-held-identity-driver")).exerciseHeldQueueIdentity },
  { name: "replacement", load: async () => async (root: string) => (await import("../../../e2e/fixtures/queue-agent-replacement-driver")).exerciseDesktopAgentReplacement(root, false) },
  { name: "grouped admission", load: async () => async (root: string) => (await import("../../../e2e/fixtures/queue-agent-admission-driver")).exerciseDesktopAgentAdmission(root, true) },
  { name: "self-started admission", load: async () => async (root: string) => (await import("../../../e2e/fixtures/queue-self-started-driver")).exerciseDesktopSelfStartedAdmission(root, "") },
  { name: "pause publication", load: async () => async (root: string) => (await import("../../../e2e/fixtures/queue-pause-publication-driver")).exerciseDesktopPausePublication(root, false) },
  { name: "wake-up pause durability", load: async () => (await import("../../../e2e/fixtures/queue-pause-publication-driver")).exerciseDesktopWakeupPauseDurability },
];
const temporaryRoots: string[] = [];
const reachedRegistry = "driver reached registry with its own host";

// Each E2E driver is bundled separately from the running application. A fresh
// module graph models that ownership boundary: the application's installed host
// cannot satisfy the driver's copy of owner-host. Stop at the first registry;
// this oracle checks boot contracts without launching Electron or running turns.
it.each(drivers)("$name installs its host before constructing an isolated registry", async ({ load }) => {
  vi.resetModules();
  const ownerHost = await import("../owner-host");
  expect(() => ownerHost.getOwnerHostServices()).toThrow(/before startOwnerServices/);
  vi.doMock("../app-server/backend-registry", () => ({
    DesktopBackendRegistry: class {
      constructor() {
        const host = ownerHost.getOwnerHostServices();
        expect(host.application.getVersion()).toBeTypeOf("string");
        // Queue drivers own protocol clients, rather than the app's replay.
        expect(host.replayClients()).toBeUndefined();
        throw new Error(reachedRegistry);
      }
    },
  }));
  vi.doMock("../storage/state-db", () => ({ StateDb: { open: () => ({}) } }));
  vi.doMock("../storage/overlay-store-sqlite", () => ({ SqliteOverlayStore: class {} }));
  vi.doMock("../codex-app-server/desktop-client", () => ({ CodexAppServerClient: class {} }));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-driver-host-"));
  temporaryRoots.push(root);
  await expect((await load())(root)).rejects.toThrow(reachedRegistry);
});

afterEach(() => {
  vi.doUnmock("../app-server/backend-registry");
  vi.doUnmock("../storage/state-db");
  vi.doUnmock("../storage/overlay-store-sqlite");
  vi.doUnmock("../codex-app-server/desktop-client");
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
