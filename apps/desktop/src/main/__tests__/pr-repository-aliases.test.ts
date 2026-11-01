import { describe, expect, it } from "vitest";
import { buildPullRequestStatusKey, type PrSummary } from "@pwragent/shared";
import { PullRequestRepositoryAliases } from "../pr-status/pr-repository-aliases";

function pr(url: string, overrides: Partial<PrSummary> = {}): PrSummary {
  const [, org = "", repo = "", number = "0"] = url.match(/^https:\/\/[^/]+\/(.+)\/([^/]+)\/(?:-\/merge_requests|pull)\/(\d+)$/) ?? [];
  return {
    provider: new URL(url).hostname,
    org,
    repo,
    number: Number(number),
    state: "pending",
    checkState: "pending",
    lifecycleState: "open",
    reviewState: "ready_for_review",
    mergeState: "unknown",
    url,
    ...overrides,
  };
}

const OLD_URL = "https://github.com/pwrdrvr/PwrAgnt/pull/3179";
const NEW_URL = "https://github.com/pwrdrvr/PwrAgent/pull/3179";

describe("PullRequestRepositoryAliases", () => {
  it("learns a rename only when the forge answers for the same provider and number", () => {
    const aliases = new PullRequestRepositoryAliases();

    expect(aliases.learn(OLD_URL, pr("https://github.com/pwrdrvr/PwrAgent/pull/3180"))).toBe(false);
    expect(aliases.learn(OLD_URL, pr("https://ghe.example.test/pwrdrvr/PwrAgent/pull/3179"))).toBe(false);
    expect(aliases.learn(OLD_URL, undefined)).toBe(false);
    expect(aliases.learn("not a url", pr(NEW_URL))).toBe(false);
    expect(aliases.canonicalize(pr(OLD_URL)).url).toBe(OLD_URL);

    expect(aliases.learn(OLD_URL, pr(NEW_URL))).toBe(true);
    expect(aliases.learn(OLD_URL, pr(NEW_URL))).toBe(false);

    const canonical = aliases.canonicalize(pr(OLD_URL, { explicitlyAttached: true, title: "Kept" }));
    expect(canonical).toMatchObject({
      provider: "github.com",
      org: "pwrdrvr",
      repo: "PwrAgent",
      number: 3179,
      url: NEW_URL,
      explicitlyAttached: true,
      title: "Kept",
    });
    expect(buildPullRequestStatusKey(canonical)).toBe("github.com/pwrdrvr/pwragent#3179");
    // Every PR in the renamed repository shares the answer.
    expect(aliases.canonicalize(pr("https://github.com/pwrdrvr/PwrAgnt/pull/3171")).url)
      .toBe("https://github.com/pwrdrvr/PwrAgent/pull/3171");
    expect(aliases.canonicalizeUrl("https://github.com/pwrdrvr/pwragnt/pull/12"))
      .toBe("https://github.com/pwrdrvr/PwrAgent/pull/12");
  });

  it("treats a letter-case difference as the same repository but adopts the forge's casing", () => {
    const aliases = new PullRequestRepositoryAliases();
    const lowercase = "https://github.com/pwrdrvr/pwragent/pull/3179";

    expect(aliases.learn(lowercase, pr(NEW_URL))).toBe(false);
    expect(aliases.canonicalizeKey("github.com/pwrdrvr/pwragent#3179")).toBe("github.com/pwrdrvr/pwragent#3179");
    expect(aliases.canonicalize(pr(lowercase))).toMatchObject({ repo: "PwrAgent", url: NEW_URL });
  });

  it("rewrites a GitLab subgroup key by its whole repository prefix", () => {
    const aliases = new PullRequestRepositoryAliases();

    expect(aliases.learn(
      "https://gitlab.com/group/sub/old-repo/-/merge_requests/7",
      pr("https://gitlab.com/group/sub/new-repo/-/merge_requests/7"),
    )).toBe(true);

    expect(aliases.canonicalizeKey("gitlab.com/group/sub/old-repo#7")).toBe("gitlab.com/group/sub/new-repo#7");
    expect(aliases.canonicalizeKey("gitlab.com/group/sub/old-repo#12")).toBe("gitlab.com/group/sub/new-repo#12");
    expect(aliases.canonicalizeKey("gitlab.com/group/sub/old-repo-extra#7")).toBe("gitlab.com/group/sub/old-repo-extra#7");
    expect(aliases.canonicalizeKey("gitlab.com/group/old-repo#7")).toBe("gitlab.com/group/old-repo#7");
    expect(aliases.canonicalize(pr("https://gitlab.com/group/sub/old-repo/-/merge_requests/9")).url)
      .toBe("https://gitlab.com/group/sub/new-repo/-/merge_requests/9");
  });

  it("leaves unknown repositories untouched", () => {
    const aliases = new PullRequestRepositoryAliases();
    aliases.learn(OLD_URL, pr(NEW_URL));
    const other = pr("https://github.com/pwrdrvr/PwrSnap/pull/5");

    expect(aliases.canonicalize(other)).toBe(other);
    expect(aliases.canonicalizeKey("github.com/pwrdrvr/pwrsnap#5")).toBe("github.com/pwrdrvr/pwrsnap#5");
    expect(aliases.canonicalizeUrl(other.url)).toBe(other.url);
    expect(aliases.canonicalizeKey("not-a-key")).toBe("not-a-key");
  });

  it("follows a second rename and a rename back without looping", () => {
    const aliases = new PullRequestRepositoryAliases();
    aliases.learn("https://github.com/acme/one/pull/1", pr("https://github.com/acme/two/pull/1"));
    aliases.learn("https://github.com/acme/two/pull/1", pr("https://github.com/acme/three/pull/1"));

    expect(aliases.canonicalizeUrl("https://github.com/acme/one/pull/4")).toBe("https://github.com/acme/three/pull/4");

    aliases.learn("https://github.com/acme/three/pull/1", pr("https://github.com/acme/one/pull/1"));

    expect(aliases.canonicalizeUrl("https://github.com/acme/one/pull/4")).toBe("https://github.com/acme/one/pull/4");
    expect(aliases.canonicalizeUrl("https://github.com/acme/two/pull/4")).toBe("https://github.com/acme/one/pull/4");
    expect(aliases.canonicalizeUrl("https://github.com/acme/three/pull/4")).toBe("https://github.com/acme/one/pull/4");
  });

  it("canonicalizes a source repository that names the renamed repository", () => {
    const aliases = new PullRequestRepositoryAliases();
    aliases.learn(OLD_URL, pr(NEW_URL));

    expect(aliases.canonicalize(pr(OLD_URL, {
      sourceRepository: { provider: "github.com", org: "pwrdrvr", repo: "PwrAgnt" },
    })).sourceRepository).toEqual({ provider: "github.com", org: "pwrdrvr", repo: "PwrAgent" });
    expect(aliases.canonicalize(pr(OLD_URL, {
      sourceRepository: { provider: "github.com", org: "contributor", repo: "PwrAgnt" },
    })).sourceRepository).toEqual({ provider: "github.com", org: "contributor", repo: "PwrAgnt" });
  });
});
