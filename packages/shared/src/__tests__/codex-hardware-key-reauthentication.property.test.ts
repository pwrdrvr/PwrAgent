import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  isCodexAuthenticationFailure,
  isCodexHardwareKeyReauthenticationRequired,
} from "../codex-authentication";
import {
  describeModelReroute,
  describeModelVerification,
} from "../model-routing";

// Codex 0.164's text for a response withheld until the account signs in
// again with a hardware key. It arrives with `codexErrorInfo: "cyberPolicy"`.
const HARDWARE_KEY_MESSAGE =
  "You’re approved for Daybreak Blue, but this response cannot be shown as this session"
  + " was not authenticated with one of your authorized hardware keys. Please"
  + " re-authenticate with your hardware key and try your request again.";

const codexErrorInfoArb = fc.oneof(
  fc.constantFrom(
    "cyberPolicy",
    "bioPolicy",
    "unauthorized",
    "other",
    "misalignmentPolicyViolation",
    "usageLimitExceeded",
  ),
  fc.constant(undefined),
  fc.constant({ httpConnectionFailed: { httpStatusCode: 401 } }),
);

const messageArb = fc.oneof(
  fc.constant(HARDWARE_KEY_MESSAGE),
  fc.constant("This request was flagged by the cyber policy."),
  fc.constant("Please plug in your hardware key."),
  fc.constant("Your access token could not be refreshed. Please log out and sign in again."),
  fc.string(),
);

describe("Codex hardware-key reauthentication", () => {
  it("requires both Codex's policy code and the provider's hardware-key instruction", () => {
    // Oracle: the decision table. A policy code without the instruction is
    // another refusal; the instruction under another code is not this signal.
    fc.assert(fc.property(codexErrorInfoArb, messageArb, (codexErrorInfo, message) => {
      const expected = codexErrorInfo === "cyberPolicy" && message === HARDWARE_KEY_MESSAGE;
      expect(isCodexHardwareKeyReauthenticationRequired({ message, codexErrorInfo }))
        .toBe(expected);
    }), { numRuns: 500 });
  });

  it("is not a logged-out account, so other Codex requests keep running", () => {
    expect(isCodexAuthenticationFailure(HARDWARE_KEY_MESSAGE)).toBe(false);
  });

  it("ignores values that are not a turn error", () => {
    for (const value of [undefined, null, "cyberPolicy", HARDWARE_KEY_MESSAGE, 7]) {
      expect(isCodexHardwareKeyReauthenticationRequired(value)).toBe(false);
    }
  });
});

describe("model routing text", () => {
  it("names both models of a reroute, including a reason from a newer Codex", () => {
    fc.assert(fc.property(
      fc.stringMatching(/^[a-z0-9.-]{1,16}$/),
      fc.stringMatching(/^[a-z0-9.-]{1,16}$/),
      fc.oneof(fc.constant("highRiskCyberActivity"), fc.stringMatching(/^[a-z][a-zA-Z]{0,20}$/)),
      (fromModel, toModel, reason) => {
        const text = describeModelReroute({ fromModel, toModel, reason });
        expect(text.startsWith(`Rerouted from ${fromModel} to ${toModel}`)).toBe(true);
      },
    ));
    expect(describeModelReroute({
      fromModel: "gpt-6.2-sol",
      toModel: "gpt-6-luna",
      reason: "highRiskCyberActivity",
    })).toBe(
      "Rerouted from gpt-6.2-sol to gpt-6-luna because of possible high-risk cybersecurity activity",
    );
  });

  it("keeps a verification it does not know readable", () => {
    expect(describeModelVerification("trustedAccessForCyber").label)
      .toBe("Trusted Access for Cyber");
    expect(describeModelVerification("hardwareKeyEnrollment")).toEqual({
      label: "hardware key enrollment",
      detail: "Codex asked for additional account verification: hardware key enrollment.",
    });
  });
});
