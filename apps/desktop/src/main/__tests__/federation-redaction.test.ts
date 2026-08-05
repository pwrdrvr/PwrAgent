import { describe, expect, it } from "vitest";
import {
  classifyFederationClientFailure,
  redactFederationDiagnostic,
} from "../federation/federation-redaction";

describe("classifyFederationClientFailure", () => {
  it("classifies auth rejection codes as auth failures", () => {
    for (const code of [
      "unknown_peer",
      "revoked_peer",
      "missing_invite",
      "expired_invite",
      "wrong_gateway",
      "reused_invite",
      "bad_signature",
      "capability_denied",
      "policy_denied",
      "invalid_protocol_version",
    ]) {
      expect(classifyFederationClientFailure(code)).toBe("auth");
    }
  });

  it("classifies handshake and pin mismatches as auth failures", () => {
    expect(
      classifyFederationClientFailure("Invalid federation auth challenge"),
    ).toBe("auth");
    expect(
      classifyFederationClientFailure(
        "Encrypted federation frame authentication failed",
      ),
    ).toBe("auth");
    expect(
      classifyFederationClientFailure(
        "Federation gateway does not support required Noise transport version 1.",
      ),
    ).toBe("auth");
    expect(
      classifyFederationClientFailure(
        "Federation client mode is missing its pinned gateway key.",
      ),
    ).toBe("auth");
  });

  it("classifies network conditions as transport failures", () => {
    expect(
      classifyFederationClientFailure("connect ECONNREFUSED 192.168.6.163:47830"),
    ).toBe("transport");
    expect(classifyFederationClientFailure("Federation socket closed")).toBe(
      "transport",
    );
    expect(
      classifyFederationClientFailure("Federation gateway connection closed."),
    ).toBe("transport");
  });
});

describe("redactFederationDiagnostic", () => {
  it("keeps failure codes intact for classification downstream", () => {
    expect(redactFederationDiagnostic("unknown_peer")).toBe("unknown_peer");
  });
});
