import { describe, expect, it } from "vitest";
import {
  DISABLE_AUTOMATIONS_ARG,
  DISABLE_AUTOMATIONS_ENV,
  DISABLE_MESSAGING_ARG,
  DISABLE_MESSAGING_ENV,
  resolveRuntimeAutomationsOverride,
  resolveRuntimeMessagingOverride,
} from "../runtime-flags";

describe("runtime flags", () => {
  it("disables messaging when the command line flag is present", () => {
    expect(
      resolveRuntimeMessagingOverride({
        argv: ["electron", DISABLE_MESSAGING_ARG],
        env: {},
      }),
    ).toEqual({
      disabled: true,
      reason: "--disable-messaging was provided at startup",
    });
  });

  it("disables messaging when the environment fallback is enabled", () => {
    expect(
      resolveRuntimeMessagingOverride({
        argv: ["electron"],
        env: {
          [DISABLE_MESSAGING_ENV]: "true",
        },
      }),
    ).toEqual({
      disabled: true,
      reason: "PWRAGENT_DISABLE_MESSAGING is enabled",
    });
  });

  it("disables automations when the command line flag is present", () => {
    expect(
      resolveRuntimeAutomationsOverride({
        argv: ["electron", DISABLE_AUTOMATIONS_ARG],
        env: {},
      }),
    ).toEqual({
      disabled: true,
      reason: "--disable-automations was provided at startup",
    });
  });

  it("disables automations when the environment fallback is enabled", () => {
    expect(
      resolveRuntimeAutomationsOverride({
        argv: ["electron"],
        env: {
          [DISABLE_AUTOMATIONS_ENV]: "1",
        },
      }),
    ).toEqual({
      disabled: true,
      reason: "PWRAGENT_DISABLE_AUTOMATIONS is enabled",
    });
  });
});
