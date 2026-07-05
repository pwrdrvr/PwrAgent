import { describe, expect, it } from "vitest";
import {
  ACP_CAPABILITY_MAX_AGE_MS,
  shouldReprobeAcpCapabilities,
} from "../acp/acp-capability-freshness";
import type { AcpInstalledAgentRecord } from "../acp/acp-registry-types";

const NOW = 1_000_000_000_000;

function record(
  overrides: Partial<AcpInstalledAgentRecord> = {},
): AcpInstalledAgentRecord {
  return {
    backendId: "acp:grok",
    registryId: "grok",
    name: "Grok",
    version: "0.2.3",
    distributionKind: "local",
    installStatus: "installed",
    authStatus: "not-required",
    verificationStatus: "not-applicable",
    installedAt: NOW - 10_000,
    updatedAt: NOW - 10_000,
    // A cached, fresh capability probe by default.
    runtimeCapabilities: { discoveredAt: NOW } as never,
    lastDiscoveredAt: NOW,
    ...overrides,
  } as AcpInstalledAgentRecord;
}

describe("shouldReprobeAcpCapabilities", () => {
  it("reuses cache for a fresh, version-matched record", () => {
    expect(shouldReprobeAcpCapabilities(record(), "0.2.3", NOW)).toBe(false);
  });

  it("probes when forced, even if cache is fresh", () => {
    expect(
      shouldReprobeAcpCapabilities(record(), "0.2.3", NOW, { force: true }),
    ).toBe(true);
  });

  it("probes an undiscovered agent (no cached record)", () => {
    expect(shouldReprobeAcpCapabilities(undefined, "0.2.3", NOW)).toBe(true);
  });

  it("probes when the record has no runtime capabilities yet", () => {
    expect(
      shouldReprobeAcpCapabilities(
        record({ runtimeCapabilities: undefined }),
        "0.2.3",
        NOW,
      ),
    ).toBe(true);
  });

  it("probes when never timestamped", () => {
    expect(
      shouldReprobeAcpCapabilities(
        record({ lastDiscoveredAt: undefined }),
        "0.2.3",
        NOW,
      ),
    ).toBe(true);
  });

  it("probes when the CLI version changed since the last probe", () => {
    expect(
      shouldReprobeAcpCapabilities(record({ version: "0.2.3" }), "0.3.0", NOW),
    ).toBe(true);
  });

  it("does not treat an unknown discovered version as a change", () => {
    expect(
      shouldReprobeAcpCapabilities(
        record({ version: "0.2.3" }),
        undefined,
        NOW,
      ),
    ).toBe(false);
  });

  it("probes when the cached probe is older than the freshness window", () => {
    const stale = record({
      lastDiscoveredAt: NOW - ACP_CAPABILITY_MAX_AGE_MS - 1,
    });
    expect(shouldReprobeAcpCapabilities(stale, "0.2.3", NOW)).toBe(true);
  });

  it("keeps using cache right at the freshness boundary", () => {
    const edge = record({ lastDiscoveredAt: NOW - ACP_CAPABILITY_MAX_AGE_MS });
    expect(shouldReprobeAcpCapabilities(edge, "0.2.3", NOW)).toBe(false);
  });

  it("honors a custom maxAgeMs", () => {
    const rec = record({ lastDiscoveredAt: NOW - 5_000 });
    expect(
      shouldReprobeAcpCapabilities(rec, "0.2.3", NOW, { maxAgeMs: 1_000 }),
    ).toBe(true);
    expect(
      shouldReprobeAcpCapabilities(rec, "0.2.3", NOW, { maxAgeMs: 10_000 }),
    ).toBe(false);
  });
});
