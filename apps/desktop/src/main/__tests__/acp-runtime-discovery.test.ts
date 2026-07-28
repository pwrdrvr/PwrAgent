import { describe, expect, it, vi } from "vitest";
import type { AcpBackendId } from "@pwragent/shared";
import type { AcpJsonRpcTransport } from "../acp/acp-client";
import { discoverAcpRuntimeCapabilities } from "../acp/acp-runtime-discovery";
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
        configId: "model",
        value: "kimi-code/k3-256k",
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
});

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
