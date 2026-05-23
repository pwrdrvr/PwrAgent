import { describe, expect, it } from "vitest";
import { selectAcpDistributionForPlatform } from "../acp/acp-platform-distribution";
import type { AcpRegistryDistribution } from "../acp/acp-registry-types";

describe("selectAcpDistributionForPlatform", () => {
  it("keeps package distributions preferred when available", () => {
    const distributions: AcpRegistryDistribution[] = [
      binary("linux-x64"),
      {
        kind: "npx",
        packageName: "@zed-industries/codex-acp@0.14.0",
        args: [],
        env: {},
      },
    ];

    expect(selectAcpDistributionForPlatform(distributions, ["darwin-arm64"])).toEqual(
      distributions[1],
    );
  });

  it("selects only binaries matching the current platform", () => {
    const linux = binary("linux-x64");
    const mac = binary("darwin-arm64");

    expect(selectAcpDistributionForPlatform([linux, mac], ["darwin-arm64"])).toEqual(
      mac,
    );
  });

  it("does not fall back to the wrong platform when binary is requested", () => {
    expect(
      selectAcpDistributionForPlatform([binary("linux-x64")], ["darwin-arm64"], "binary"),
    ).toBeUndefined();
  });
});

function binary(platform: string): AcpRegistryDistribution {
  return {
    kind: "binary",
    platform,
    archiveUrl: `https://example.com/${platform}.tar.gz`,
    command: "./agent",
    args: [],
    env: {},
  };
}
