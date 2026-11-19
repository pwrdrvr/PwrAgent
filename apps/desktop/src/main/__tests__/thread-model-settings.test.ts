import { providerPickerValue } from "@pwragent/shared";
import { expect, it, vi } from "vitest";
import { ThreadModelSettings, type ThreadModelSettingsHost } from "../app-server/thread-model-settings";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { PerKeyAsyncLock } from "../util/per-key-async-lock";
import { openInMemoryStateDb } from "./sqlite-test-utils";

it("lets an earlier manual selection settle before marking an older migration as acknowledged", async () => {
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  const identity = { backend: "codex" as const, threadId: "fixture" };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const resolveModelSettings = vi.fn<ThreadModelSettingsHost["resolveModelSettings"]>(async (_backend, settings) => {
    entered.resolve();
    await release.promise;
    return settings;
  });
  const publishedEfforts: Array<string | undefined> = [];
  const owner = new ThreadModelSettings(store, {}, {
    getClientForSession: async () => { throw new Error("No ACP session expected"); },
    getInstalledAgent: () => undefined,
    getSession: () => undefined,
  }, {
    resolveCodexModelProvidersFn: () => [],
    resolveProviderModelDefaultsFn: () => ({}),
    resolveProviderThreadModelMigrationsFn: () => ({
      [providerPickerValue("codex", "fixture-current")]: {
        revision: "fixture-revision", model: "fixture-migration", createdAt: 1,
      },
    }),
  }, async ({ notification }) => {
    if (notification.method !== "thread/modelSettings/updated") return;
    publishedEfforts.push((await store.getThreadOverlayState(identity))?.reasoningEffort);
  }, () => ({
    findThreadForWorkspaceHandoff: async () => undefined,
    getBackendLaunchpadOptions: async () => undefined,
    resolveModelSettings,
    threadHasActiveTurn: () => false,
    acpSessionPromptLocks: new PerKeyAsyncLock(),
    threadInfoStore: { getSummary: () => undefined },
  }));
  const operations: Promise<unknown>[] = [];
  try {
    await store.setThreadModelSettings({ ...identity, model: "fixture-current", reasoningEffort: "low" });
    const manual = owner.setThreadModelSettings({ ...identity, reasoningEffort: "high" });
    operations.push(manual);
    await entered.promise;
    const migration = owner.applyThreadModelMigration({ ...identity, threadCreatedAt: 0 });
    operations.push(migration);
    release.resolve();
    await expect(manual).resolves.toMatchObject({ model: "fixture-current", reasoningEffort: "high" });
    await expect(migration).resolves.toMatchObject({
      model: "fixture-current", reasoningEffort: "high",
      status: "acknowledged-manual-change", revision: "fixture-revision",
    });
    expect(await store.getThreadOverlayState(identity)).toMatchObject({
      model: "fixture-current", reasoningEffort: "high", modelMigrationRevision: "fixture-revision",
    });
    expect(publishedEfforts).toEqual(["high"]);
  } finally {
    release.resolve();
    await Promise.allSettled(operations);
    db.close();
  }
});
