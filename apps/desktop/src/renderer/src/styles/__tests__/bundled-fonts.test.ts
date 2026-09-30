import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A bundled face is drawn only when some rule asks for it by the exact family
 * name its `@font-face` registers. Nothing warns when the two disagree: the
 * face is never requested, never loads, and text falls through to the next
 * family on the stack. `@fontsource/geist-sans` registers "Geist Sans", not
 * upstream's "Geist". PwrGit shipped asking for "Geist" through 0.17.0, and
 * its sans text drew in the platform UI font the whole time. PwrAgent asked
 * for "Geist" with no bundle at all: CDP's `CSS.getPlatformFontsForNode`
 * reported every sans node in `.SF NS` and every mono node in Menlo.
 *
 * So the family names are read out of the `@fontsource` CSS that fonts.css
 * imports, never restated here: a package that renames its family fails this
 * test instead of a screenshot. `document.fonts.check()` cannot stand in for
 * it, because it answers true for a family no face in the set matches.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const stylesDir = path.resolve(testDir, "..");
const require = createRequire(import.meta.url);

/** Strip comments so a family named in prose isn't mistaken for a rule. */
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const unquote = (family: string): string =>
  family.trim().replace(/^(["'])(.*)\1$/, "$2");

const fontsCss = strip(readFileSync(path.join(stylesDir, "fonts.css"), "utf8"));
const appCss = strip(readFileSync(path.join(stylesDir, "app.css"), "utf8"));

/** Both spellings CSS allows: `@import "x.css"` and `@import url("x.css")`.
 *  A form this missed would drop its families from the check silently. */
const IMPORT = /@import\s+(?:url\(\s*)?["']([^"']+)["']/g;
const imports = [...fontsCss.matchAll(IMPORT)].map((m) => m[1]!);

/** The families each imported stylesheet registers, resolved the way Vite
 *  resolves the `@import`: through the package's own `exports`. */
const registered = imports.map((spec) => {
  const css = strip(readFileSync(require.resolve(spec), "utf8"));
  const families = [
    ...css.matchAll(/@font-face\s*\{[^}]*?font-family:\s*([^;]+);/g),
  ].map((m) => unquote(m[1]!));
  return { spec, families: [...new Set(families)] };
});

const FONT_TOKENS = ["--font-sans", "--font-mono"] as const;

/** EVERY stack a token is declared with, first family first, not just the
 *  dark `:root` one. A theme block that redeclares a token with a wrong lead
 *  is this same bug in a theme a single-block check would never see. */
function stacks(token: string): string[][] {
  const declared = [
    ...appCss.matchAll(new RegExp(`${token}\\s*:\\s*([^;]+);`, "g")),
  ];
  if (declared.length === 0) {
    throw new Error(`${token} is not declared in app.css`);
  }
  return declared.map((m) => m[1]!.split(",").map(unquote));
}

const STACKS = new Map(FONT_TOKENS.map((token) => [token, stacks(token)]));

describe("bundled fonts", () => {
  it("imports fonts.css ahead of every other rule in app.css", () => {
    // An @import after any other rule is invalid CSS and is dropped, so the
    // faces would never register.
    expect(appCss.trimStart()).toMatch(/^@import\s+["']\.\/fonts\.css["'];/);
  });

  it("reads at least one @font-face out of every stylesheet fonts.css imports", () => {
    // Without this, a package that moved its faces elsewhere would leave
    // nothing to check and the test below would pass vacuously.
    expect(imports.length).toBeGreaterThan(0);
    // ...and no @import was skipped by the form it was written in.
    expect(imports).toHaveLength((fontsCss.match(/@import\b/g) ?? []).length);
    for (const { spec, families } of registered) {
      expect(families, spec).not.toHaveLength(0);
    }
  });

  it.each(
    [...new Set(registered.flatMap(({ families }) => families))].map(
      (family) => [family],
    ),
  )("a font token leads with the bundled family %s", (family) => {
    // Leads, not merely names: a family ahead of the bundled one that happens
    // to be installed would mask the bundle on that machine only.
    const leads = FONT_TOKENS.filter((token) =>
      STACKS.get(token)!.every((declared) => declared[0] === family),
    );
    expect(
      leads,
      `no font token leads with "${family}" in every block that declares it; `
        + `stacks are ${JSON.stringify(Object.fromEntries(STACKS))}`,
    ).toHaveLength(1);
  });

  it("routes every monospace rule through --font-mono", () => {
    // Five rules once bypassed the token: one hard-coded an IBM Plex Mono
    // stack, four read `--font-monospace`, which nothing defines. They drew
    // in the platform mono beside the bundled Geist Mono.
    const monoFamilies = [...appCss.matchAll(/font-family:\s*([^;]+);/g)]
      .map((m) => m[1]!.trim())
      .filter((value) => /mono/i.test(value));
    expect(monoFamilies.length).toBeGreaterThan(0);
    for (const value of monoFamilies) {
      expect(value).toMatch(/^var\(--font-mono[,)]/);
    }
    expect(appCss).not.toContain("--font-monospace");
  });
});
