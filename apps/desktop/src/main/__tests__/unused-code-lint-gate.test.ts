// Pins the unused-code lint gate: the rule severity in `eslint.config.mjs`
// and the file coverage in `lint:eslint:cached`.
//
// Both halves fail silently when they regress. `@typescript-eslint/no-unused-vars`
// spent its whole life at "warn", and because neither ESLint invocation passes
// `--max-warnings 0`, a dead import printed a line in the CI log and the `Lint`
// job stayed green. Narrowing the glob back to `apps/*/src/**` is the same
// shape: everything passes, and `e2e/`, `scripts/`, `eval/` and the root
// configs quietly stop being linted. Neither edit breaks a test unless one
// exists to break, which is the same reasoning AGENTS.md records for the
// `NOTICE_PNPM_FILTER` selector.
//
// The third case is different — it makes CI fail, but for the wrong reason.
// ESLint exits 2 on a CLI pattern that matches no file, with "Please check for
// typing mistakes in the pattern". `*.ts` is kept non-empty by exactly one
// file, so the day the root's last TypeScript file is renamed the whole lint
// run dies pointing at a typo that does not exist. Better to fail here, naming
// the real cause. Today that file happens to be `vitest.workspace.ts`, whose
// removal would take the suite with it — the assertion is for the general
// case, after Vitest 4's `projects` key retires that particular filename.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);

type FlatConfigEntry = {
  rules?: Record<string, unknown>;
};

// Evaluated, not read as text: a rule moved into a different config object is
// still the same effective rule, and a regex over the source would miss that.
// The specifier is built at runtime because `eslint.config.mjs` ships no
// declaration file, so a static import of it fails `tsc` under this repo's
// `strict`.
const eslintConfig = (
  (await import(
    pathToFileURL(path.join(repoRoot, "eslint.config.mjs")).href
  )) as { default: FlatConfigEntry[] }
).default;

function unusedVarsSeverities(): unknown[] {
  return eslintConfig
    .map((entry) => entry.rules?.["@typescript-eslint/no-unused-vars"])
    .filter((rule): rule is unknown[] => Array.isArray(rule))
    .map(([severity]) => severity);
}

function lintPatterns(): string[] {
  const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  // Quoted CLI globs only — flags and their values are not file patterns.
  return [...manifest.scripts["lint:eslint:cached"].matchAll(/"([^"]+)"/g)]
    .map((match) => match[1]!);
}

describe("unused-code lint gate", () => {
  it("keeps no-unused-vars blocking rather than advisory", () => {
    const severities = unusedVarsSeverities();

    expect(severities.length).toBeGreaterThan(0);
    for (const severity of severities) expect(severity).toBe("error");
  });

  it("keeps the underscore escape hatch on all three binding kinds", () => {
    const options = eslintConfig
      .map((entry) => entry.rules?.["@typescript-eslint/no-unused-vars"])
      .filter((rule): rule is [string, Record<string, string>] =>
        Array.isArray(rule) && typeof rule[1] === "object")
      .map(([, entryOptions]) => entryOptions);

    expect(options.length).toBeGreaterThan(0);
    for (const entryOptions of options) {
      // AGENTS.md documents `_name` as the way to mark a binding intentionally
      // unused. Dropping one of these patterns would make that advice wrong
      // for one binding kind only — the quietest possible way to break it.
      expect(entryOptions.argsIgnorePattern).toBe("^_");
      expect(entryOptions.varsIgnorePattern).toBe("^_");
      expect(entryOptions.caughtErrorsIgnorePattern).toBe("^_");
    }
  });

  it("lints every app directory, not just src", () => {
    // `apps/*/src/**` is the pre-gate glob. It reached no e2e spec, no build
    // script, and none of the hand-written helpers under `e2e/fixtures/` that
    // eslint.config.mjs already claimed were linted.
    expect(lintPatterns()).toContain("apps/*/**/*.{ts,tsx}");
  });

  it("keeps the root-level pattern matching at least one file", () => {
    const rootTypeScript = readdirSync(repoRoot).filter((entry) =>
      entry.endsWith(".ts"),
    );

    // Exactly the semantics of the non-recursive `*.ts` CLI pattern.
    expect(lintPatterns()).toContain("*.ts");
    expect(rootTypeScript).not.toHaveLength(0);
  });
});
