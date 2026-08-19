// The two Star Map Agent tools: what an Agent turn is told about the map
// the operator is looking at, and what it is told when there is no map.
//
// The assertions worth keeping are the honesty ones. A truncated thread
// list has to say it truncated, a cloud's counts must not shrink just
// because the list did, and a capture over a text-only transport must not
// report an image the model never received.
import { describe, expect, it, vi } from "vitest";
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

function expectOk<TOperation extends "read_star_map_view" | "capture_star_map">(
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

describe("capture_star_map", () => {
  it("returns the PNG alongside its measurements", async () => {
    const handler = createStarMapAgentToolsHandler({
      readView: () => snapshot(),
      capture: async () => ({
        surface: "window" as const,
        png: Buffer.from("fake-png"),
        width: 1_600,
        height: 900,
      }),
    });
    const response = expectOk(
      (await handler({
        operation: "capture_star_map",
        context: {},
        args: {},
      })) as PwrAgentStarMapResponse<"capture_star_map">,
    );
    expect(response.data.width).toBe(1_600);
    expect(response.data.byteLength).toBe(8);
    expect(response.imageBase64).toBe(Buffer.from("fake-png").toString("base64"));
  });

  it("passes the caller's downscale through to the capture", async () => {
    const capture = vi.fn(async () => ({
      surface: "window" as const,
      png: Buffer.from("x"),
      width: 640,
      height: 400,
    }));
    const handler = createStarMapAgentToolsHandler({
      readView: () => snapshot(),
      capture,
    });
    await handler({
      operation: "capture_star_map",
      context: {},
      args: { maxWidth: 640 },
    });
    expect(capture).toHaveBeenCalledWith({ maxWidth: 640 });
  });

  it("fails rather than returning an empty image when the surface has gone", async () => {
    const handler = createStarMapAgentToolsHandler({
      readView: () => snapshot(),
      capture: async () => undefined,
    });
    const response = await handler({
      operation: "capture_star_map",
      context: {},
      args: {},
    });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.code).toBe("capture_failed");
  });
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
        capture: async () => ({
          surface: "window" as const,
          png: Buffer.from("fake-png"),
          width: 100,
          height: 100,
        }),
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

  it("carries the capture as an image item over MCP", async () => {
    const result = expectDispatchOk(
      await definitionFor("capture_star_map").dispatch({}, context("mcp")),
    );
    expect(result.mcpContentItems).toEqual([
      {
        type: "image",
        data: Buffer.from("fake-png").toString("base64"),
        mimeType: "image/png",
      },
    ]);
  });

  it("says the image did not come through on a text-only transport", async () => {
    const result = expectDispatchOk(
      await definitionFor("capture_star_map").dispatch(
        {},
        context("codex_dynamic_tool"),
      ),
    );
    // Silently returning measurements with no image would leave the model
    // believing it had seen the map.
    expect(result.mcpContentItems).toBeUndefined();
    expect(
      (result.data as { imageUnavailableReason?: string }).imageUnavailableReason,
    ).toMatch(/text only/i);
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
