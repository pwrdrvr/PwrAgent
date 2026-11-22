import os from "node:os";
import { expect, it, vi } from "vitest";
import { shouldReprobeAcpCapabilities } from "../acp/acp-capability-freshness";
import { probeAcpRuntimeCapabilities } from "../acp/acp-capability-probe";
import { discoverAcpRuntimeCapabilities } from "../acp/acp-runtime-discovery";

vi.mock("../acp/acp-runtime-discovery", () => ({
  discoverAcpRuntimeCapabilities: vi.fn(),
}));

it("recovers Gemini CLI after the consumer account is replaced", async () => {
  const now = Date.now();
  const runtime = {
    schemaVersion: 1,
    status: "discovered",
  } as const;
  const previouslyDiscovered = {
    backendId: "acp:gemini",
    registryId: "gemini",
    name: "Gemini CLI",
    version: "0.42.0",
    distributionKind: "local",
    distributionSource: "gemini",
    installStatus: "installed",
    authStatus: "not-required",
    verificationStatus: "not-applicable",
    allowlistRuleId: "local-gemini-cli",
    installedAt: now,
    updatedAt: now,
    lastDiscoveredAt: now,
    runtimeCapabilities: runtime,
  } as const;
  const rejection = "json-rpc error (-32000): This client is no longer supported for Gemini Code Assist for individuals.\nTo continue using Gemini, please migrate to the Antigravity suite of products.";
  const discover = vi.mocked(discoverAcpRuntimeCapabilities);
  discover.mockRejectedValueOnce(new Error(rejection));
  const failure = await probeAcpRuntimeCapabilities(previouslyDiscovered, os.tmpdir());
  expect(failure.record.lastDiscoveryError).toBe(rejection);
  expect(failure.record.runtimeCapabilities).toBeUndefined();
  expect(failure.error).toContain("paid Gemini API key");
  expect(shouldReprobeAcpCapabilities(
    { ...previouslyDiscovered, lastDiscoveryError: rejection }, previouslyDiscovered.version, now,
  )).toBe(true);

  // Even a successful session with no model catalog proves auth recovered.
  discover.mockResolvedValueOnce({});
  const recovery = await probeAcpRuntimeCapabilities(failure.record, os.tmpdir());
  expect(recovery.error).toBeUndefined();
  expect(recovery.record.backendId).toBe("acp:gemini");
  expect(recovery.record.lastDiscoveryError).toBeUndefined();
});
