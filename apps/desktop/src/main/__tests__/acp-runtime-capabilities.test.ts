import { describe, expect, it } from "vitest";
import {
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
});
