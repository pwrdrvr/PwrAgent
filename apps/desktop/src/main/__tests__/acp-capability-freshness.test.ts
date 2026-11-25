import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { buildAcpLaunchpadOptions } from "../app-server/acp-backend-adapter";
import {
  ACP_CAPABILITY_MAX_AGE_MS,
  recordWithSessionRuntimeCapabilities,
  shouldProbeAcpCapabilitiesAfterRuntimeChange,
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
      shouldReprobeAcpCapabilities(record({ version: "0.2.3" }), undefined, NOW),
    ).toBe(false);
  });

  it("probes when the cached probe is older than the freshness window", () => {
    const stale = record({ lastDiscoveredAt: NOW - ACP_CAPABILITY_MAX_AGE_MS - 1 });
    expect(shouldReprobeAcpCapabilities(stale, "0.2.3", NOW)).toBe(true);
  });

  it("keeps using cache right at the freshness boundary", () => {
    const edge = record({ lastDiscoveredAt: NOW - ACP_CAPABILITY_MAX_AGE_MS });
    expect(shouldReprobeAcpCapabilities(edge, "0.2.3", NOW)).toBe(false);
  });

  it("honors a custom maxAgeMs", () => {
    const rec = record({ lastDiscoveredAt: NOW - 5_000 });
    expect(shouldReprobeAcpCapabilities(rec, "0.2.3", NOW, { maxAgeMs: 1_000 })).toBe(
      true,
    );
    expect(shouldReprobeAcpCapabilities(rec, "0.2.3", NOW, { maxAgeMs: 10_000 })).toBe(
      false,
    );
  });
});

describe("shouldProbeAcpCapabilitiesAfterRuntimeChange", () => {
  // The state startup discovery leaves behind when a known agent's runtime
  // changed: installed and launchable, with every probe field cleared.
  function changedRuntime(
    overrides: Partial<AcpInstalledAgentRecord> = {},
  ): AcpInstalledAgentRecord {
    return record({
      launchDescriptor: {
        backendId: "acp:grok",
        registryId: "grok",
        distributionKind: "local",
        command: "/usr/local/bin/grok",
        args: ["agent", "stdio"],
        env: {},
      },
      runtimeCapabilities: undefined,
      lastDiscoveredAt: undefined,
      lastDiscoveryError: undefined,
      ...overrides,
    });
  }

  it("probes a known agent whose runtime has never been probed", () => {
    expect(shouldProbeAcpCapabilitiesAfterRuntimeChange(changedRuntime(), true)).toBe(
      true,
    );
  });

  it("leaves an agent seen for the first time to Settings and setup", () => {
    expect(shouldProbeAcpCapabilitiesAfterRuntimeChange(changedRuntime(), false)).toBe(
      false,
    );
  });

  it("does not repeat once any probe outcome is recorded", () => {
    expect(
      shouldProbeAcpCapabilitiesAfterRuntimeChange(
        changedRuntime({ runtimeCapabilities: { discoveredAt: NOW } as never }),
        true,
      ),
    ).toBe(false);
    // A probe that yielded no capabilities still stamps the runtime.
    expect(
      shouldProbeAcpCapabilitiesAfterRuntimeChange(
        changedRuntime({ lastDiscoveredAt: NOW }),
        true,
      ),
    ).toBe(false);
    expect(
      shouldProbeAcpCapabilitiesAfterRuntimeChange(
        changedRuntime({ lastDiscoveryError: "timed out" }),
        true,
      ),
    ).toBe(false);
  });

  it("never probes an agent that cannot be launched", () => {
    expect(
      shouldProbeAcpCapabilitiesAfterRuntimeChange(
        changedRuntime({ installStatus: "unavailable" }),
        true,
      ),
    ).toBe(false);
    expect(
      shouldProbeAcpCapabilitiesAfterRuntimeChange(
        changedRuntime({ launchDescriptor: undefined }),
        true,
      ),
    ).toBe(false);
  });
});

describe("recordWithSessionRuntimeCapabilities", () => {
  it("keeps the Antigravity model catalog selectable after a live reply advertises legacy IDs", () => {
    fc.assert(fc.property(fc.constantFrom("gemini-4-neon", "gemini-4-carbon", "claude-opus-5-5"),
      (selected) => {
        const ids = ["gemini-4-neon", "gemini-4-carbon", "claude-opus-5-5", "gemini-pro-orchestrator"];
        const knownEfforts = ["low", "medium", "high", "xhigh"];
        const initial = {
          schemaVersion: 1, status: "discovered", source: "session-load", discoveredAt: NOW, checkedAt: NOW,
          configOptions: [{ id: "model", label: "Model", type: "select", category: "model", currentValue: ids[0],
            values: ids.map((value) => ({ value })) }],
          models: { availableModels: ids.map((id) => ({
            id, ...(id === ids[0] ? { reasoningEfforts: knownEfforts } : {}),
          })) },
        } satisfies NonNullable<AcpInstalledAgentRecord["runtimeCapabilities"]>;
        const live = {
          ...initial,
          configOptions: initial.configOptions.map((option) => ({ ...option, currentValue: selected })),
          models: { currentModelId: `${selected}-high`, availableModels: ids.map((id) => ({ id: `${id}-high` })) },
        };
        const updated = recordWithSessionRuntimeCapabilities(record({
          registryId: "antigravity", backendId: "acp:antigravity", runtimeCapabilities: initial,
        }), live, NOW);
        const catalog = buildAcpLaunchpadOptions(updated.runtimeCapabilities, "antigravity")?.models;
        expect(catalog?.map((m) => m.id)).toEqual(ids);
        expect(catalog?.find((m) => m.current)?.id).toBe(selected);
        if (selected !== ids[0]) expect(catalog?.[0]?.reasoningEfforts).toEqual(knownEfforts);
        expect(buildAcpLaunchpadOptions(live, "antigravity")?.models?.map((m) => m.id)).toEqual(ids);
      }));
  });

  it("does not let a live session renew the probe clock", () => {
    // Measured: a Kimi record catalogued before #2219 still listed `on` among
    // K3's thought levels, and named it K3's default, a day after that fix
    // shipped. Every turn re-stamped the 48-hour window, so the re-probe that
    // would have corrected the catalog never came due.
    const stale = record({
      lastDiscoveredAt: NOW - ACP_CAPABILITY_MAX_AGE_MS - 1,
      lastDiscoveryError: "probe failed",
    });

    const updated = recordWithSessionRuntimeCapabilities(
      stale,
      { discoveredAt: NOW, source: "session-load" } as never,
      NOW,
    );

    expect(updated.lastDiscoveredAt).toBe(stale.lastDiscoveredAt);
    expect(updated.lastDiscoveryError).toBe("probe failed");
    expect(updated.runtimeCapabilities).toMatchObject({ source: "session-load" });
    expect(updated.updatedAt).toBe(NOW);
    expect(shouldReprobeAcpCapabilities(updated, "0.2.3", NOW)).toBe(true);
  });
});
