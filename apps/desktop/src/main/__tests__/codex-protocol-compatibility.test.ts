import { describe, expect, it } from "vitest";
import {
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
      },
    },
    {
      version: "codex-cli 0.136.0",
      expected: {
        dynamicToolFormat: "flat",
        includePersistExtendedHistory: true,
        supportsOnFailureApprovalPolicy: true,
      },
    },
    {
      version: "codex-cli 0.137.0",
      expected: {
        dynamicToolFormat: "flat",
        includePersistExtendedHistory: false,
        supportsOnFailureApprovalPolicy: true,
      },
    },
    {
      version: "codex-cli 0.141.0",
      expected: {
        dynamicToolFormat: "namespaced",
        includePersistExtendedHistory: false,
        supportsOnFailureApprovalPolicy: true,
      },
    },
    {
      version: "codex-cli 0.143.0",
      expected: {
        dynamicToolFormat: "namespaced",
        includePersistExtendedHistory: false,
        supportsOnFailureApprovalPolicy: false,
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
});
