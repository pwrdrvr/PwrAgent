import { describe, expect, it } from "vitest";
import {
  acpSessionRuntimeStateFromUpdate,
  acpRuntimeSupportsSessionHistoryReplay,
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

  it("tracks Grok model_changed vendor updates as session runtime state", () => {
    expect(
      acpSessionRuntimeStateFromUpdate(
        {
          sessionUpdate: "model_changed",
          model_id: "grok-4.5",
          reasoning_effort: "high",
        },
        1000,
      ),
    ).toEqual({
      currentModelId: "grok-4.5",
      updatedAt: 1000,
    });
  });
});
