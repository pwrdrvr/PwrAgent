import { describe, expect, it } from "vitest";
import { buildPullRequestReferenceUrl, parsePullRequestReferenceUrl } from "../pr-status/forge-reference";

describe("forge attachment identities", () => {
  it.each([
    ["https://github.com/team/project/pull/17", "github"],
    ["https://ghe.example.com/team/project/pull/17", "github"],
    ["https://code.example.com/team/sub/project/-/merge_requests/17", "gitlab"],
  ])("retains the product from %s when building another numbered link", (url, kind) => {
    const ref = parsePullRequestReferenceUrl(url)!;
    expect(ref.kind).toBe(kind);
    expect(buildPullRequestReferenceUrl({ ...ref, number: 18 })).toBe(url.replace("/17", "/18"));
  });

  it("uses catalog paths for known remote hosts", () => {
    expect(buildPullRequestReferenceUrl({ provider: "gitlab.example.com", org: "team/sub", repo: "project", number: 18 }))
      .toBe("https://gitlab.example.com/team/sub/project/-/merge_requests/18");
  });

  it("does not classify an arbitrary hostname substring as GitLab", () => {
    expect(buildPullRequestReferenceUrl({ provider: "notgitlab.example.com", org: "team", repo: "project", number: 18 }))
      .toBe("https://notgitlab.example.com/team/project/pull/18");
  });
});
