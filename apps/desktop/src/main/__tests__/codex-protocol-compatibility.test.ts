import { describe, expect, it } from "vitest";
import {
  codexVersionFromUserAgent,
  resolveCodexProtocolCompatibility,
  usesGeneratedCodexModelListResponse,
} from "../codex-app-server/protocol-compatibility";

describe("Codex App Server protocol compatibility", () => {
  const capabilityCases: Array<{
    version: string | undefined;
    features?: Partial<ReturnType<typeof resolveCodexProtocolCompatibility>>;
    exact?: boolean;
    generatedModelList?: boolean;
  }> = [
    {
      version: undefined,
      generatedModelList: false,
      exact: true,
      features: {
        supportsAutoReview: false,
        dynamicToolFormat: "flat",
        includePersistExtendedHistory: true,
        supportsOnFailureApprovalPolicy: true,
        supportsThreadScopedMcpServerStatus: false,
        supportsThreadRevert: false,
        supportsThreadGoals: false,
        supportsTurnAncestry: false,
      },
    },
    {
      version: "codex-cli 0.136.0",
      exact: true,
      features: {
        supportsAutoReview: false,
        dynamicToolFormat: "flat",
        includePersistExtendedHistory: true,
        supportsOnFailureApprovalPolicy: true,
        supportsThreadScopedMcpServerStatus: false,
        supportsThreadRevert: false,
        supportsThreadGoals: false,
        supportsTurnAncestry: false,
      },
    },
    {
      version: "codex-cli 0.137.0",
      exact: true,
      features: {
        supportsAutoReview: false,
        dynamicToolFormat: "flat",
        includePersistExtendedHistory: false,
        supportsOnFailureApprovalPolicy: true,
        supportsThreadScopedMcpServerStatus: false,
        supportsThreadRevert: false,
        supportsThreadGoals: false,
        supportsTurnAncestry: false,
      },
    },
    {
      version: "codex-cli 0.141.0",
      exact: true,
      features: {
        supportsAutoReview: false,
        dynamicToolFormat: "namespaced",
        includePersistExtendedHistory: false,
        supportsOnFailureApprovalPolicy: true,
        supportsThreadScopedMcpServerStatus: false,
        supportsThreadRevert: false,
        supportsThreadGoals: false,
        supportsTurnAncestry: false,
      },
    },
    {
      version: "codex-cli 0.143.0",
      generatedModelList: false,
      exact: true,
      features: {
        supportsAutoReview: false,
        dynamicToolFormat: "namespaced",
        includePersistExtendedHistory: false,
        supportsOnFailureApprovalPolicy: false,
        supportsThreadScopedMcpServerStatus: false,
        supportsThreadRevert: false,
        supportsThreadGoals: false,
        supportsTurnAncestry: false,
      },
    },
    {
      version: "codex-cli 0.144.0",
      generatedModelList: true,
      exact: true,
      features: {
        supportsAutoReview: false,
        dynamicToolFormat: "namespaced",
        includePersistExtendedHistory: false,
        supportsOnFailureApprovalPolicy: false,
        supportsThreadScopedMcpServerStatus: true,
        supportsThreadRevert: false,
        supportsThreadGoals: false,
        supportsTurnAncestry: false,
      },
    },
    { version: "unknown", features: { supportsTurnAncestry: false } },
    { version: "0.144.0", features: { supportsThreadRevert: false } },
    { version: "0.152.0", features: { supportsAutoReview: false } },
    { version: "0.153.0", features: { supportsAutoReview: true, supportsThreadRevert: true } },
    { version: "0.153.4-pwragent.1", features: { supportsAutoReview: true } },
    { version: "codex-cli 0.159.2", features: { supportsThreadRevert: true } },
    { version: "0.163.0", features: { supportsTurnAncestry: false, supportsThreadGoals: false } },
    { version: "0.164.0", features: { supportsTurnAncestry: true, supportsThreadGoals: true } },
    { version: "0.164.0-pwragent.1", features: { supportsTurnAncestry: true } },
    { version: "1.0.0", features: { supportsTurnAncestry: true } },
    { version: "codex-cli 1.0.0", generatedModelList: true },
  ];

  it.each(capabilityCases)("negotiates the protocol capabilities for $version", ({
    version, features, exact, generatedModelList,
  }) => {
    if (features) {
      const compatibility = resolveCodexProtocolCompatibility(version);
      if (exact) expect(compatibility).toEqual(features);
      else expect(compatibility).toMatchObject(features);
    }
    if (generatedModelList !== undefined) {
      expect(usesGeneratedCodexModelListResponse(version)).toBe(generatedModelList);
    }
  });

  it.each([
    {
      // Captured verbatim from a `codex app-server` handshake answering
      // PwrAgent's own `clientInfo`.
      expected: "0.149.1",
      userAgent:
        "pwragent-desktop/0.149.1 (Mac OS 26.6.2; arm64) unknown"
        + " (pwragent-desktop; 1.4.0)",
    },
    {
      // The suffix is the whole point: it is what separates a PwrAgent build
      // from OpenAI's release of the same upstream version.
      expected: "0.149.0-pwragent.2",
      userAgent: "pwragent-desktop/0.149.0-pwragent.2 (Linux; x86_64) unknown",
    },
    {
      // A client name may carry a slash; the version never does.
      expected: "0.149.1",
      userAgent: "acme/tool/0.149.1 (Mac OS 26.6.2; arm64) unknown",
    },
    { expected: undefined, userAgent: undefined },
    { expected: undefined, userAgent: "   " },
    // A client name with no version after it, and a version-shaped string
    // that never named a client, are both unreadable rather than a guess.
    { expected: undefined, userAgent: "pwragent-desktop (Mac OS 26.6.2; arm64)" },
    { expected: undefined, userAgent: "0.149.1 (Mac OS 26.6.2; arm64)" },
  ])("reads the App Server version out of $userAgent", ({
    expected,
    userAgent,
  }) => {
    expect(codexVersionFromUserAgent(userAgent)).toBe(expected);
  });
});
