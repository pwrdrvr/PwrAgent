import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  acpNativeAccessLevel,
  acpNativeAccessMode,
  acpNativeAccessRuntime,
} from "@pwragent/shared/acp-permission-mode";
import type {
  BackendAcpRuntimeCapabilities,
  BackendAcpSessionRuntimeState,
} from "@pwragent/shared/contracts/backend";
import type {
  AcpBackendId,
  ThreadExecutionMode,
} from "@pwragent/shared/contracts/normalized-app-server";
import { AcpAgentClient } from "../acp/acp-client";
import { FakeAcpAgentTransport } from "../acp/testing/fake-acp-agent";
import { acpStartedExecutionMode, applyAcpRuntimeSelection } from "../app-server/acp-runtime-selection";
import { AcpSessionStore } from "../storage/acp-session-store";
import { openInMemoryStateDb } from "./sqlite-test-utils";

// How each agent names its access selector:
// - "legacy": ACP session modes, written with session/set_mode (Kimi, Qwen).
// - "modeOption": a `mode` config option mirroring the session modes,
//   written with session/set_config_option (Antigravity).
// - "permission": Grok's `permission_mode` config option.
type Selector = "legacy" | "modeOption" | "permission";

const BACKEND: Record<Selector, AcpBackendId> = {
  legacy: "acp:qwen",
  modeOption: "acp:antigravity",
  permission: "acp:grok",
};
const REGISTRY_ID: Record<Selector, string> = {
  legacy: "qwen",
  modeOption: "antigravity",
  permission: "grok",
};
const OPTION_ID: Record<Selector, string> = {
  legacy: "mode",
  modeOption: "mode",
  permission: "permission_mode",
};
const MODE_IDS = ["default", "accept-edits", "auto", "plan", "yolo"] as const;
const LEVELS: ThreadExecutionMode[] = ["default", "auto", "full-access"];
const sessionId = "session-1";

function cachedCapabilities(
  selector: Selector,
  ids: readonly string[],
): BackendAcpRuntimeCapabilities {
  const option = {
    id: OPTION_ID[selector],
    label: "Mode",
    type: "select" as const,
    category: "mode",
    values: ids.map((value) => ({ value, label: value })),
  };
  return {
    schemaVersion: 1,
    status: "discovered",
    ...(selector === "permission" ? {} : {
      modes: { availableModes: ids.map((id) => ({ id, label: id })) },
    }),
    ...(selector === "legacy" ? {} : { configOptions: [option] }),
  };
}

// An agent that refuses a mode its session does not list, as agy 1.5.15
// does: `-32602 Unknown mode: <id>` for both session/set_mode and the mode
// config option (apps/desktop/docs/protocol-captures.md).
class ModeMenuTransport extends FakeAcpAgentTransport {
  readonly modeWrites: string[] = [];

  constructor(
    private readonly selector: Selector,
    private readonly offered: readonly string[] | undefined,
    public mode: string | undefined,
  ) {
    super({ initialize: { protocolVersion: 1 } });
  }

  private menu(): Record<string, unknown> {
    if (!this.offered) return {};
    const modes = {
      currentModeId: this.mode,
      availableModes: this.offered.map((id) => ({ id, name: id })),
    };
    const configOptions = [{
      id: OPTION_ID[this.selector],
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: this.mode,
      options: this.offered.map((value) => ({ value, name: value })),
    }];
    return {
      ...(this.selector === "permission" ? {} : { modes }),
      ...(this.selector === "legacy" ? {} : { configOptions }),
    };
  }

  private write(value: string): void {
    this.modeWrites.push(value);
    if (!this.offered?.includes(value)) {
      throw new Error(`ACP request failed (-32602): Unknown mode: ${value}`);
    }
    this.mode = value;
  }

  override async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const result = await super.request(method, params, timeoutMs);
    if (method === "session/new") return { sessionId, ...this.menu() };
    if (method === "session/set_mode") {
      this.write(String(params?.modeId));
      return {};
    }
    if (
      method === "session/set_config_option"
      && params?.configId === OPTION_ID[this.selector]
    ) {
      this.write(String(params.value));
      return this.menu();
    }
    return result;
  }
}

type Scenario = {
  selector: Selector;
  cached: string[];
  /** Undefined: the session's reply carries no mode menu at all. */
  sessionModes: string[] | undefined;
  sessionCurrentIndex: number;
  request:
    | { kind: "level"; level: ThreadExecutionMode }
    | { kind: "id"; index: number };
};

const scenario: fc.Arbitrary<Scenario> = fc.record({
  selector: fc.constantFrom<Selector>("legacy", "modeOption", "permission"),
  cached: fc.uniqueArray(fc.constantFrom(...MODE_IDS), { minLength: 2, maxLength: MODE_IDS.length }),
  sessionModes: fc.option(
    fc.uniqueArray(fc.constantFrom(...MODE_IDS), { minLength: 0, maxLength: MODE_IDS.length }),
    { nil: undefined, freq: 5 },
  ),
  sessionCurrentIndex: fc.nat(),
  request: fc.oneof(
    // A to-do card's inherited access (PR #4301's acpNativeAccessMode).
    fc.record({ kind: fc.constant("level" as const), level: fc.constantFrom(...LEVELS) }),
    // A mode the operator picked from the agent's cached menu.
    fc.record({ kind: fc.constant("id" as const), index: fc.nat() }),
  ),
});

function requestedRuntime(
  capabilities: BackendAcpRuntimeCapabilities,
  scenario: Scenario,
): BackendAcpSessionRuntimeState | undefined {
  if (scenario.request.kind === "level") {
    return acpNativeAccessMode(capabilities, scenario.request.level)?.runtime;
  }
  const id = scenario.cached[scenario.request.index % scenario.cached.length]!;
  return acpNativeAccessRuntime(capabilities, id);
}

function recordedMode(
  selector: Selector,
  runtime: BackendAcpSessionRuntimeState | undefined,
): string | undefined {
  return selector === "permission"
    ? runtime?.configValues?.[OPTION_ID[selector]]
    : runtime?.currentModeId;
}

async function startSession(scenario: Scenario) {
  const { selector, sessionModes } = scenario;
  const capabilities = cachedCapabilities(selector, scenario.cached);
  const runtime = requestedRuntime(capabilities, scenario);
  const requested = recordedMode(selector, runtime);
  const sessionCurrent = sessionModes?.length
    ? sessionModes[scenario.sessionCurrentIndex % sessionModes.length]
    : undefined;
  const transport = new ModeMenuTransport(selector, sessionModes, sessionCurrent);
  const stateDb = openInMemoryStateDb();
  const store = new AcpSessionStore(stateDb);
  const client = new AcpAgentClient({ backendId: BACKEND[selector], store, transport });
  try {
    await client.initialize();
    // As BackendRegistry.startAcpSession does.
    await client.startSession({ cwd: "/repo", executionMode: "default", acpRuntime: runtime });
    let error: unknown;
    try {
      await applyAcpRuntimeSelection({ capabilities, client, sessionId, runtime });
    } catch (caught) {
      error = caught;
    }
    const recorded = store.getSession(BACKEND[selector], sessionId)?.acpRuntime;
    // A native mode below Full Access records the thread at Default Access,
    // as resolveThreadTodoStartAccess does for the mode it asks for.
    const requestedExecutionMode: ThreadExecutionMode =
      requested !== undefined && acpNativeAccessLevel(requested) === "full-access"
        ? "full-access"
        : "default";
    return {
      error,
      requested,
      requestedExecutionMode,
      transport,
      recorded,
      // As BackendRegistry.startAcpSession records it.
      executionMode: acpStartedExecutionMode({
        executionMode: requestedExecutionMode,
        registryId: REGISTRY_ID[selector],
        runtime: recorded,
        runtimeCapabilities: capabilities,
      }),
    };
  } finally {
    await client.dispose();
    stateDb.close();
  }
}

const rank = (id: string) => LEVELS.indexOf(acpNativeAccessLevel(id)!);

describe("ACP session start mode selection", () => {
  it("never fails on a mode the session does not list, never raises access, and records the session's real mode", async () => {
    await fc.assert(fc.asyncProperty(scenario, async (input) => {
      const { error, requested, transport, recorded } = await startSession(input);
      expect(error).toBeUndefined();
      for (const written of transport.modeWrites) {
        // Only a mode the session's own reply listed is written.
        expect(input.sessionModes ?? []).toContain(written);
        if (requested !== undefined && acpNativeAccessLevel(requested)) {
          // A fallback never goes above the requested access level, and
          // never to a mode without one, such as Plan.
          expect(acpNativeAccessLevel(written)).toBeDefined();
          expect(rank(written)).toBeLessThanOrEqual(rank(requested));
        } else {
          expect(written).toBe(requested);
        }
      }
      // The thread shows the mode the session is actually in.
      expect(recordedMode(input.selector, recorded)).toBe(transport.mode);
      if (input.selector === "modeOption") {
        expect(recorded?.configValues?.mode).toBe(transport.mode);
      }
    }));
  });

  it("records Full Access only while the session holds the native Yolo it was asked for", async () => {
    await fc.assert(fc.asyncProperty(scenario, async (input) => {
      const { requestedExecutionMode, transport, executionMode } = await startSession(input);
      const expected =
        // Antigravity's Full Access is the process it runs in, not a mode.
        input.selector === "modeOption"
        // A session without a native selector leaves access to PwrAgent.
        || transport.mode === undefined
        || transport.mode === "yolo"
          ? requestedExecutionMode
          : "default";
      expect(executionMode).toBe(expected);
    }));
  });

  it("records Default Access when a Grok Yolo start falls back to Auto", async () => {
    const result = await startSession({
      selector: "permission",
      cached: ["default", "auto", "yolo"],
      sessionModes: ["default", "auto"],
      sessionCurrentIndex: 0,
      request: { kind: "level", level: "full-access" },
    });
    expect(result.requestedExecutionMode).toBe("full-access");
    expect(result.recorded?.configValues?.permission_mode).toBe("auto");
    expect(result.executionMode).toBe("default");
  });

  it("falls back from Auto to Default for an Antigravity session without native Auto", async () => {
    const result = await startSession({
      selector: "modeOption",
      cached: ["default", "accept-edits", "auto", "plan"],
      sessionModes: ["default", "accept-edits", "plan"],
      sessionCurrentIndex: 0,
      request: { kind: "level", level: "auto" },
    });
    expect(result.error).toBeUndefined();
    expect(result.requested).toBe("auto");
    expect(result.transport.modeWrites).toEqual(["default"]);
    expect(result.recorded?.currentModeId).toBe("default");
    expect(result.recorded?.configValues?.mode).toBe("default");
  });

  it("lowers Grok's Yolo to the highest offered permission below it", async () => {
    const result = await startSession({
      selector: "permission",
      cached: ["default", "auto", "yolo"],
      sessionModes: ["default", "auto"],
      sessionCurrentIndex: 0,
      request: { kind: "level", level: "full-access" },
    });
    expect(result.error).toBeUndefined();
    expect(result.transport.modeWrites).toEqual(["auto"]);
    expect(result.recorded?.configValues?.permission_mode).toBe("auto");
  });

  it("keeps the session's own mode when a picked mode without a level is missing", async () => {
    const result = await startSession({
      selector: "legacy",
      cached: ["default", "plan"],
      sessionModes: ["default", "auto"],
      sessionCurrentIndex: 1,
      request: { kind: "id", index: 1 },
    });
    expect(result.error).toBeUndefined();
    expect(result.transport.modeWrites).toEqual([]);
    expect(result.recorded?.currentModeId).toBe("auto");
  });
});
