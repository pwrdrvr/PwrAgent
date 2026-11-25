import os from "node:os";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { shouldReprobeAcpCapabilities } from "../acp/acp-capability-freshness";
import { probeAcpRuntimeCapabilities, refreshAcpRuntimeCapabilities } from "../acp/acp-capability-probe";
import type { AcpInstalledAgentRecord } from "../acp/acp-registry-types";
import { discoverAcpRuntimeCapabilities } from "../acp/acp-runtime-discovery";

vi.mock("../acp/acp-runtime-discovery", () => ({
  discoverAcpRuntimeCapabilities: vi.fn(),
}));

const managedAntigravity: AcpInstalledAgentRecord = {
  backendId: "acp:antigravity",
  registryId: "antigravity",
  name: "Antigravity",
  version: "1.5.16",
  distributionKind: "local",
  distributionSource: "agy",
  installStatus: "installed",
  authStatus: "not-required",
  verificationStatus: "not-applicable",
  allowlistRuleId: "local-antigravity-cli",
  installedAt: 1,
  updatedAt: 2,
  launchDescriptor: {
    backendId: "acp:antigravity", registryId: "antigravity", distributionKind: "local",
    command: "/fixture/agy", args: ["acp"], env: {}, managedAntigravityFallback: true,
  },
};

it("shares a managed Antigravity discovery between Settings and the background probe", async () => {
  const discover = vi.mocked(discoverAcpRuntimeCapabilities);
  for (const settingsFirst of [false, true]) {
    discover.mockReset();
    const response = Promise.withResolvers<Awaited<ReturnType<typeof discoverAcpRuntimeCapabilities>>>();
    discover.mockReturnValue(response.promise);
    const controller = new AbortController();
    const startSettings = () => probeAcpRuntimeCapabilities(managedAntigravity, os.tmpdir(), 1_000, { signal: controller.signal });
    const startBackground = () => refreshAcpRuntimeCapabilities(managedAntigravity, os.tmpdir());
    const first = settingsFirst ? startSettings() : startBackground();
    const second = settingsFirst ? startBackground() : startSettings();
    const settings = settingsFirst ? first : second;
    const background = settingsFirst ? second : first;
    const settled = Promise.all([expect(settings).rejects.toThrow("cancelled"), expect(background).resolves.toMatchObject({
      lastDiscoveredAt: expect.any(Number),
    })]);
    try {
      await Promise.resolve();
      expect(discover).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort(new Error("cancelled"));
      response.resolve({});
      await settled;
    }
  }
});

it("waits for the cancelled Antigravity process to close before re-probing the same runtime", async () => {
  const discover = vi.mocked(discoverAcpRuntimeCapabilities);
  discover.mockReset();
  const draining = Promise.withResolvers<Awaited<ReturnType<typeof discoverAcpRuntimeCapabilities>>>();
  discover.mockReturnValueOnce(draining.promise).mockResolvedValueOnce({});
  const controller = new AbortController();
  const first = probeAcpRuntimeCapabilities(managedAntigravity, os.tmpdir(), undefined, { signal: controller.signal });
  await Promise.resolve();
  const cancelled = expect(first).rejects.toThrow("cancelled");
  controller.abort(new Error("cancelled"));
  await cancelled;
  expect(discover.mock.calls[0]?.[1].signal?.aborted).toBe(true);
  const replacement = refreshAcpRuntimeCapabilities(managedAntigravity, os.tmpdir());
  try {
    expect(discover).toHaveBeenCalledTimes(1);
  } finally {
    draining.resolve({});
    await replacement;
  }
  expect(discover).toHaveBeenCalledTimes(2);
});

it("keeps the carried model list when Antigravity only reports protocol capabilities", async () => {
  const models = { currentModelId: "model-a", availableModels: [{ id: "model-a" }] };
  vi.mocked(discoverAcpRuntimeCapabilities).mockResolvedValueOnce({
    runtimeCapabilities: { schemaVersion: 1, status: "discovered", agentCapabilities: { loadSession: true } },
  });
  const result = await probeAcpRuntimeCapabilities({
    ...managedAntigravity,
    runtimeCapabilities: { schemaVersion: 1, status: "stale", models },
  }, os.tmpdir());
  expect(result.record.runtimeCapabilities).toMatchObject({ models, agentCapabilities: { loadSession: true } });
});

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

  await fc.assert(fc.asyncProperty(
    fc.constantFrom("ACP request timed out", "ACP transport closed", "Could not start executable"),
    async (inconclusiveError) => {
      discover.mockRejectedValueOnce(new Error(inconclusiveError));
      const recheck = await probeAcpRuntimeCapabilities(failure.record, os.tmpdir());
      expect(recheck.error).toBe(inconclusiveError);
      expect(recheck.record.lastDiscoveryError).toBe(rejection);
    },
  ));

  // Even a successful session with no model catalog proves auth recovered.
  discover.mockResolvedValueOnce({});
  const recovery = await probeAcpRuntimeCapabilities(failure.record, os.tmpdir());
  expect(recovery.error).toBeUndefined();
  expect(recovery.record.backendId).toBe("acp:gemini");
  expect(recovery.record.lastDiscoveryError).toBeUndefined();
});
