import { describe, expect, it, vi } from "vitest";
import type { ProviderCatalogRefreshState } from "@pwragent/shared";
import {
  ProviderCatalogRefreshCoordinator,
  type ProviderCatalogRefreshCodexProgress,
  type ProviderCatalogRefreshProgress,
} from "../settings/provider-catalog-refresh";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function createCoordinator() {
  const published: ProviderCatalogRefreshState[] = [];
  const codex = deferred<{ modelCount?: number }>();
  const acp = deferred<void>();
  let progress: ProviderCatalogRefreshProgress | undefined;
  let codexProgress: ProviderCatalogRefreshCodexProgress | undefined;
  let clock = 1_000;
  const refreshAcp = vi.fn(async (next: ProviderCatalogRefreshProgress) => {
    progress = next;
    await acp.promise;
  });
  const coordinator = new ProviderCatalogRefreshCoordinator({
    now: () => clock,
    publish: (state) => published.push(state),
    listAcpProviders: () => [
      { id: "grok", label: "Grok" },
      { id: "kimi", label: "Kimi Code CLI" },
    ],
    refreshCodex: async (next) => {
      codexProgress = next;
      return await codex.promise;
    },
    refreshAcp,
  });
  return {
    acp,
    advance: (ms: number) => {
      clock += ms;
    },
    codex,
    codexProgress: () => {
      if (!codexProgress) {
        throw new Error("refreshCodex has not started");
      }
      return codexProgress;
    },
    coordinator,
    progress: () => {
      if (!progress) {
        throw new Error("refreshAcp has not started");
      }
      return progress;
    },
    published,
    refreshAcp,
  };
}

function provider(state: ProviderCatalogRefreshState | undefined, id: string) {
  return state?.providers.find((entry) => entry.id === id);
}

describe("ProviderCatalogRefreshCoordinator", () => {
  it("lists every provider as soon as the run starts", () => {
    const { coordinator } = createCoordinator();

    const state = coordinator.start();

    expect(state).toMatchObject({ runId: 1, status: "running" });
    expect(state.providers).toEqual([
      expect.objectContaining({
        id: "codex",
        status: "running",
        detail: "Starting Codex",
      }),
      { id: "grok", label: "Grok", status: "pending" },
      { id: "kimi", label: "Kimi Code CLI", status: "pending" },
    ]);
  });

  it("reports Codex while an ACP provider is still hung", async () => {
    const { codex, coordinator, progress } = createCoordinator();
    coordinator.start();
    await vi.waitFor(() => progress());

    progress().onProvider("grok", {
      status: "running",
      detail: "Opening a session",
    });
    codex.resolve({ modelCount: 5 });

    await vi.waitFor(() => {
      expect(provider(coordinator.read(), "codex")).toMatchObject({
        status: "succeeded",
        modelCount: 5,
      });
    });
    expect(provider(coordinator.read(), "grok")).toMatchObject({
      status: "running",
      detail: "Opening a session",
    });
    expect(coordinator.read()?.status).toBe("running");
  });

  it("moves Codex to its model reads once it connects", async () => {
    const { codex, codexProgress, coordinator } = createCoordinator();
    coordinator.start();
    await vi.waitFor(() => codexProgress());

    codexProgress().onConnected();

    expect(provider(coordinator.read(), "codex")).toMatchObject({
      status: "running",
      detail: "Reading models and account",
      startedAt: 1_000,
    });
    codex.resolve({ modelCount: 5 });
    await vi.waitFor(() => {
      expect(provider(coordinator.read(), "codex")).toMatchObject({
        status: "succeeded",
        modelCount: 5,
      });
    });
    expect(provider(coordinator.read(), "codex")?.detail).toBeUndefined();
  });

  it("settles immediately on cancel and drops what the dying run reports", async () => {
    const { advance, codex, codexProgress, coordinator, progress } =
      createCoordinator();
    const { runId } = coordinator.start();
    await vi.waitFor(() => progress());
    progress().onProvider("kimi", { status: "succeeded", modelCount: 4 });
    progress().onProvider("grok", {
      status: "running",
      detail: "Reading model 2 of 4",
    });
    advance(90_000);

    const cancelled = coordinator.cancel(runId);

    expect(cancelled).toMatchObject({ status: "cancelled", finishedAt: 91_000 });
    expect(progress().signal.aborted).toBe(true);
    expect(codexProgress().signal.aborted).toBe(true);
    expect(provider(cancelled, "kimi")).toMatchObject({
      status: "succeeded",
      modelCount: 4,
    });
    expect(provider(cancelled, "grok")).toMatchObject({
      status: "cancelled",
      startedAt: 1_000,
      finishedAt: 91_000,
    });
    expect(provider(cancelled, "codex")?.status).toBe("cancelled");

    progress().onProvider("grok", { status: "failed", error: "closed" });
    codexProgress().onConnected();
    codex.resolve({ modelCount: 5 });
    await Promise.resolve();
    expect(coordinator.read()).toBe(cancelled);
  });

  it("joins the run in progress instead of starting a second one", async () => {
    const { acp, codex, coordinator, refreshAcp } = createCoordinator();
    const first = coordinator.start();

    expect(coordinator.start().runId).toBe(first.runId);
    await vi.waitFor(() => expect(refreshAcp).toHaveBeenCalledTimes(1));

    codex.resolve({});
    acp.resolve();
    await vi.waitFor(() => {
      expect(coordinator.read()?.status).toBe("completed");
    });
    expect(coordinator.start().runId).toBe(first.runId + 1);
  });

  it("fails the providers a shared discovery failure left without an answer", async () => {
    const { acp, codex, coordinator, progress } = createCoordinator();
    coordinator.start();
    await vi.waitFor(() => progress());
    progress().onProvider("kimi", { status: "skipped", detail: "Not installed" });

    codex.resolve({ modelCount: 5 });
    acp.reject(new Error("shell environment timed out"));

    await vi.waitFor(() => {
      expect(coordinator.read()?.status).toBe("completed");
    });
    expect(provider(coordinator.read(), "grok")).toMatchObject({
      status: "failed",
      error: "shell environment timed out",
    });
    expect(provider(coordinator.read(), "kimi")?.status).toBe("skipped");
  });

  it("publishes every change with a higher revision", async () => {
    const { acp, codex, coordinator, progress, published } =
      createCoordinator();
    coordinator.start();
    await vi.waitFor(() => progress());
    progress().onPhase("Finding installed CLIs");
    progress().onPhase(undefined);
    codex.resolve({});
    acp.resolve();
    await vi.waitFor(() => {
      expect(coordinator.read()?.status).toBe("completed");
    });

    const revisions = published.map((state) => state.revision);
    expect(revisions).toEqual(
      [...revisions].sort((left, right) => left - right),
    );
    expect(new Set(revisions).size).toBe(revisions.length);
    expect(published.some((state) => state.phase === "Finding installed CLIs"))
      .toBe(true);
    expect(coordinator.read()?.phase).toBeUndefined();
  });
});
