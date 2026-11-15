import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerSkillSummary } from "../contracts/normalized-app-server";
import { classifySkillOrigin, withSkillOrigins } from "../skill-origin";

// PwrAgent writes its own skills to `<PwrAgent root>/skills/bundled` and hands
// that folder to Codex, which reports them with `scope: "user"`. The rule:
// a user-scope skill is a PwrAgent skill exactly when its path is inside the
// bundled root the caller configured. The root follows `PWRAGENT_HOME`, so it
// can sit anywhere; nothing here may assume `~/.pwragent`.

const segment = fc.stringMatching(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,11}$/);
const skillName = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/);

/** A PwrAgent root anywhere on disk, as `PWRAGENT_HOME` may put it. */
const pwragentRoot = fc
  .array(segment, { minLength: 1, maxLength: 5 })
  .map((segments) => `/${segments.join("/")}`);

/** Text that turns `.../skills/bundled` into a sibling folder, not a child. */
const siblingSuffix = fc.constantFrom("-old", "_v1", ".bak", "2", "x", "-");

type Placement =
  | { kind: "inside"; nested: string[] }
  | { kind: "sibling"; suffix: string }
  | { kind: "agents-home"; home: string[] }
  | { kind: "codex-home"; home: string[] }
  | { kind: "parent" };

const placement: fc.Arbitrary<Placement> = fc.oneof(
  fc.record({
    kind: fc.constant("inside" as const),
    nested: fc.array(segment, { maxLength: 2 }),
  }),
  fc.record({ kind: fc.constant("sibling" as const), suffix: siblingSuffix }),
  fc.record({
    kind: fc.constant("agents-home" as const),
    home: fc.array(segment, { minLength: 1, maxLength: 3 }),
  }),
  fc.record({
    kind: fc.constant("codex-home" as const),
    home: fc.array(segment, { minLength: 1, maxLength: 3 }),
  }),
  fc.record({ kind: fc.constant("parent" as const) }),
);

function skillPathFor(root: string, bundled: string, where: Placement, name: string): string {
  switch (where.kind) {
    case "inside":
      return [bundled, ...where.nested, name, "SKILL.md"].join("/");
    case "sibling":
      return `${bundled}${where.suffix}/${name}/SKILL.md`;
    case "agents-home":
      return `/${where.home.join("/")}/.agents/skills/${name}/SKILL.md`;
    case "codex-home":
      return `/${where.home.join("/")}/.codex/skills/${name}/SKILL.md`;
    case "parent":
      return `${root}/skills/${name}/SKILL.md`;
  }
}

/** The oracle: plain string containment on `/`-separated, slash-trimmed paths. */
function oracleInside(skillPath: string, bundled: string): boolean {
  const trimmedRoot = bundled.replace(/\/+$/, "");
  return skillPath.startsWith(`${trimmedRoot}/`);
}

describe("classifySkillOrigin with a bundled skill root", () => {
  it("labels a user skill PwrAgent exactly when it is inside the bundled root", () => {
    fc.assert(
      fc.property(
        pwragentRoot,
        placement,
        skillName,
        fc.boolean(),
        (root, where, name, trailingSlash) => {
          const bundled = `${root}/skills/bundled`;
          const configured = trailingSlash ? `${bundled}/` : bundled;
          const path = skillPathFor(root, bundled, where, name);
          const origin = classifySkillOrigin(
            { path, scope: "user" },
            [],
            { bundledSkillRoot: configured },
          );
          const inside = oracleInside(path, bundled);
          expect(origin?.kind === "pwragent").toBe(inside);
          if (inside) {
            expect(origin).toEqual({ kind: "pwragent", label: "PwrAgent" });
          } else if (path.includes("/.agents/skills/")) {
            expect(origin).toEqual({ kind: "personal", label: "Personal" });
          } else {
            expect(origin).toEqual({ kind: "codex-home", label: "Codex home" });
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it("never claims a skill when no bundled root is configured, as for a peer's skills", () => {
    fc.assert(
      fc.property(pwragentRoot, placement, skillName, (root, where, name) => {
        const path = skillPathFor(root, `${root}/skills/bundled`, where, name);
        const origin = classifySkillOrigin({ path, scope: "user" }, []);
        expect(origin?.kind).not.toBe("pwragent");
      }),
    );
  });

  it("keeps the scope rule: a repo, system, or plugin skill under the root is not relabelled", () => {
    const bundledSkillRoot = "/srv/pwragent-home/skills/bundled";
    const path = `${bundledSkillRoot}/tool-guide/SKILL.md`;
    expect(
      classifySkillOrigin({ path, scope: "system" }, [], { bundledSkillRoot })?.kind,
    ).toBe("built-in");
    expect(
      classifySkillOrigin({ path, scope: "user", pluginId: "p@m" }, [], { bundledSkillRoot })?.kind,
    ).toBe("plugin");
  });

  it("matches a Windows bundled root regardless of separator and case", () => {
    expect(
      classifySkillOrigin(
        { path: "C:\\Users\\Fixture\\.pwragent\\skills\\bundled\\tool-guide\\SKILL.md", scope: "user" },
        [],
        { bundledSkillRoot: "c:/users/fixture/.pwragent/skills/bundled" },
      ),
    ).toEqual({ kind: "pwragent", label: "PwrAgent" });
    expect(
      classifySkillOrigin(
        { path: "C:\\Users\\Fixture\\.pwragent\\skills\\bundled-old\\tool-guide\\SKILL.md", scope: "user" },
        [],
        { bundledSkillRoot: "C:\\Users\\Fixture\\.pwragent\\skills\\bundled" },
      )?.kind,
    ).toBe("codex-home");
  });

  it("threads the root through withSkillOrigins", () => {
    const [bundled, codexHome] = withSkillOrigins<AppServerSkillSummary>(
      [
        { name: "tool-guide", path: "/opt/pa/skills/bundled/tool-guide/SKILL.md", scope: "user" },
        { name: "notes", path: "/home/fixture/.codex/skills/notes/SKILL.md", scope: "user" },
      ],
      [],
      { bundledSkillRoot: "/opt/pa/skills/bundled" },
    );
    expect(bundled?.origin).toEqual({ kind: "pwragent", label: "PwrAgent" });
    expect(codexHome?.origin).toEqual({ kind: "codex-home", label: "Codex home" });
  });
});
