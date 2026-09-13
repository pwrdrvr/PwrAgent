import { describe, expect, it, vi } from "vitest";
import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared";
import type { PwrAgentFederationRequest } from "@pwragent/shared";
import type { PwrAgentFederationHandler } from "../agent-tools/pwragent-federation-agent-tools";
import {
  ASK_OPERATOR_TO_PICK_PROJECT_TOOL,
  buildStarMapIntakeAgentTools,
  STAR_MAP_INTAKE_AGENT_SYSTEM,
} from "../app-server/star-map-intake-agent";

const DIRECTORIES = new Set(["dir-agent", "dir-snap"]);

function build(
  options: {
    federationHandler?: PwrAgentFederationHandler;
    onCreateStarting?: (projectKey: string) => void;
  } = {},
) {
  return buildStarMapIntakeAgentTools({
    federationHandler:
      options.federationHandler
      ?? (async () => ({
        ok: true,
        data: {
          instanceId: "inst-local",
          instanceLabel: "This Mac",
          isLocal: true,
          backend: "codex",
          threadId: "thread-new",
          executionMode: "default",
          workMode: "local",
          groupingMode: "none",
          message: "created",
        },
      })),
    resolveDirectoryKey: (projectKey) =>
      DIRECTORIES.has(projectKey) ? projectKey : undefined,
    ...(options.onCreateStarting
      ? { onCreateStarting: options.onCreateStarting }
      : {}),
  });
}

let callSeq = 0;
function call(tool: string, args: Record<string, unknown>) {
  callSeq += 1;
  return {
    method: "item/tool/call",
    params: {
      threadId: "helper-thread",
      turnId: "helper-turn",
      callId: `call-${callSeq}`,
      namespace: PWRAGENT_TOOL_NAMESPACE,
      tool,
      arguments: args,
    },
  };
}

/** The arguments a well-behaved intake agent sends for the reported case. */
const DONUT_CREATE = {
  instanceId: "inst-local",
  projectKey: "dir-agent",
  input: "Make the donuts.",
};

function toolNames(dynamicTools: ReturnType<typeof build>["dynamicTools"]) {
  return dynamicTools.flatMap((spec) =>
    spec.type === "namespace" ? spec.tools.map((tool) => tool.name) : [spec.name],
  );
}

describe("star map intake agent tool surface", () => {
  it("advertises only the tools an intake needs to create one thread", () => {
    expect(toolNames(build().dynamicTools).sort()).toEqual([
      ASK_OPERATOR_TO_PICK_PROJECT_TOOL,
      "create_instance_thread",
      "list_federation_instances",
      "list_instance_projects",
    ]);
  });

  /**
   * The bound that keeps a misfire's blast radius equal to the classifier's.
   * Named individually rather than asserted as a set complement: these are the
   * tools that would let a confused intake damage work the operator never
   * mentioned, and a future catalog addition should have to be thought about
   * rather than silently inherited.
   */
  it.each([
    "steer_thread",
    "stop_thread",
    "send_message_to_thread",
    "start_review",
    "move_thread_workspace",
    "detach_thread_directory",
    "handoff_task",
    "attach_thread_directory",
    "search_federation_threads",
    "create_monitor_delegation",
  ])("withholds %s", (tool) => {
    expect(toolNames(build().dynamicTools)).not.toContain(tool);
  });

  it("refuses a withheld tool at dispatch, not only in the advertisement", async () => {
    const tools = build();
    const response = await tools.handleToolCall(
      call("steer_thread", { threadId: "someone-elses-thread" }),
    );
    expect(response.success).toBe(false);
    expect(tools.readOutcome()).toBeUndefined();
  });

  it("captures the created thread as the intake's outcome", async () => {
    const tools = build();
    const response = await tools.handleToolCall(
      call("create_instance_thread", DONUT_CREATE),
    );

    expect(response.success).toBe(true);
    expect(tools.readOutcome()).toEqual({
      kind: "created",
      backend: "codex",
      threadId: "thread-new",
    });
  });

  /**
   * The reported case, at the seam this change actually owns: whatever the
   * agent passes as `input` is what the created thread's first turn receives.
   * The operator's sentence ("Make a thread in the PwrAgnt project and ask it
   * to make the donuts") never reaches the new thread — that relay is the bug
   * this replaced. Whether the model separates the two correctly is carried by
   * the system prompt, asserted below, not by this test.
   */
  it("passes the agent's extracted payload through to the creation, not the operator's sentence", async () => {
    const federationHandler = vi.fn(async (_request: PwrAgentFederationRequest) => ({
      ok: true as const,
      data: {
        instanceId: "inst-local",
        instanceLabel: "This Mac",
        isLocal: true,
        backend: "codex" as const,
        threadId: "thread-new",
        executionMode: "default" as const,
        workMode: "local" as const,
        groupingMode: "none" as const,
        message: "created",
      },
    }));
    const tools = build({ federationHandler });

    await tools.handleToolCall(call("create_instance_thread", DONUT_CREATE));

    const request = federationHandler.mock
      .calls[0]?.[0] as PwrAgentFederationRequest<"create_instance_thread">;
    expect(request.args.input).toBe("Make the donuts.");
    expect(request.args.projectKey).toBe("dir-agent");
  });

  it("names the project before the thread exists, so the dialog can still be caught", async () => {
    const onCreateStarting = vi.fn();
    const tools = build({ onCreateStarting });

    await tools.handleToolCall(call("create_instance_thread", DONUT_CREATE));

    expect(onCreateStarting).toHaveBeenCalledWith("dir-agent");
  });

  /**
   * The misfire case. A tool-using agent can loop where the classifier could
   * not, so the second creation is refused rather than left to the model's
   * judgment, and the first outcome is the one that stands.
   */
  it("creates at most one thread per intake", async () => {
    const federationHandler = vi.fn(async (_request: PwrAgentFederationRequest) => ({
      ok: true as const,
      data: {
        instanceId: "inst-local",
        instanceLabel: "This Mac",
        isLocal: true,
        backend: "codex" as const,
        threadId: "thread-new",
        executionMode: "default" as const,
        workMode: "local" as const,
        groupingMode: "none" as const,
        message: "created",
      },
    }));
    const tools = build({ federationHandler });

    const first = await tools.handleToolCall(
      call("create_instance_thread", DONUT_CREATE),
    );
    const second = await tools.handleToolCall(
      call("create_instance_thread", {
        ...DONUT_CREATE,
        projectKey: "dir-snap",
        input: "And again.",
      }),
    );

    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
    // The refusal is upstream of the handler: no second thread was started.
    expect(federationHandler).toHaveBeenCalledTimes(1);
    expect(tools.readOutcome()).toMatchObject({ threadId: "thread-new" });
  });

  /**
   * `outcome` alone cannot hold the cap: it is assigned only after the
   * creation resolves, so two calls arriving in the same step would both read
   * it as unset. Codex dispatches inbound tool calls concurrently.
   */
  it("refuses a second creation that arrives while the first is still running", async () => {
    let releaseFirst: () => void = () => {};
    const federationHandler = vi.fn(async (_request: PwrAgentFederationRequest) => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return {
        ok: true as const,
        data: {
          instanceId: "inst-local",
          instanceLabel: "This Mac",
          isLocal: true,
          backend: "codex" as const,
          threadId: "thread-new",
          executionMode: "default" as const,
          workMode: "local" as const,
          groupingMode: "none" as const,
          message: "created",
        },
      };
    });
    const tools = build({ federationHandler });

    const first = tools.handleToolCall(call("create_instance_thread", DONUT_CREATE));
    // Second call lands before the first has resolved, so `outcome` is unset.
    const second = await tools.handleToolCall(
      call("create_instance_thread", { ...DONUT_CREATE, input: "And again." }),
    );

    expect(second.success).toBe(false);
    expect(federationHandler).toHaveBeenCalledTimes(1);

    releaseFirst();
    expect((await first).success).toBe(true);
    expect(tools.readOutcome()).toMatchObject({ threadId: "thread-new" });
  });

  it("reports a creation that has not answered yet as in flight", async () => {
    let releaseFirst: () => void = () => {};
    const federationHandler = vi.fn(async (_request: PwrAgentFederationRequest) => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return {
        ok: true as const,
        data: {
          instanceId: "inst-local",
          instanceLabel: "This Mac",
          isLocal: true,
          backend: "codex" as const,
          threadId: "thread-new",
          executionMode: "default" as const,
          workMode: "local" as const,
          groupingMode: "none" as const,
          message: "created",
        },
      };
    });
    const tools = build({ federationHandler });

    expect(tools.isCreationInFlight()).toBe(false);
    const pending = tools.handleToolCall(
      call("create_instance_thread", DONUT_CREATE),
    );
    expect(tools.isCreationInFlight()).toBe(true);

    releaseFirst();
    await pending;
    expect(tools.isCreationInFlight()).toBe(false);
  });

  /**
   * A `not_found` on one project is not the end of the intake — the model may
   * legitimately try another. Only a creation that succeeded is final.
   */
  it("lets the agent retry after a creation fails", async () => {
    const federationHandler = vi.fn(async (request: PwrAgentFederationRequest) => {
      const args = request.args as { projectKey?: string };
      return args.projectKey === "dir-agent"
        ? {
            ok: false as const,
            error: { code: "not_found" as const, message: "gone" },
          }
        : {
            ok: true as const,
            data: {
              instanceId: "inst-local",
              instanceLabel: "This Mac",
              isLocal: true,
              backend: "codex" as const,
              threadId: "thread-second",
              executionMode: "default" as const,
              workMode: "local" as const,
              groupingMode: "none" as const,
              message: "created",
            },
          };
    });
    const tools = build({ federationHandler });

    const failed = await tools.handleToolCall(
      call("create_instance_thread", DONUT_CREATE),
    );
    const retried = await tools.handleToolCall(
      call("create_instance_thread", { ...DONUT_CREATE, projectKey: "dir-snap" }),
    );

    expect(failed.success).toBe(false);
    expect(retried.success).toBe(true);
    expect(tools.readOutcome()).toMatchObject({ threadId: "thread-second" });
  });

  /**
   * The `creating` line is where the dialog prints a project name, and it is
   * the operator's last chance to catch a wrong pick. A key this instance
   * does not have would put a raw directory key there instead.
   */
  it("does not announce a project key this instance does not have", async () => {
    const onCreateStarting = vi.fn();
    const tools = build({ onCreateStarting });

    await tools.handleToolCall(
      call("create_instance_thread", {
        ...DONUT_CREATE,
        projectKey: "dir-on-some-peer",
      }),
    );

    expect(onCreateStarting).not.toHaveBeenCalled();
  });

  it("does not let a creation follow an ask", async () => {
    const federationHandler = vi.fn();
    const tools = build({
      federationHandler: federationHandler as unknown as PwrAgentFederationHandler,
    });

    await tools.handleToolCall(
      call(ASK_OPERATOR_TO_PICK_PROJECT_TOOL, {
        candidates: [{ projectKey: "dir-agent", reason: "recent icon work" }],
      }),
    );
    const created = await tools.handleToolCall(
      call("create_instance_thread", DONUT_CREATE),
    );

    expect(created.success).toBe(false);
    expect(federationHandler).not.toHaveBeenCalled();
  });
});

describe("ask_operator_to_pick_project", () => {
  it("carries the ranking and the extracted payload out of the turn", async () => {
    const tools = build();

    const response = await tools.handleToolCall(
      call(ASK_OPERATOR_TO_PICK_PROJECT_TOOL, {
        candidates: [
          { projectKey: "dir-agent", reason: "recent icon work" },
          { projectKey: "dir-snap", reason: "owns the screenshot pipeline" },
        ],
        input: "Make the donuts.",
      }),
    );

    expect(response.success).toBe(true);
    expect(tools.readOutcome()).toEqual({
      kind: "needs_disambiguation",
      candidates: [
        { directoryKey: "dir-agent", reason: "recent icon work" },
        { directoryKey: "dir-snap", reason: "owns the screenshot pipeline" },
      ],
      input: "Make the donuts.",
    });
  });

  /**
   * The dialog answers an ask with a directoryKey the next dispatch looks up
   * in this instance's own directory index, so a key naming a peer's project
   * would be offered and then fail on the pick.
   */
  it("drops candidates that are not projects on this instance", async () => {
    const tools = build();

    await tools.handleToolCall(
      call(ASK_OPERATOR_TO_PICK_PROJECT_TOOL, {
        candidates: [
          { projectKey: "dir-on-some-peer", reason: "sounds right" },
          { projectKey: "dir-snap", reason: "owns the screenshot pipeline" },
        ],
      }),
    );

    expect(tools.readOutcome()).toMatchObject({
      candidates: [{ directoryKey: "dir-snap" }],
    });
  });

  it("keeps the ask even when nothing it named resolves", async () => {
    const tools = build();

    await tools.handleToolCall(
      call(ASK_OPERATOR_TO_PICK_PROJECT_TOOL, { candidates: [] }),
    );

    expect(tools.readOutcome()).toEqual({
      kind: "needs_disambiguation",
      candidates: [],
    });
  });

  it("deduplicates a repeated project", async () => {
    const tools = build();

    await tools.handleToolCall(
      call(ASK_OPERATOR_TO_PICK_PROJECT_TOOL, {
        candidates: [
          { projectKey: "dir-agent", reason: "first" },
          { projectKey: "dir-agent", reason: "again" },
        ],
      }),
    );

    expect(tools.readOutcome()).toMatchObject({
      candidates: [{ directoryKey: "dir-agent", reason: "first" }],
    });
  });

  it("cuts a long reason at a character boundary", async () => {
    const tools = build();

    await tools.handleToolCall(
      call(ASK_OPERATOR_TO_PICK_PROJECT_TOOL, {
        candidates: [{ projectKey: "dir-agent", reason: "🍩".repeat(200) }],
      }),
    );

    const outcome = tools.readOutcome();
    const reason =
      outcome?.kind === "needs_disambiguation"
        ? outcome.candidates[0]?.reason ?? ""
        : "";
    expect([...reason]).toHaveLength(120);
    // A surrogate half here would render as a replacement character in the row.
    expect(reason.codePointAt(reason.length - 2)).toBe("🍩".codePointAt(0));
  });
});

/**
 * The intake's judgment lives in this prompt, so these assert the two cases
 * the change exists to separate are actually stated in it. Nothing here can
 * prove the model obeys — only that the instruction it needs is present and
 * did not get edited away.
 */
describe("star map intake agent system prompt", () => {
  it("tells the agent the request is addressed to it", () => {
    expect(STAR_MAP_INTAKE_AGENT_SYSTEM).toContain("addressed to you");
  });

  it("carries the relay case it exists to prevent", () => {
    expect(STAR_MAP_INTAKE_AGENT_SYSTEM).toContain(
      "will create another",
    );
  });

  it("carries the negative control: a request that merely mentions threads", () => {
    expect(STAR_MAP_INTAKE_AGENT_SYSTEM).toContain(
      "merely mentions threads is not addressed to you",
    );
    expect(STAR_MAP_INTAKE_AGENT_SYSTEM).toContain("pass it\nthrough verbatim");
  });

  it("names the ask tool it must use instead of guessing", () => {
    expect(STAR_MAP_INTAKE_AGENT_SYSTEM).toContain(
      ASK_OPERATOR_TO_PICK_PROJECT_TOOL,
    );
  });

  it("tells the agent to page the project list rather than read one page", () => {
    expect(STAR_MAP_INTAKE_AGENT_SYSTEM).toContain("Page the project list");
  });
});
