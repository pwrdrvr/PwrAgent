import { describe, expect, it } from "vitest";
import {
  codexVersionFromUserAgent,
  resolveCodexProtocolCompatibility,
  usesGeneratedCodexModelListResponse,
} from "../codex-app-server/protocol-compatibility";

describe("Codex App Server protocol compatibility", () => {
  it.each([
    {
      version: undefined,
      expected: {
        dynamicToolFormat: "flat",
        includePersistExtendedHistory: true,
        supportsOnFailureApprovalPolicy: true,
        supportsThreadScopedMcpServerStatus: false,
      },
    },
    {
      version: "codex-cli 0.136.0",
      expected: {
        dynamicToolFormat: "flat",
        includePersistExtendedHistory: true,
        supportsOnFailureApprovalPolicy: true,
        supportsThreadScopedMcpServerStatus: false,
      },
    },
    {
      version: "codex-cli 0.137.0",
      expected: {
        dynamicToolFormat: "flat",
        includePersistExtendedHistory: false,
        supportsOnFailureApprovalPolicy: true,
        supportsThreadScopedMcpServerStatus: false,
      },
    },
    {
      version: "codex-cli 0.141.0",
      expected: {
        dynamicToolFormat: "namespaced",
        includePersistExtendedHistory: false,
        supportsOnFailureApprovalPolicy: true,
        supportsThreadScopedMcpServerStatus: false,
      },
    },
    {
      version: "codex-cli 0.143.0",
      expected: {
        dynamicToolFormat: "namespaced",
        includePersistExtendedHistory: false,
        supportsOnFailureApprovalPolicy: false,
        supportsThreadScopedMcpServerStatus: false,
      },
    },
    {
      version: "codex-cli 0.144.0",
      expected: {
        dynamicToolFormat: "namespaced",
        includePersistExtendedHistory: false,
        supportsOnFailureApprovalPolicy: false,
        supportsThreadScopedMcpServerStatus: true,
      },
    },
  ])("negotiates the wire features for $version", ({ version, expected }) => {
    expect(resolveCodexProtocolCompatibility(version)).toEqual(expected);
  });

  it.each([
    { version: undefined, expected: false },
    { version: "codex-cli 0.143.0", expected: false },
    { version: "codex-cli 0.144.0", expected: true },
    { version: "codex-cli 1.0.0", expected: true },
  ])(
    "selects generated model/list fields for $version",
    ({ version, expected }) => {
      expect(usesGeneratedCodexModelListResponse(version)).toBe(expected);
    },
  );

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
