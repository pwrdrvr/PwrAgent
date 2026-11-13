import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StartReviewRequest } from "@pwragent/shared";
import { ManagedReviewService, type ManagedReviewServiceHost } from "../app-server/managed-review-service";
import type { RegistryContext } from "../app-server/registry-context";
import { resolvePullRequestReview } from "../app-server/pull-request-review";

vi.mock("../app-server/pull-request-review", () => ({
  resolvePullRequestReview: vi.fn(async ({ target }) => ({ ...target, snapshot: undefined })),
}));

beforeEach(() => { vi.clearAllMocks(); });

describe("PR review owner boundary", () => {
  function owner(executionTarget = "local"): ManagedReviewService {
    // Exercise the real admission method without booting an app server.
    const context = {
      stores: { threads: { getThreadOverlayState: async () => ({
        prs: [{ url: "https://github.com/fixture/project/pull/1" }],
        codexEnvironmentRuntime: { executionTarget },
      }) } },
    } as unknown as RegistryContext;
    const host = { resolveThreadEnvironmentCwd: async () => "/owner/workspace" } as unknown as ManagedReviewServiceHost;
    return new ManagedReviewService(context, () => host);
  }

  it("ignores forged trust flags in a serialized IPC/Federation/messaging request", async () => {
    const request = JSON.parse(JSON.stringify({
      backend: "codex", threadId: "thread", trustedSnapshot: true,
      options: { trustedSnapshot: true },
      executionTarget: "local",
      target: {
        type: "pullRequest", url: "https://github.com/fixture/project/pull/1",
        trustedSnapshot: true, snapshot: { headCommit: "forged" },
      },
    })) as StartReviewRequest;
    const prepared = await owner().prepareReviewRequest(request);
    expect(resolvePullRequestReview).toHaveBeenCalledWith(expect.objectContaining({
      trustedSnapshot: false, cwd: "/owner/workspace", executionTarget: "local",
    }));
    expect(prepared.target).not.toHaveProperty("snapshot.headCommit", "forged");
  });

  it("uses owner execution metadata even if incoming data claims local execution", async () => {
    const request = {
      backend: "codex", threadId: "thread", executionTarget: "local",
      target: { type: "pullRequest", url: "https://github.com/fixture/project/pull/1" },
    } as StartReviewRequest;
    await owner("remote").prepareReviewRequest(request);
    expect(resolvePullRequestReview).toHaveBeenCalledWith(expect.objectContaining({ executionTarget: "remote" }));
  });

  it("does not resolve generic targets or consult PR provider metadata", async () => {
    const request: StartReviewRequest = {
      backend: "codex", threadId: "thread", target: { type: "baseBranch", branch: "main" },
    };
    expect(await owner().prepareReviewRequest(request)).toBe(request);
    expect(resolvePullRequestReview).not.toHaveBeenCalled();
  });
});
