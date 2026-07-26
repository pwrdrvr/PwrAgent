import { describe, expect, it } from "vitest";
import {
  acpRuntimeSupportsSessionHistoryReplay,
  acpSessionRuntimeStateFromCapabilities,
  acpSessionRuntimeStateFromResponse,
  acpSessionRuntimeStateFromUpdate,
  normalizeAcpRuntimeCapabilities,
} from "../acp/acp-runtime-capabilities";

describe("ACP runtime capabilities", () => {
  it("reads Kimi session history replay metadata from ACP session capabilities", () => {
    const capabilities = normalizeAcpRuntimeCapabilities({
      now: 1000,
      source: "initialize",
      value: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
        },
        sessionCapabilities: {
          _meta: {
            kimi: {
              sessionHistoryReplay: true,
            },
          },
        },
      },
    });

    expect(capabilities?.agentCapabilities).toMatchObject({
      loadSession: true,
      sessionHistoryReplay: true,
    });
    expect(acpRuntimeSupportsSessionHistoryReplay(capabilities)).toBe(true);
  });

  it("does not infer session history replay from load_session alone", () => {
    const capabilities = normalizeAcpRuntimeCapabilities({
      now: 1000,
      source: "initialize",
      value: {
        protocol_version: 1,
        agent_capabilities: {
          load_session: true,
        },
        session_capabilities: {
          _meta: {
            kimi: {},
          },
        },
      },
    });

    expect(capabilities?.agentCapabilities?.loadSession).toBe(true);
    expect(acpRuntimeSupportsSessionHistoryReplay(capabilities)).toBe(false);
  });

  it("normalizes prompt content capabilities (image/audio/embeddedContext)", () => {
    const capabilities = normalizeAcpRuntimeCapabilities({
      now: 1000,
      source: "initialize",
      value: {
        protocolVersion: 1,
        agentCapabilities: {
          promptCapabilities: {
            image: false,
            audio: true,
            embeddedContext: true,
          },
        },
      },
    });

    expect(capabilities?.agentCapabilities?.prompt).toEqual({
      image: false,
      audio: true,
      embeddedContext: true,
    });
  });

  it("reads prompt image support from a snake_case prompt_capabilities block", () => {
    const capabilities = normalizeAcpRuntimeCapabilities({
      now: 1000,
      source: "initialize",
      value: {
        protocol_version: 1,
        agent_capabilities: {
          prompt_capabilities: {
            image: true,
          },
        },
      },
    });

    expect(capabilities?.agentCapabilities?.prompt?.image).toBe(true);
  });

  it("normalizes model-specific reasoning effort metadata", () => {
    const response = {
      models: {
        currentModelId: "grok-4.5",
        availableModels: [
          {
            modelId: "grok-4.5",
            name: "Grok 4.5",
            _meta: {
              supportsReasoningEffort: true,
              reasoningEffort: "medium",
              reasoningEfforts: [
                { value: "low", label: "Low" },
                { value: "medium", label: "Medium" },
                { value: "high", label: "High", default: true },
              ],
            },
          },
        ],
      },
    };
    const capabilities = normalizeAcpRuntimeCapabilities({
      now: 1000,
      source: "initialize",
      value: response,
    });

    expect(capabilities?.models).toEqual({
      currentModelId: "grok-4.5",
      availableModels: [
        {
          id: "grok-4.5",
          label: "Grok 4.5",
          defaultReasoningEffort: "high",
          reasoningEfforts: ["low", "medium", "high"],
          supportsReasoning: true,
        },
      ],
    });
    expect(acpSessionRuntimeStateFromCapabilities(capabilities, 1001)).toEqual({
      currentModelId: "grok-4.5",
      updatedAt: 1001,
    });
    expect(
      acpSessionRuntimeStateFromResponse(response, 1002),
    ).toEqual({
      currentModelId: "grok-4.5",
      reasoningEffort: "medium",
      updatedAt: 1002,
    });
  });

  it("reads Grok model change notifications as session runtime state", () => {
    expect(
      acpSessionRuntimeStateFromUpdate(
        {
          sessionUpdate: "model_changed",
          model_id: "grok-4.5",
          reasoning_effort: "low",
        },
        1000,
      ),
    ).toEqual({
      currentModelId: "grok-4.5",
      reasoningEffort: "low",
      updatedAt: 1000,
    });
  });

  it("marks missing effort as cleared when a session response selects a model", () => {
    const state = acpSessionRuntimeStateFromResponse(
      {
        models: {
          currentModelId: "gemini-3-pro-preview",
          availableModels: [
            {
              modelId: "gemini-3-pro-preview",
              name: "Gemini 3 Pro Preview",
            },
          ],
        },
      },
      1000,
    );

    expect(state).toHaveProperty("currentModelId", "gemini-3-pro-preview");
    expect(state).toHaveProperty("reasoningEffort", undefined);
  });

  it("marks missing effort as cleared in model change notifications", () => {
    const state = acpSessionRuntimeStateFromUpdate(
      {
        sessionUpdate: "model_changed",
        model_id: "gemini-3-pro-preview",
      },
      1000,
    );

    expect(state).toHaveProperty("currentModelId", "gemini-3-pro-preview");
    expect(state).toHaveProperty("reasoningEffort", undefined);
  });
});
