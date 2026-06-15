import { describe, expect, it } from "vitest";
import { buildPullRequestStatusKey } from "../navigation";

describe("buildPullRequestStatusKey", () => {
  it("normalizes provider, owner, and repo casing", () => {
    expect(
      buildPullRequestStatusKey({
        provider: "GitHub.COM",
        org: "Giphy",
        repo: "GifGrabber",
        number: 255,
      }),
    ).toBe("github.com/giphy/gifgrabber#255");
  });

  it("defaults blank providers to github.com", () => {
    expect(
      buildPullRequestStatusKey({
        provider: "",
        org: "pwrdrvr",
        repo: "PwrAgent",
        number: 797,
      }),
    ).toBe("github.com/pwrdrvr/pwragent#797");
  });
});
