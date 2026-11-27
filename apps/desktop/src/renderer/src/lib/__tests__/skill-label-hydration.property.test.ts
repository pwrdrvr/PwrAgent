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

  it("scans at most one draft for independent labels as draft length and skill count grow", () => {
    for (const count of [16, 32, 64]) {
      const skills = Array.from({ length: count }, (_, i) => ({ name: `s${i}`, path: `/s/${i}` }));
      const labels = skills.map(({ name }) => `$${name}`).join(" ");
      for (const length of [labels.length, 512, 1024, 2048]) {
        const draft = length === labels.length ? labels : labels + " ".padEnd(length - labels.length, "x");
        const replace = vi.spyOn(String.prototype, "replace");
        let scanned = 0;
        let output: string;
        try {
          output = hydrateSkillLabelsWithMarkdown(draft, skills);
          // Count the receivers of text rewrites. Escaping an individual
          // regex literal uses a string replacement and never sees the draft.
          replace.mock.calls.forEach(([, replacement], i) => {
            if (typeof replacement === "function") {
              scanned += String(replace.mock.contexts[i]).length;
            }
          });
        } finally {
          replace.mockRestore();
        }
        expect(output).toBe(sequentialMarkdown(draft, skills));
        expect(scanned, `${count} skills, ${length} draft characters`).toBeLessThanOrEqual(length);
      }
    }
  });
});
