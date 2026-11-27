import type { AppServerSkillSummary } from "@pwragent/shared/contracts/normalized-app-server";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { hydrateSkillLabelsWithMarkdown } from "../skill-mentions";

// Reference for the outgoing Markdown: each catalog entry sees the output
// of every earlier replacement, including any labels inside inserted links.
function sequentialMarkdown(draft: string, skills: AppServerSkillSummary[]): string {
  let output = draft;
  for (const { name, path } of skills) {
    if (path) {
      const token = ("$" + name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(^|\\s)${token}(?=$|\\s|[.,!?;:])`, "g");
      output = output.replace(pattern, (_, prefix: string) => `${prefix}[$${name}](${path})`);
    }
  }
  return output;
}

// Count the complete inputs given to each draft scan, including scans of inserted Markdown.
function measureHydration(draft: string, skills: AppServerSkillSummary[]) {
  const replace = vi.spyOn(String.prototype, "replace");
  const matchAll = vi.spyOn(String.prototype, "matchAll");
  try {
    const output = hydrateSkillLabelsWithMarkdown(draft, skills);
    let scanned = matchAll.mock.contexts.reduce<number>((sum, receiver) => sum + String(receiver).length, 0);
    replace.mock.calls.forEach(([, replacement], i) => {
      if (typeof replacement === "function") scanned += String(replace.mock.contexts[i]).length;
    });
    return { output, scanned };
  } finally {
    matchAll.mockRestore();
    replace.mockRestore();
  }
}

const name = fc.oneof(fc.string({ maxLength: 8 }), fc.constantFrom(
  "", "a", "a.b", "a:b", "a $b", "b", "b)", "[x]+", "😀", "$", "a\nb", "__proto__",
));
const separator = fc.constantFrom("", " ", "\n", "\u00a0", ".", ",", "!", "?", ";", ":", "/", ")");
const catalogAndDraft = fc.array(name, { minLength: 1, maxLength: 6 }).chain((names) => {
  const fromCatalog = fc.constantFrom(...names);
  const path = fc.oneof(fc.constant(undefined), fc.string({ maxLength: 12 }),
    fromCatalog.map((label) => `/dir $${label} !`));
  const part = fc.tuple(separator, fromCatalog, separator)
    .map(([before, label, after]) => `${before}$${label}${after}`);
  return fc.tuple(
    fc.array(fc.record({ name: fromCatalog, path }), { minLength: 1, maxLength: 8 }),
    fc.array(part, { minLength: 1, maxLength: 10 }).map((parts) => parts.join("")),
  );
});

describe("outgoing skill Markdown", () => {
  it("agrees exactly with catalog-ordered replacements", () => {
    fc.assert(fc.property(catalogAndDraft, ([skills, draft]) => {
      expect(hydrateSkillLabelsWithMarkdown(draft, skills)).toBe(sequentialMarkdown(draft, skills));
    }));
  });

  it("lets later duplicates hydrate labels exposed inside inserted paths", () => {
    const skills = [
      { name: "a", path: "/first $b !" },
      { name: "b", path: "/second $a !" },
      { name: "a", path: "/third" },
    ];
    expect(hydrateSkillLabelsWithMarkdown("$a", skills))
      .toBe("[$a](/first [$b](/second [$a](/third) !) !)");
  });

  it("uses the first eligible catalog entry at a punctuation boundary", () => {
    const skills = [
      { name: "ce" },
      { name: "ce", path: "/first" },
      { name: "ce:plan", path: "/long" },
      { name: "ce", path: "/duplicate" },
    ];
    expect(hydrateSkillLabelsWithMarkdown("$ce:plan, ($ce) [$ce](/link)", skills))
      .toBe("[$ce](/first):plan, ($ce) [$ce](/link)");
    expect(hydrateSkillLabelsWithMarkdown("$ce:plan!", [{ name: "ce:plan", path: "$&" }, ...skills]))
      .toBe("[$ce:plan]($&)!");
  });

  it("lets an earlier match to the right change a multi-word name to its left", () => {
    const skills = [
      { name: "b", path: "/b" },
      { name: "a $b", path: "/old" },
      { name: "a [$b](/b)", path: "/new" },
    ];
    expect(hydrateSkillLabelsWithMarkdown("$a $b", skills)).toBe("[$a [$b](/b)](/new)");
  });

  it("can match across the closing parenthesis inserted by an earlier skill", () => {
    const skills = [{ name: "a", path: "/dir $b" }, { name: "b).x", path: "/later" }];
    expect(hydrateSkillLabelsWithMarkdown("$a.x", skills)).toBe("[$a](/dir [$b).x](/later)");
  });

  it("skips a label at the start or end of an inserted path", () => {
    const skills = [{ name: "a", path: "$b $b! $b" }, { name: "b", path: "/b" }];
    expect(hydrateSkillLabelsWithMarkdown("$a", skills)).toBe("[$a]($b [$b](/b)! $b)");
  });

  it("renders only links reached from a bare label in the draft", () => {
    const skills = Array.from({ length: 40 }, (_, i) => ({ name: "a", path: `/${i} $a $a !` }));
    // The explicit chip is already Markdown. Eagerly expanding every unused
    // path would double the previous link at each duplicate catalog entry.
    expect(hydrateSkillLabelsWithMarkdown("[$a](/0)", skills)).toBe("[$a](/0)");
  });

  it("reads one draft plus the inserted links for independent multi-word and nested labels", () => {
    const skills = Array.from({ length: 32 }, (_, i) => ({
      name: `run s${i}`,
      path: i % 2 ? "/target" : `/dir $run s${i + 1} !`,
    }));
    const draft = skills.map(({ name }) => `$${name}`).join(" ");
    const { output, scanned } = measureHydration(draft, skills);
    const inserted = skills.reduce((sum, { name, path }) => sum + name.length + path.length + 5, 0);
    expect(output).toBe(sequentialMarkdown(draft, skills));
    expect(scanned).toBeLessThanOrEqual(draft.length + inserted);
  });

  it("scans at most one draft for independent labels as draft length and skill count grow", () => {
    for (const count of [16, 32, 64]) {
      const skills = Array.from({ length: count }, (_, i) => ({ name: `s${i}`, path: `/s/${i}` }));
      const labels = skills.map(({ name }) => `$${name}`).join(" ");
      for (const length of [labels.length, 512, 1024, 2048]) {
        const draft = length === labels.length ? labels : labels + " ".padEnd(length - labels.length, "x");
        const { output, scanned } = measureHydration(draft, skills);
        expect(output).toBe(sequentialMarkdown(draft, skills));
        expect(scanned, `${count} skills, ${length} draft characters`).toBeLessThanOrEqual(length);
      }
    }
  });
});
