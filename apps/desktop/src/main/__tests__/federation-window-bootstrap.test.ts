import { describe, expect, it } from "vitest";
import {
  FEDERATION_WINDOW_LABEL_ARG_PREFIX,
  FEDERATION_WINDOW_TARGET_ARG_PREFIX,
  federationWindowTargetAdditionalArguments,
  readFederationWindowLabelFromArgv,
  readFederationWindowTargetFromArgv,
} from "../../shared/federation-window";

describe("federation window bootstrap", () => {
  it("round-trips a remote target through BrowserWindow additional arguments", () => {
    const args = federationWindowTargetAdditionalArguments(
      {
        scope: "remote",
        instanceId: "client_one",
      },
      "Studio Mac",
    );

    expect(args).toHaveLength(2);
    expect(args[0]).toContain(FEDERATION_WINDOW_TARGET_ARG_PREFIX);
    expect(args[1]).toContain(FEDERATION_WINDOW_LABEL_ARG_PREFIX);
    expect(readFederationWindowTargetFromArgv(args)).toEqual({
      scope: "remote",
      instanceId: "client_one",
    });
    expect(readFederationWindowLabelFromArgv(args)).toBe("Studio Mac");
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
