import { describe, expect, it, vi } from "vitest";
import type { AcpBackendId } from "@pwragent/shared";
import type { AcpJsonRpcTransport } from "../acp/acp-client";
import {
  discoverAcpRuntimeCapabilities,
  type AcpRuntimeDiscoveryResult,
} from "../acp/acp-runtime-discovery";
import type { AcpInstalledAgentRecord } from "../acp/acp-registry-types";

describe("discoverAcpRuntimeCapabilities", () => {
  it("discovers dynamic per-model thinking levels and restores the original model", async () => {
    let selectedModel = "kimi-code/kimi-for-coding";
    const request = vi.fn(
      async (
        method: string,
        params?: Record<string, unknown>,
      ): Promise<unknown> => {
        if (method === "initialize") {
          return {
            protocolVersion: 1,
            agentInfo: {
              name: "Kimi Code CLI",
              version: "0.29.2",
            },
          };
        }
        if (method === "session/new") {
          return {
            sessionId: "kimi-session",
            configOptions: buildKimiConfigOptions(selectedModel),
          };
        }
        if (method === "session/set_config_option") {
          if (params?.configId === "model") {
            selectedModel = String(params.value);
          }
          return {
            configOptions: buildKimiConfigOptions(selectedModel),
          };
        }
        return {};
      },
    );
    const close = vi.fn(async () => undefined);
    const transport: AcpJsonRpcTransport = {
      request,
      close,
      onNotification: () => () => undefined,
    };

    const result = await discoverAcpRuntimeCapabilities(
      buildKimiAgent(),
      {
        cwd: "/repo",
        now: () => 1000,
        transportFactory: () => transport,
      },
    );

    expect(result.runtimeCapabilities?.models).toEqual({
      currentModelId: "kimi-code/kimi-for-coding",
      availableModels: [
        {
          id: "kimi-code/kimi-for-coding",
          label: "K2.7 Coding",
          current: true,
          supportsReasoning: false,
        },
        {
          id: "kimi-code/k3",
          label: "K3",
          current: false,
          supportsReasoning: true,
          reasoningEfforts: ["low", "high", "max"],
          defaultReasoningEffort: "high",
        },
        {
          id: "kimi-code/k3-256k",
          label: "K3-256k",
          current: false,
          supportsReasoning: true,
          reasoningEfforts: ["low", "high", "max"],
          defaultReasoningEffort: "high",
        },
      ],
    });
    expect(
      request.mock.calls
        .filter(([method]) => method === "session/set_config_option")
        .map(([, params]) => params),
    ).toEqual([
      {
        sessionId: "kimi-session",
        configId: "model",
        value: "kimi-code/k3",
      },
      {
        sessionId: "kimi-session",
        configId: "thinking",
        value: "high",
      },
      {
        sessionId: "kimi-session",
        configId: "model",
        value: "kimi-code/k3-256k",
      },
      {
        sessionId: "kimi-session",
        configId: "thinking",
        value: "high",
      },
      {
        sessionId: "kimi-session",
        configId: "model",
        value: "kimi-code/kimi-for-coding",
      },
    ]);
    expect(selectedModel).toBe("kimi-code/kimi-for-coding");
    expect(close).toHaveBeenCalledOnce();
  });

  it("terminates a hung agent on abort and reports the step it hung on", async () => {
    let failPending: ((error: Error) => void) | undefined;
    const request = vi.fn(async (method: string): Promise<unknown> => {
      if (method === "initialize") {
        return { protocolVersion: 1 };
      }
      // session/new never answers, as with an agent waiting on a login.
      return await new Promise((_resolve, reject) => {
        failPending = reject;
      });
    });
    const close = vi.fn(async () => {
      failPending?.(new Error("json-rpc transport closed"));
    });
    const transport: AcpJsonRpcTransport = {
      request,
      close,
      onNotification: () => () => undefined,
    };
    const controller = new AbortController();
    const stages: string[] = [];

    const discovery = discoverAcpRuntimeCapabilities(buildKimiAgent(), {
      cwd: "/repo",
      onStage: (stage) => stages.push(stage),
      signal: controller.signal,
      transportFactory: () => transport,
    });
    await vi.waitFor(() => {
      expect(request.mock.calls.map(([method]) => method)).toContain(
        "session/new",
      );
    });
    controller.abort();

    await expect(discovery).rejects.toMatchObject({ name: "AbortError" });
    expect(close).toHaveBeenCalled();
    expect(stages).toEqual(["Starting the CLI", "Opening a session"]);
  });

  it("does not launch an agent for a discovery aborted before it starts", async () => {
    const transportFactory = vi.fn();
    const controller = new AbortController();
    controller.abort();

    await expect(
      discoverAcpRuntimeCapabilities(buildKimiAgent(), {
        cwd: "/repo",
        signal: controller.signal,
        transportFactory,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(transportFactory).not.toHaveBeenCalled();
  });

  it("keeps an advertised context window when rebuilding models from config options", async () => {
    // Grok Build advertises both a model list (carrying each window) and
    // model + thought_level config options, which the probe rebuilds from.
    const models = {
      currentModelId: "kimi-code/kimi-for-coding",
      availableModels: [
        {
          modelId: "kimi-code/kimi-for-coding",
          name: "K2.7 Coding",
          _meta: { totalContextTokens: 262144 },
        },
        {
          modelId: "kimi-code/k3",
          name: "K3",
          _meta: { totalContextTokens: 500000 },
        },
      ],
    };
    const transport: AcpJsonRpcTransport = {
      request: vi.fn(async (method: string): Promise<unknown> => {
        if (method === "initialize") {
          return { protocolVersion: 1 };
        }
        if (method === "session/new") {
          return {
            sessionId: "session-1",
            models,
            configOptions: buildKimiConfigOptions("kimi-code/kimi-for-coding"),
          };
        }
        return {};
      }),
      close: vi.fn(async () => undefined),
      onNotification: () => () => undefined,
    };

    const result = await discoverAcpRuntimeCapabilities(buildKimiAgent(), {
      cwd: "/repo",
      now: () => 1000,
      transportFactory: () => transport,
    });

    expect(
      result.runtimeCapabilities?.models?.availableModels.map((model) => [
        model.id,
        model.contextWindow,
      ]),
    ).toEqual([
      ["kimi-code/kimi-for-coding", 262144],
      ["kimi-code/k3", 500000],
      ["kimi-code/k3-256k", undefined],
    ]);
  });

  it("does not catalogue the level a model switch carries in from the default model", async () => {
    const kimi = createKimiCode2Transport("kimi-code/kimi-for-coding");

    const result = await discoverAcpRuntimeCapabilities(
      buildKimiAgent(),
      {
        cwd: "/repo",
        now: () => 1000,
        transportFactory: () => kimi.transport,
      },
    );

    expect(result.runtimeCapabilities?.models).toEqual({
      currentModelId: "kimi-code/kimi-for-coding",
      availableModels: [
        {
          id: "kimi-code/kimi-for-coding",
          label: "K2.7 Coding",
          current: true,
          supportsReasoning: false,
        },
        {
          id: "kimi-code/kimi-for-coding-highspeed",
          label: "K2.7 Coding Highspeed",
          current: false,
          supportsReasoning: false,
        },
        {
          id: "kimi-code/k3",
          label: "K3",
          current: false,
          supportsReasoning: true,
          reasoningEfforts: ["low", "high", "max"],
          defaultReasoningEffort: "high",
        },
        {
          id: "kimi-code/k3-256k",
          label: "K3-256k",
          current: false,
          supportsReasoning: true,
          reasoningEfforts: ["low", "high", "max"],
          defaultReasoningEffort: "high",
        },
      ],
    });
    expect(readThoughtLevelOption(result)).toEqual({
      currentValue: "on",
      values: ["on"],
    });
    expect(kimi.state).toEqual({
      model: "kimi-code/kimi-for-coding",
      thinking: "on",
    });
    expect(kimi.writes).toEqual([
      "model=kimi-code/kimi-for-coding-highspeed",
      "model=kimi-code/k3",
      "thinking=on",
      "model=kimi-code/k3-256k",
      "thinking=high",
      "model=kimi-code/kimi-for-coding",
      "thinking=on",
    ]);
  });

  it("does not give K2.7 the level a K3 default session carries into it", async () => {
    const kimi = createKimiCode2Transport("kimi-code/k3");

    const result = await discoverAcpRuntimeCapabilities(
      buildKimiAgent(),
      {
        cwd: "/repo",
        now: () => 1000,
        transportFactory: () => kimi.transport,
      },
    );

    expect(result.runtimeCapabilities?.models).toEqual({
      currentModelId: "kimi-code/k3",
      availableModels: [
        {
          id: "kimi-code/kimi-for-coding",
          label: "K2.7 Coding",
          current: false,
          supportsReasoning: false,
        },
        {
          id: "kimi-code/kimi-for-coding-highspeed",
          label: "K2.7 Coding Highspeed",
          current: false,
          supportsReasoning: false,
        },
        {
          id: "kimi-code/k3",
          label: "K3",
          current: true,
          supportsReasoning: true,
          reasoningEfforts: ["low", "high", "max"],
          defaultReasoningEffort: "high",
        },
        {
          id: "kimi-code/k3-256k",
          label: "K3-256k",
          current: false,
          supportsReasoning: true,
          reasoningEfforts: ["low", "high", "max"],
          defaultReasoningEffort: "high",
        },
      ],
    });
    expect(readThoughtLevelOption(result)).toEqual({
      currentValue: "high",
      values: ["low", "high", "max"],
    });
    expect(kimi.state).toEqual({
      model: "kimi-code/k3",
      thinking: "high",
    });
    expect(kimi.writes).toEqual([
      "model=kimi-code/kimi-for-coding",
      "thinking=high refused",
      "model=kimi-code/kimi-for-coding-highspeed",
      "thinking=high refused",
      "model=kimi-code/k3",
      "thinking=high",
      "model=kimi-code/k3-256k",
      "thinking=high",
      "model=kimi-code/k3",
    ]);
  });
});

// Kimi Code 2.0.0 (`~/.kimi-code/bin/kimi acp`) as measured with zero-token
// probes. The model decides which thought levels exist. A model switch keeps
// the session's level, and the new model's menu lists that level after its
// own even when the model does not offer it. K2.7 refuses a level it does not
// offer, and K3 replaces one with its default. Every successful write is
// announced with a `config_option_update` before the reply. A fresh session
// starts at `default_model` from Kimi's config.toml.
const KIMI_CODE_2_MODELS = [
  {
    value: "kimi-code/kimi-for-coding",
    name: "K2.7 Coding",
    thinking: ["on"],
    defaultThinking: "on",
    refusesUnofferedThinking: true,
  },
  {
    value: "kimi-code/kimi-for-coding-highspeed",
    name: "K2.7 Coding Highspeed",
    thinking: ["on"],
    defaultThinking: "on",
    refusesUnofferedThinking: true,
  },
  {
    value: "kimi-code/k3",
    name: "K3",
    thinking: ["low", "high", "max"],
    defaultThinking: "high",
    refusesUnofferedThinking: false,
  },
  {
    value: "kimi-code/k3-256k",
    name: "K3-256k",
    thinking: ["low", "high", "max"],
    defaultThinking: "high",
    refusesUnofferedThinking: false,
  },
];

const KIMI_CODE_2_THINKING_LABELS: Record<string, string> = {
  on: "Thinking On",
  low: "Thinking Low",
  high: "Thinking High",
  max: "Thinking Max",
};

function createKimiCode2Transport(defaultModel: string) {
  const state = {
    model: defaultModel,
    thinking: findKimiCode2Model(defaultModel).defaultThinking,
  };
  const writes: string[] = [];
  const listeners = new Set<
    (method: string, params: Record<string, unknown>) => void
  >();
  const request = vi.fn(
    async (
      method: string,
      params?: Record<string, unknown>,
    ): Promise<unknown> => {
      if (method === "initialize") {
        return {
          protocolVersion: 1,
          agentInfo: {
            name: "Kimi Code CLI",
            version: "2.0.0",
          },
        };
      }
      if (method === "session/new") {
        return {
          sessionId: "kimi-session",
          configOptions: buildKimiCode2ConfigOptions(state),
        };
      }
      if (method === "session/set_config_option") {
        const value = String(params?.value);
        const write = `${String(params?.configId)}=${value}`;
        if (params?.configId === "model") {
          state.model = value;
        } else if (params?.configId === "thinking") {
          const model = findKimiCode2Model(state.model);
          if (model.thinking.includes(value)) {
            state.thinking = value;
          } else if (model.refusesUnofferedThinking) {
            writes.push(`${write} refused`);
            throw new Error(
              `Invalid params: Unknown thinking value: ${value}`,
            );
          } else {
            state.thinking = model.defaultThinking;
          }
        }
        writes.push(write);
        const configOptions = buildKimiCode2ConfigOptions(state);
        for (const listener of listeners) {
          listener("session/update", {
            sessionId: "kimi-session",
            update: {
              sessionUpdate: "config_option_update",
              configOptions,
            },
          });
        }
        return { configOptions };
      }
      return {};
    },
  );
  const transport: AcpJsonRpcTransport = {
    request,
    close: async () => undefined,
    onNotification: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { state, transport, writes };
}

function findKimiCode2Model(value: string) {
  const model = KIMI_CODE_2_MODELS.find((candidate) => candidate.value === value);
  if (!model) {
    throw new Error(`Unknown Kimi model: ${value}`);
  }
  return model;
}

function buildKimiCode2ConfigOptions(state: { model: string; thinking: string }) {
  const offered = findKimiCode2Model(state.model).thinking;
  const listed = offered.includes(state.thinking)
    ? offered
    : [...offered, state.thinking];
  return [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: state.model,
      options: KIMI_CODE_2_MODELS.map(({ value, name }) => ({ value, name })),
    },
    {
      type: "select",
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      currentValue: state.thinking,
      options: listed.map((value) => ({
        value,
        name: KIMI_CODE_2_THINKING_LABELS[value],
      })),
    },
  ];
}

function readThoughtLevelOption(result: AcpRuntimeDiscoveryResult) {
  const option = result.runtimeCapabilities?.configOptions?.find(
    (candidate) => candidate.category === "thought_level",
  );
  return {
    currentValue: option?.currentValue,
    values: option?.values.map((value) => value.value),
  };
}

function buildKimiConfigOptions(selectedModel: string) {
  const supportsEffort = selectedModel.startsWith("kimi-code/k3");
  return [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: selectedModel,
      options: [
        {
          value: "kimi-code/kimi-for-coding",
          name: "K2.7 Coding",
        },
        {
          value: "kimi-code/k3",
          name: "K3",
        },
        {
          value: "kimi-code/k3-256k",
          name: "K3-256k",
        },
      ],
    },
    {
      type: "select",
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      currentValue: supportsEffort ? "high" : "on",
      options: supportsEffort
        ? [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
            { value: "max", name: "Max" },
          ]
        : [{ value: "on", name: "On" }],
    },
  ];
}

function buildKimiAgent(): AcpInstalledAgentRecord {
  const backendId = "acp:kimi" as AcpBackendId;
  return {
    backendId,
    registryId: "kimi",
    name: "Kimi Code CLI",
    version: "0.29.2",
    distributionKind: "local",
    distributionSource: "kimi acp",
    installStatus: "installed",
    authStatus: "authenticated",
    verificationStatus: "not-applicable",
    allowlistRuleId: "local-kimi-cli",
    installedAt: 1000,
    updatedAt: 1000,
    launchDescriptor: {
      backendId,
      registryId: "kimi",
      distributionKind: "local",
      command: "kimi",
      args: ["acp"],
      env: {},
    },
  };
}
