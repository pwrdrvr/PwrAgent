import { describe, expect, it } from "vitest";
import type { AcpBackendId } from "@pwragent/shared";
import { describeInstalledAcpBackend } from "../app-server/acp-backend-adapter";
import type { AcpInstalledAgentRecord } from "../acp/acp-registry-types";

describe("describeInstalledAcpBackend", () => {
  it("does not advertise session/load when the agent reports it is unsupported", () => {
    const backend = describeInstalledAcpBackend({
      ...buildInstalledAgent(),
      runtimeCapabilities: {
        schemaVersion: 1,
        status: "discovered",
        agentCapabilities: {
          loadSession: false,
        },
        checkedAt: 1000,
      },
    });

    expect(backend.methods).toEqual([
      "session/new",
      "session/prompt",
      "session/cancel",
    ]);
  });

  it("keeps session/load advertised for agents without explicit load capability data", () => {
    const backend = describeInstalledAcpBackend(buildInstalledAgent());

    expect(backend.methods).toContain("session/load");
  });
});

function buildInstalledAgent(): AcpInstalledAgentRecord {
  return {
    backendId: "acp:gemini" as AcpBackendId,
    registryId: "gemini",
    name: "Gemini CLI",
    distributionKind: "local",
    distributionSource: "gemini",
    installStatus: "installed",
    authStatus: "not-required",
    verificationStatus: "not-applicable",
    allowlistRuleId: "local-gemini-cli",
    installedAt: 1000,
    updatedAt: 1000,
  };
}
