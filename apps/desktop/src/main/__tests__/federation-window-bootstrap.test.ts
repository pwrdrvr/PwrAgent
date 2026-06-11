import { describe, expect, it } from "vitest";
import {
  FEDERATION_WINDOW_TARGET_ARG_PREFIX,
  federationWindowTargetAdditionalArguments,
  readFederationWindowTargetFromArgv,
} from "../../shared/federation-window";

describe("federation window bootstrap", () => {
  it("round-trips a remote target through BrowserWindow additional arguments", () => {
    const args = federationWindowTargetAdditionalArguments({
      scope: "remote",
      instanceId: "client_one",
    });

    expect(args).toHaveLength(1);
    expect(args[0]).toContain(FEDERATION_WINDOW_TARGET_ARG_PREFIX);
    expect(readFederationWindowTargetFromArgv(args)).toEqual({
      scope: "remote",
      instanceId: "client_one",
    });
  });

  it("ignores absent or malformed targets", () => {
    expect(federationWindowTargetAdditionalArguments(undefined)).toEqual([]);
    expect(
      readFederationWindowTargetFromArgv([
        `${FEDERATION_WINDOW_TARGET_ARG_PREFIX}${JSON.stringify({
          scope: "local",
        })}`,
      ]),
    ).toBeUndefined();
  });
});
