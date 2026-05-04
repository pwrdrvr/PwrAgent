import { describe, expect, it } from "vitest";
import {
  DISABLE_MESSAGING_ARG,
  DISABLE_MESSAGING_ENV,
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
});
