import { describe, expect, it } from "vitest";
import { buildPullRequestStatusKey } from "../navigation";

describe("buildPullRequestStatusKey", () => {
  it("separates fork and upstream numbers even in legacy head-repository summaries", () => {
    const legacy = { provider: "github.com", org: "huntharo", repo: "diskhound", number: 38 };
    expect(buildPullRequestStatusKey({ ...legacy, url: "https://github.com/huntharo/diskhound/pull/38" }))
      .toBe("github.com/huntharo/diskhound#38");
    expect(buildPullRequestStatusKey({ ...legacy, url: "https://github.com/tzarebczan/diskhound/pull/38/files#diff-a" }))
      .toBe("github.com/tzarebczan/diskhound#38");
  });

  it("includes the URL host and complete GitLab target namespace", () => {
    expect(buildPullRequestStatusKey({
      provider: "github.com", org: "fork", repo: "project", number: 38,
      url: "https://gitlab.example.com/team/subgroup/project/-/merge_requests/38/diffs",
    })).toBe("gitlab.example.com/team/subgroup/project#38");
    expect(buildPullRequestStatusKey({
      provider: "github.com", org: "fork", repo: "project", number: 38,
      url: "https://ghe.example.com/team/project/pull/38",
    })).toBe("ghe.example.com/team/project#38");
  });

  it.each([
    "not a URL",
    "https://github.com/upstream/repo/issues/38",
    "https://github.com/upstream/repo/pull/38invalid",
    "https://github.com/upstream/repo/pull/9007199254740992",
    "https://github.com/upstream/%broken/pull/38",
  ])("retains explicit identity for an unrecognized URL: %s", (url) => {
    expect(buildPullRequestStatusKey({
      provider: "github.com", org: "fork", repo: "repo", number: 38, url,
    })).toBe("github.com/fork/repo#38");
  });

  it("handles marker-like repository names and encoded namespaces", () => {
    expect(buildPullRequestStatusKey({
      provider: "github.com", org: "fork", repo: "repo", number: 38,
      url: "https://github.com/pull/merge_requests/pull/38",
    })).toBe("github.com/pull/merge_requests#38");
    expect(buildPullRequestStatusKey({
      provider: "gitlab.example.com", org: "fork", repo: "repo", number: 38,
      url: "https://gitlab.example.com/team%2Fsubgroup/project/-/merge_requests/38",
    })).toBe("gitlab.example.com/team/subgroup/project#38");
  });

  it("normalizes provider, owner, and repo casing", () => {
    expect(
      buildPullRequestStatusKey({
        provider: "GitHub.COM",
        org: "ExampleOrg",
        repo: "ExampleApp",
        number: 255,
      }),
    ).toBe("github.com/exampleorg/exampleapp#255");
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
