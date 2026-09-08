import { expect, it, vi } from "vitest";
import type { NavigationLaunchpadConfigResponse } from "@pwragent/shared";
import { NavigationQueryStore } from "../app-server/navigation-query-store";
import { readMessagingLaunchpadContext } from "../messaging/core/messaging-launchpad-context";

function fixture() {
  const defaults = { backend: "codex" as const, executionMode: "default" as const };
  const project = { directoryKey: "directory:repo", path: "/repo", label: "Untrusted callback label" };
  const store = new NavigationQueryStore();
  const read = vi.fn(async (): Promise<NavigationLaunchpadConfigResponse> => ({
    protocol: 2, revision: "owner", defaults, directoryKey: project.directoryKey,
    directoryGitStatus: { currentBranch: "main", branches: ["main", "feature"] },
    launchpad: { ...defaults, directoryKey: project.directoryKey, directoryLabel: "Repo", directoryKind: "directory", directoryPath: "/repo",
      createdAt: 1, updatedAt: 1, workMode: "local", codexEnvironmentOptions: [] },
  }));
  const backend: Parameters<typeof readMessagingLaunchpadContext>[0]["backend"] = {
    getNavigationLaunchpadConfig: read,
    getNavigationQueryPage: (request) => store.readPage({ request, scopeKey: "test", loadIndex: async () => ({ threads: [], directories: [
      { key: project.directoryKey, path: "/repo", label: "Repo", kind: "directory", threadKeys: [], needsAttentionCount: 0 },
    ] }) }),
    ensureDirectoryLaunchpad: vi.fn(async () => { throw new Error("Owner unavailable"); }),
  };
  return { backend, read, project };
}

it("loads only exact directory configuration and never invents a thread collection", async () => {
  const { backend, project } = fixture();
  const context = await readMessagingLaunchpadContext({ backend, project });
  expect(context).toMatchObject({ kind: "launchpad", directory: { label: "Repo", key: "directory:repo", gitStatus: { branches: ["main", "feature"] } } });
  expect(context).not.toHaveProperty("threads");
  expect(context.directory).not.toHaveProperty("threadKeys");
  expect(context.directory?.launchpad).not.toHaveProperty("prompt");
});

it("rejects a missing owner directory before preparing a launchpad", async () => {
  const { backend, project, read } = fixture();
  read.mockResolvedValue({ protocol: 2, revision: "owner", defaults: { backend: "codex", executionMode: "default" }, directoryKey: "missing" });
  await expect(readMessagingLaunchpadContext({ backend, project: { ...project, directoryKey: "missing" }, ensureBackend: "codex" }))
    .rejects.toThrow("no longer available");
  expect(backend.ensureDirectoryLaunchpad).not.toHaveBeenCalled();
});

it("propagates an owner preparation failure instead of reusing previous configuration", async () => {
  const { backend, project } = fixture();
  await expect(readMessagingLaunchpadContext({ backend, project, ensureBackend: "codex" })).rejects.toThrow("Owner unavailable");
  expect(backend.ensureDirectoryLaunchpad).toHaveBeenCalledWith({ directoryKey: "directory:repo", directoryKind: "directory", directoryLabel: "Repo",
    directoryPath: "/repo", preferredBackend: "codex" });
});

it("rejects wrong-project configuration even when the callback label and path match", async () => {
  const { backend, project, read } = fixture();
  const detail = await read();
  read.mockResolvedValue({ ...detail, launchpad: { ...detail.launchpad!, directoryKey: "another" } });
  await expect(readMessagingLaunchpadContext({ backend, project })).rejects.toThrow("another project");
});
