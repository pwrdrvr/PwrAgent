// The Star Map Agent tool: what an Agent turn is told about the map the
// operator is looking at, and what it is told when there is no map.
//
// The assertions worth keeping are the honesty ones. A truncated thread
// list has to say it truncated, and a cloud's counts must not shrink just
// because the list did.
import { describe, expect, it } from "vitest";
import type {
  PwrAgentStarMapResponse,
  StarMapViewSnapshot,
} from "@pwragent/shared";
import { createStarMapAgentToolsHandler } from "../star-map/star-map-agent-tools-service";
import { buildPwrAgentStarMapToolDefinitions } from "../agent-tools/pwragent-star-map-agent-tools";
import type {
  AgentToolCallContext,
  AgentToolDispatchResult,
} from "../agent-tools/agent-tool-definition";

function thread(
  overrides: Partial<StarMapViewSnapshot["threads"][number]> & {
    threadKey: string;
  },
): StarMapViewSnapshot["threads"][number] {
  return {
    backend: "codex",
    threadId: overrides.threadKey.split(":")[1] ?? overrides.threadKey,
    title: `Thread ${overrides.threadKey}`,
    instanceId: "local",
    instanceLabel: "This instance",
    isLocal: true,
    visible: true,
    selected: false,
    chatCardOpen: false,
    attention: [],
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<StarMapViewSnapshot> = {},
): StarMapViewSnapshot {
  return {
    capturedAt: 1_000,
    surface: "window",
    layout: "orbit",
    camera: { x: 0, y: 0, scale: 1 },
    viewport: { width: 1280, height: 800 },
    filters: [],
    hideOfflineInstances: false,
    hiddenInstanceCount: 0,
    instances: [
      {
        instanceId: "local",
        label: "This instance",
        isLocal: true,
        threadCount: 2,
        visibleThreadCount: 2,
      },
    ],
    clouds: [
      {
        key: "pwragent",
        label: "PwrAgent",
        instanceId: "local",
        instanceLabel: "This instance",
        isProject: true,
        isParentGroup: false,
        expanded: false,
        threadCount: 2,
        visibleCount: 1,
        hiddenCount: 1,
        threadKeys: ["codex:a", "codex:b"],
      },
    ],
    threads: [
      thread({ threadKey: "codex:a", cloudKey: "pwragent" }),
      thread({ threadKey: "codex:b", cloudKey: "pwragent", visible: false }),
    ],
    selectedThreadKeys: [],
    openChatCardThreadKeys: [],
    matchedThreadCount: 2,
    ...overrides,
  };
}

function expectOk<TOperation extends "read_star_map_view">(
  response: PwrAgentStarMapResponse<TOperation>,
): Extract<PwrAgentStarMapResponse<TOperation>, { ok: true }> {
  if (!response.ok) {
    throw new Error(`expected ok, got ${response.error.code}`);
  }
  return response as Extract<
    PwrAgentStarMapResponse<TOperation>,
    { ok: true }
  >;
}

describe("read_star_map_view", () => {
  it("reports how stale the published view is", async () => {
    const handler = createStarMapAgentToolsHandler({
      readView: () => snapshot({ capturedAt: 4_000 }),
      now: () => 5_500,
    });
    const response = expectOk(
      (await handler({
        operation: "read_star_map_view",
        context: {},
        args: {},
      })) as PwrAgentStarMapResponse<"read_star_map_view">,
    );
    expect(response.data.ageMs).toBe(1_500);
  });

  it("fails with a recoverable message when no map is open", async () => {
    const handler = createStarMapAgentToolsHandler({ readView: () => undefined });
    const response = await handler({
      operation: "read_star_map_view",
      context: {},
      args: {},
    });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe("star_map_not_open");
    expect(response.error.message).toMatch(/open the Star Map/i);
  });

  it("says when the thread cap dropped members, and keeps cloud counts whole", async () => {
    const handler = createStarMapAgentToolsHandler({
      readView: () => snapshot(),
      now: () => 1_000,
    });
    const response = expectOk(
      (await handler({
        operation: "read_star_map_view",
        context: {},
        args: { maxThreads: 1 },
      })) as PwrAgentStarMapResponse<"read_star_map_view">,
    );
    expect(response.data.snapshot.threads).toHaveLength(1);
    expect(response.data.truncatedThreadCount).toBe(1);
    // The cloud still reports both members: a shortened list must not read
    // as a smaller cloud, or "the others in this cloud" acts on the wrong set.
    expect(response.data.snapshot.clouds[0].threadCount).toBe(2);
    expect(response.data.snapshot.clouds[0].hiddenCount).toBe(1);
  });

  it("keeps drawn cards ahead of folded ones when it truncates", async () => {
    const handler = createStarMapAgentToolsHandler({
      readView: () =>
        snapshot({
          threads: [
            thread({ threadKey: "codex:folded", visible: false }),
            thread({ threadKey: "codex:drawn", visible: true }),
          ],
        }),
      now: () => 1_000,
    });
    const response = expectOk(
      (await handler({
        operation: "read_star_map_view",
        context: {},
        args: { maxThreads: 1 },
      })) as PwrAgentStarMapResponse<"read_star_map_view">,
    );
    expect(response.data.snapshot.threads[0].threadKey).toBe("codex:drawn");
  });

  it("drops folded threads when the caller asks for only what is drawn", async () => {
    const handler = createStarMapAgentToolsHandler({
      readView: () => snapshot(),
      now: () => 1_000,
    });
    const response = expectOk(
      (await handler({
        operation: "read_star_map_view",
        context: {},
        args: { includeHidden: false },
      })) as PwrAgentStarMapResponse<"read_star_map_view">,
    );
    expect(response.data.snapshot.threads.map((entry) => entry.threadKey)).toEqual([
      "codex:a",
    ]);
  });

  it("keeps the whole selection for an instance even when the cap truncates", async () => {
    const handler = createStarMapAgentToolsHandler({
      readView: () =>
        snapshot({
          threads: [
            thread({ threadKey: "codex:a", selected: true }),
            thread({ threadKey: "codex:b", selected: true }),
            thread({
              threadKey: "codex:p",
              instanceId: "peer",
              instanceLabel: "Studio",
              isLocal: false,
              selected: true,
            }),
          ],
          selectedThreadKeys: ["codex:a", "codex:b", "codex:p"],
          openChatCardThreadKeys: ["codex:b", "codex:p"],
        }),
      now: () => 1_000,
    });
    const response = expectOk(
      (await handler({
        operation: "read_star_map_view",
        context: {},
        args: { instanceId: "local", maxThreads: 1 },
      })) as PwrAgentStarMapResponse<"read_star_map_view">,
    );
    // The cap shortens the thread list, never the selection: an Agent asked
    // to act on "the selected cards" must see all of them.
    expect(response.data.snapshot.threads).toHaveLength(1);
    expect(response.data.snapshot.selectedThreadKeys).toEqual([
      "codex:a",
      "codex:b",
    ]);
    expect(response.data.snapshot.openChatCardThreadKeys).toEqual(["codex:b"]);
  });

  it("reports selection and open cards whole when no instance is named", async () => {
    const handler = createStarMapAgentToolsHandler({
      readView: () =>
        snapshot({
          selectedThreadKeys: ["codex:a", "codex:b"],
          openChatCardThreadKeys: ["codex:b"],
        }),
      now: () => 1_000,
    });
    const response = expectOk(
      (await handler({
        operation: "read_star_map_view",
        context: {},
        args: { maxThreads: 1 },
      })) as PwrAgentStarMapResponse<"read_star_map_view">,
    );
    expect(response.data.snapshot.selectedThreadKeys).toEqual([
      "codex:a",
      "codex:b",
    ]);
    expect(response.data.snapshot.openChatCardThreadKeys).toEqual(["codex:b"]);
  });

  it("narrows instances, clouds and threads to one instance", async () => {
    const handler = createStarMapAgentToolsHandler({
      readView: () =>
        snapshot({
          instances: [
            {
              instanceId: "local",
              label: "This instance",
              isLocal: true,
              threadCount: 1,
              visibleThreadCount: 1,
            },
            {
              instanceId: "peer",
              label: "Studio",
              isLocal: false,
              threadCount: 1,
              visibleThreadCount: 1,
            },
          ],
          clouds: [
            {
              key: "pwragent",
              label: "PwrAgent",
              instanceId: "local",
              instanceLabel: "This instance",
              isProject: true,
              isParentGroup: false,
              expanded: false,
              threadCount: 1,
              visibleCount: 1,
              hiddenCount: 0,
              threadKeys: ["codex:a"],
            },
            {
              key: "other",
              label: "Other",
              instanceId: "peer",
              instanceLabel: "Studio",
              isProject: true,
              isParentGroup: false,
              expanded: false,
              threadCount: 1,
              visibleCount: 1,
              hiddenCount: 0,
              threadKeys: ["codex:p"],
            },
          ],
          threads: [
            thread({ threadKey: "codex:a" }),
            thread({
              threadKey: "codex:p",
              instanceId: "peer",
              instanceLabel: "Studio",
              isLocal: false,
            }),
          ],
        }),
      now: () => 1_000,
    });
    const response = expectOk(
      (await handler({
        operation: "read_star_map_view",
        context: {},
        args: { instanceId: "peer" },
      })) as PwrAgentStarMapResponse<"read_star_map_view">,
    );
    expect(response.data.snapshot.instances.map((entry) => entry.instanceId)).toEqual([
      "peer",
    ]);
    expect(response.data.snapshot.clouds.map((entry) => entry.key)).toEqual(["other"]);
    expect(response.data.snapshot.threads.map((entry) => entry.threadKey)).toEqual([
      "codex:p",
    ]);
  });
});

  it("keeps a projects-lens cloud that belongs to no one instance", async () => {
    const handler = createStarMapAgentToolsHandler({
      readView: () =>
        snapshot({
          layout: "projects",
          // A project pools the fleet, so it carries no instanceId. Filtering
          // it out by instance would strand the cloudKey its own members
          // still point at.
          clouds: [
            {
              key: "work",
              label: "work",
              isProject: true,
              isParentGroup: false,
              expanded: false,
              threadCount: 2,
              visibleCount: 2,
              hiddenCount: 0,
              threadKeys: ["codex:a", "codex:b"],
            },
          ],
          threads: [
            thread({ threadKey: "codex:a", cloudKey: "work" }),
            thread({
              threadKey: "codex:b",
              instanceId: "peer-7",
              cloudKey: "work",
            }),
          ],
        }),
    });
    const response = expectOk(
      (await handler({
        operation: "read_star_map_view",
        context: {},
        args: { instanceId: "local" },
      })) as PwrAgentStarMapResponse<"read_star_map_view">,
    );
    expect(response.data.snapshot.clouds).toHaveLength(1);
    // Membership narrows with the filter; the cloud itself survives so the
    // surviving thread's cloudKey still resolves.
    expect(response.data.snapshot.clouds[0].threadKeys).toEqual(["codex:a"]);
    expect(response.data.snapshot.threads[0].cloudKey).toBe("work");
  });

  it("recounts the fleet-wide totals when scoped to one instance", async () => {
    const handler = createStarMapAgentToolsHandler({
      readView: () =>
        snapshot({
          matchedThreadCount: 40,
          hiddenInstanceCount: 3,
          threads: [
            thread({ threadKey: "codex:a" }),
            thread({ threadKey: "codex:b", instanceId: "peer-7" }),
          ],
        }),
    });
    const response = expectOk(
      (await handler({
        operation: "read_star_map_view",
        context: {},
        args: { instanceId: "local" },
      })) as PwrAgentStarMapResponse<"read_star_map_view">,
    );
    // "40 threads match" beside one listed and no truncation notice reads as
    // a stale map; the counts have to answer the question that was asked.
    expect(response.data.snapshot.matchedThreadCount).toBe(1);
    expect(response.data.snapshot.hiddenInstanceCount).toBe(0);
    expect(response.data.snapshot.threads).toHaveLength(1);
  });

  it("caps a cloud's listed members without shrinking its count", async () => {
    const threadKeys = Array.from({ length: 40 }, (_, index) => `codex:t${index}`);
    const handler = createStarMapAgentToolsHandler({
      readView: () =>
        snapshot({
          clouds: [
            {
              key: "big",
              label: "Big",
              instanceId: "local",
              instanceLabel: "This instance",
              isProject: false,
              isParentGroup: false,
              expanded: true,
              threadCount: threadKeys.length,
              visibleCount: threadKeys.length,
              hiddenCount: 0,
              threadKeys,
            },
          ],
          threads: threadKeys.map((threadKey) => thread({ threadKey })),
        }),
    });
    const response = expectOk(
      (await handler({
        operation: "read_star_map_view",
        context: {},
        args: { maxThreads: 5 },
      })) as PwrAgentStarMapResponse<"read_star_map_view">,
    );
    const cloud = response.data.snapshot.clouds[0];
    // The cap bounds the payload; the count stays whole, because a cloud
    // that reports fewer members than it has is how "the others in this
    // cloud" acts on the wrong set.
    expect(cloud.threadKeys).toHaveLength(5);
    expect(cloud.threadCount).toBe(40);
    expect(cloud.omittedThreadKeyCount).toBe(35);
  });

describe("star map tool definitions", () => {
  const context = (
    transport: AgentToolCallContext["transport"],
  ): AgentToolCallContext => ({
    backend: "codex",
    threadId: "thread-1",
    transport,
  });

  function definitionFor(name: string) {
    const definition = buildPwrAgentStarMapToolDefinitions(
      createStarMapAgentToolsHandler({
        readView: () => snapshot(),
        now: () => 1_000,
      }),
    ).find((entry) => entry.name === name);
    if (!definition) throw new Error(`no definition for ${name}`);
    return definition;
  }

  function expectDispatchOk(result: AgentToolDispatchResult) {
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
    return result;
  }

  it("serves the published view through the tool definition", async () => {
    const result = expectDispatchOk(
      await definitionFor("read_star_map_view").dispatch({}, context("mcp")),
    );
    expect(
      (result.data as { snapshot: StarMapViewSnapshot }).snapshot.layout,
    ).toBe("orbit");
  });

  it("rejects out-of-range arguments instead of clamping them", async () => {
    const result = await definitionFor("read_star_map_view").dispatch(
      { maxThreads: 0 },
      context("mcp"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid_arguments");
  });

  it("reports a missing handler rather than pretending the map is closed", async () => {
    const definition = buildPwrAgentStarMapToolDefinitions(undefined).find(
      (entry) => entry.name === "read_star_map_view",
    );
    const result = await definition?.dispatch({}, context("mcp"));
    expect(result?.ok).toBe(false);
    if (!result || result.ok) return;
    expect(result.code).toBe("internal_error");
  });
});
