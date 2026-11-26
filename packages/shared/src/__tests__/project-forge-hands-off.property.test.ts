import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROJECT_FORGE_AUTOMATION,
  findHandsOffMatch,
  handsOffLabelMatches,
  handsOffLabelRepositories,
  isDefaultProjectForgeAutomation,
  MAX_HANDS_OFF_RULES,
  normalizeHandsOffRepository,
  normalizeHandsOffRules,
  resolveProjectForgeAutomation,
} from "../project-forge-automation";

/**
 * Oracle: a backtracking wildcard matcher written without regular
 * expressions. `*` matches any run of characters, everything else matches
 * itself ignoring case.
 */
function wildcardOracle(pattern: string, text: string): boolean {
  const p = pattern.toLowerCase();
  const t = text.toLowerCase();
  const memo = new Map<string, boolean>();
  const at = (i: number, j: number): boolean => {
    const key = `${i},${j}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (i === p.length) result = j === t.length;
    else if (p[i] === "*") result = at(i + 1, j) || (j < t.length && at(i, j + 1));
    else result = j < t.length && p[i] === t[j] && at(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return at(0, 0);
}

// Regex metacharacters are in the alphabet on purpose: a pattern is text,
// never a regular expression.
const labelChar = fc.constantFrom("a", "B", ":", "-", "*", ".", "+", "?", "(", "[", "\\", "^", "$", "|", " ");
const label = fc.array(labelChar, { maxLength: 8 }).map((chars) => chars.join(""));
const repository = fc.tuple(
  fc.constantFrom("pingdotgg", "PwrDrvr", "group/sub"),
  fc.constantFrom("t3code", "T3Code", "PwrAgent"),
).map(([owner, repo]) => `${owner}/${repo}`);

describe("hands-off label patterns", () => {
  it("match exactly what a wildcard matcher matches, ignoring case", () => {
    fc.assert(fc.property(label, label, (pattern, text) => {
      expect(handsOffLabelMatches(pattern, text)).toBe(wildcardOracle(pattern, text));
    }), { numRuns: 100 });
  });

  it("match in linear time however many stars a pattern has", () => {
    // A backtracking `.*` per star took 49 s on this pair.
    const started = Date.now();
    expect(handsOffLabelMatches(`${"*a".repeat(60)}b`, "a".repeat(200))).toBe(false);
    expect(handsOffLabelMatches(`${"*a".repeat(60)}*`, "a".repeat(200))).toBe(true);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it("match long star-heavy patterns as the oracle does", () => {
    const starry = fc.array(fc.constantFrom("a", "*", "b"), { maxLength: 24 }).map((chars) => chars.join(""));
    const text = fc.array(fc.constantFrom("a", "b"), { maxLength: 30 }).map((chars) => chars.join(""));
    fc.assert(fc.property(starry, text, (pattern, value) => {
      expect(handsOffLabelMatches(pattern, value)).toBe(wildcardOracle(pattern, value));
    }), { numRuns: 100 });
  });

  it("match the label T3 Code uses for a takeover", () => {
    expect(handsOffLabelMatches("takeover:*", "takeover:in-progress")).toBe(true);
    expect(handsOffLabelMatches("takeover:*", "size:L")).toBe(false);
    expect(handsOffLabelMatches("takeover", "takeover:in-progress")).toBe(false);
  });
});

describe("findHandsOffMatch", () => {
  it("matches a PR only in the rule's repository, by any label the pattern matches", () => {
    fc.assert(fc.property(
      fc.array(fc.record({ repository, label: fc.option(label, { nil: undefined }) }), { maxLength: 4 }),
      repository,
      fc.option(fc.array(label, { maxLength: 4 }), { nil: undefined }),
      (rawRules, prRepository, labels) => {
        const automation = resolveProjectForgeAutomation({ handsOff: rawRules });
        const rules = automation.handsOff ?? [];
        const slash = prRepository.lastIndexOf("/");
        const pr = { org: prRepository.slice(0, slash), repo: prRepository.slice(slash + 1), ...(labels ? { labels } : {}) };
        const expected = rules.some((rule) =>
          rule.repository.toLowerCase() === prRepository.toLowerCase()
          && (!rule.label || (labels ?? []).some((name) => wildcardOracle(rule.label!, name))));
        const match = findHandsOffMatch(automation, pr);
        expect(match !== undefined).toBe(expected);
        if (match?.label !== undefined) {
          expect(labels).toContain(match.label);
          expect(wildcardOracle(match.rule.label!, match.label)).toBe(true);
        }
      },
    ), { numRuns: 100 });
  });

  it("never matches by a label rule when the poll did not read labels", () => {
    const automation = { handsOff: [{ repository: "pingdotgg/t3code", label: "*" }] };
    expect(findHandsOffMatch(automation, { org: "pingdotgg", repo: "t3code" })).toBeUndefined();
    expect(findHandsOffMatch(automation, { org: "pingdotgg", repo: "t3code", labels: ["any"] })?.label).toBe("any");
  });
});

describe("hands-off rule storage", () => {
  it("keeps a normalized rule list stable through a second resolve", () => {
    fc.assert(fc.property(fc.anything(), (value) => {
      const once = resolveProjectForgeAutomation({ handsOff: value });
      const twice = resolveProjectForgeAutomation(once);
      expect(twice).toEqual(once);
      expect((once.handsOff ?? []).length).toBeLessThanOrEqual(MAX_HANDS_OFF_RULES);
    }));
  });

  it("drops duplicates ignoring case, and treats an empty list as the defaults", () => {
    const rules = normalizeHandsOffRules([
      { repository: "pingdotgg/t3code", label: "takeover:*" },
      { repository: "PingDotGG/T3Code", label: "TAKEOVER:*" },
      { repository: "pingdotgg/t3code", label: "  " },
      { repository: "not-a-repository" },
    ]);
    expect(rules).toEqual([
      { repository: "pingdotgg/t3code", label: "takeover:*" },
      { repository: "pingdotgg/t3code" },
    ]);
    expect(isDefaultProjectForgeAutomation(resolveProjectForgeAutomation({ handsOff: [] }))).toBe(true);
    expect(isDefaultProjectForgeAutomation({ ...DEFAULT_PROJECT_FORGE_AUTOMATION, handsOff: rules })).toBe(false);
  });

  it("accepts a pasted repository URL", () => {
    expect(normalizeHandsOffRepository("https://github.com/pingdotgg/t3code.git/")).toBe("pingdotgg/t3code");
    expect(normalizeHandsOffRepository("gitlab.example.com")).toBeUndefined();
    expect(normalizeHandsOffRepository("group/sub/project")).toBe("group/sub/project");
    // As the Forge Automation subtitle shows a repository.
    expect(normalizeHandsOffRepository("github.com/canvas-org/canvas")).toBe("canvas-org/canvas");
    expect(normalizeHandsOffRepository("gitlab.example.com/group/sub/project")).toBe("group/sub/project");
    // A pasted PR, merge request or file URL keeps only its repository.
    expect(normalizeHandsOffRepository("https://github.com/canvas-org/canvas/pull/4127")).toBe("canvas-org/canvas");
    expect(normalizeHandsOffRepository("https://github.com/canvas-org/canvas/tree/main/src")).toBe("canvas-org/canvas");
    expect(normalizeHandsOffRepository("https://gitlab.example.com/group/sub/project/-/merge_requests/3"))
      .toBe("group/sub/project");
  });

  it("reads labels only for repositories with a label rule", () => {
    expect([...handsOffLabelRepositories([
      { handsOff: [{ repository: "PingDotGG/t3code", label: "takeover:*" }, { repository: "acme/widgets" }] },
      undefined,
    ])]).toEqual(["pingdotgg/t3code"]);
  });
});
