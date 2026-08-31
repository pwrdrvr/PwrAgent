import { describe, expect, it } from "vitest";

import {
  PWRAGENT_FEDERATION_ERROR_CODES,
  PWRAGENT_FEDERATION_OPERATION_NAMES,
  type CreateInstanceThreadToolArgs,
  type FederationInstanceDescriptor,
  type SearchFederationThreadsResult,
} from "../federation-tools";

describe("federation tool contracts", () => {
  it("defines the federation tool operations", () => {
    expect(PWRAGENT_FEDERATION_OPERATION_NAMES).toEqual([
      "list_federation_instances",
      "list_instance_projects",
      "create_instance_thread",
      "search_federation_threads",
    ]);
  });

  it("defines structured federation error codes", () => {
    expect(PWRAGENT_FEDERATION_ERROR_CODES).toEqual([
      "invalid_arguments",
      "not_found",
      "peer_unavailable",
      "forbidden",
      "turn_start_failed",
      "internal_error",
    ]);
  });

  it("models instance descriptors with purpose notes and icons", () => {
    const descriptor: FederationInstanceDescriptor = {
      instanceId: "pwr_studio",
      label: "Studio Mac",
      isLocal: false,
      status: "connected",
      capabilities: ["thread_navigation", "federated_search"],
      notes: "PwrSnap dev + screen recording",
      icon: "nebula",
    };
    expect(descriptor.notes).toContain("PwrSnap");
  });

  it("models create-thread args and instance-scoped search results", () => {
    const args: CreateInstanceThreadToolArgs = {
      instanceId: "pwr_studio",
      projectKey: "dir:/Users/op/pwrsnap",
      input: "Fix the recorder crash on stop",
      executionMode: "full-access",
      tokenMiserEnabled: true,
      workMode: "worktree",
      branchName: "origin/main",
    };
    expect(args.projectKey).toContain("pwrsnap");
    expect(args.tokenMiserEnabled).toBe(true);

    const result: SearchFederationThreadsResult = {
      query: "recorder crash",
      totalCount: 1,
      truncated: false,
      results: [
        {
          instanceId: "pwr_studio",
          instanceLabel: "Studio Mac",
          isLocal: false,
          backend: "codex",
          threadId: "thread-1",
          title: "Recorder crash on stop",
          score: 1250,
        },
      ],
      searchedInstances: [
        {
          instanceId: "pwr_studio",
          instanceLabel: "Studio Mac",
          resultCount: 1,
        },
      ],
      failures: [],
    };
    expect(result.results[0]?.isLocal).toBe(false);
  });
});
