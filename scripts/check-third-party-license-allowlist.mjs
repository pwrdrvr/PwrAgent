#!/usr/bin/env node

/**
 * Gate the licenses in THIRD_PARTY_LICENSES against an explicit allowlist.
 *
 * This is the check that `generate-third-party-licenses.mjs` deliberately is
 * not. That script is a transcriber: it asks pnpm what the tree declares and
 * writes it into THIRD_PARTY_LICENSES verbatim, grouping by whatever license
 * string it is handed. It never judges the string. So before this gate existed,
 * a dependency flipping MIT -> GPL-3.0 (or a transitive GPL dep arriving in a
 * Dependabot bump) produced a new "GPL-3.0" section in the notice, and
 * `licenses:check` then PASSED, because the committed file matched the
 * generated one. Green CI, copyleft shipped, nobody told.
 *
 * `check-package-licenses.mjs` does not cover it either: that script walks our
 * own workspace package.json files and asserts each declares MIT. It never
 * looks at a dependency.
 *
 * The only safety net was that a human might notice a new license heading in a
 * PR diff. That is thin for a hand-run generator and worth nothing at all once
 * regeneration is automated on Dependabot branches.
 *
 * ## What is covered, exactly
 *
 * The scope is "the records the notice is built from", because that is the
 * artifact this gate protects. The generator's `main()` assembles those from
 * three sources, and this gate reads the two that introduce a license string:
 *
 * 1. The npm production tree (`pnpm licenses list --prod --filter
 *    @pwragent/desktop`) — the surface that moves on its own under Dependabot.
 * 2. `NOTICE_DEV_DEPENDENCIES` from the `all` report. The generator pulls
 *    Electron in from there because Electron is a devDependency that ships;
 *    reading only the production report would leave the single largest shipped
 *    component ungated. Both sides import the same set, so they cannot drift.
 * 3. `expandOptionalPlatformVariants`, which synthesizes the per-platform
 *    variants of a package (`@esbuild/win32-x64` and friends) that this
 *    machine's install does not materialize. Those synthesized records COPY
 *    `declaredLicense` from the parent record in surface 1, so they introduce
 *    no license string of their own and gating surface 1 gates them. This gate
 *    is in fact slightly stricter than the notice here: where the production
 *    report already contains the current platform's variant, the expansion
 *    replaces it with the parent's license, while this gate still judges the
 *    variant's own declared license.
 *
 * NOT covered, and deliberately so:
 *
 * - **devDependencies other than `NOTICE_DEV_DEPENDENCIES`.** They do not ship
 *   and the notice does not disclose them, so a GPL build-time tool is not a
 *   distribution problem. A dev tool that starts shipping must be added to
 *   `NOTICE_DEV_DEPENDENCIES` to be both disclosed AND gated.
 * - **Components inside Electron** (Chromium and Node.js runtime code). The
 *   notice discloses Electron's own MIT license and points at Chromium's
 *   upstream generated credits, which are about 18 MB for the pinned runtime.
 *   pnpm reports one license for the electron package; nothing here can see
 *   inside it.
 * - **Codex App Server Rust crates.** PwrAgent invokes a locally installed
 *   Codex App Server rather than vendoring those crates, so they are neither in
 *   this npm tree nor in the notice.
 *
 * Strong copyleft (GPL, AGPL), weak copyleft that imposes a source offer
 * (LGPL), and source-available terms (BSL, SSPL, Commons Clause) are permitted
 * nowhere. Neither is an unresolvable string like "UNLICENSED" or "SEE LICENSE
 * IN ...", which fails to parse and is reported.
 */

import { fileURLToPath } from "node:url";

import {
  NOTICE_DEV_DEPENDENCIES,
  NOTICE_PNPM_ARGS,
  flattenLicenseReport,
  runPnpmLicenses,
} from "./generate-third-party-licenses.mjs";

/**
 * SPDX identifiers that may appear anywhere the notice covers.
 *
 * Seeded from what the tree actually declared when this gate was written, plus
 * the permissive ids PwrDrvr documents as always-allowed. Those two sets were
 * not the same, in both directions:
 *
 * - `BlueOak-1.0.0` and `Python-2.0` were already in the shipped tree and
 *   documented nowhere. Nothing was enforcing a policy, so nobody had to decide
 *   about them. Recorded explicitly now.
 * - `0BSD`, `CC0-1.0`, `MPL-2.0` and `Unlicense` are documented policy but are
 *   not in the production tree today. They are listed so a benign transitive
 *   arrival does not turn a green build red for a license already approved.
 *
 * Adding an id here is a deliberate legal decision. Make it explicitly, in a
 * commit that says why — do not add one to make CI green.
 */
export const ALLOWED_LICENSE_IDS = new Set([
  // Documented policy, and in the production tree today.
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  // In the production tree today, previously undocumented.
  //
  // Permissive, MIT-like with an explicit patent grant. Arrives transitively
  // through the npm tooling packages.
  "BlueOak-1.0.0",
  // Permissive, no copyleft clause. Arrives transitively via argparse.
  "Python-2.0",
  // Documented policy, not in the production tree today.
  "0BSD",
  "CC0-1.0",
  // File-level copyleft only: it binds the MPL-licensed files themselves and
  // places no condition on the larger work that includes them.
  "MPL-2.0",
  "Unlicense",
]);

/**
 * Matches GPL, AGPL and LGPL so a rejected copyleft id gets the "do not
 * allowlist this" steer. `[^A-Za-z]` rather than `\W` because the letter before
 * "GPL" is what distinguishes LGPL/AGPL from a word boundary.
 */
const COPYLEFT_PATTERN = /(^|[^A-Za-z])[AL]?GPL/i;

export class SpdxParseError extends Error {}

/**
 * SPDX short identifiers are case-insensitive, so every comparison folds case.
 * Without this a package declaring the perfectly legal `"license": "mit"` fails
 * the gate with no fix available short of allowlisting a lowercase duplicate.
 */
function foldCase(identifier) {
  return identifier.toLowerCase();
}

const ALLOWED_LICENSE_IDS_FOLDED = new Set(Array.from(ALLOWED_LICENSE_IDS, foldCase));

export function isPermissive(identifier) {
  return ALLOWED_LICENSE_IDS_FOLDED.has(foldCase(identifier));
}

/**
 * Split an SPDX expression into identifiers, operators and parens.
 */
export function tokenizeSpdxExpression(expression) {
  return expression
    .replaceAll("(", " ( ")
    .replaceAll(")", " ) ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * True for a token that is punctuation or an operator rather than a license id.
 *
 * Shared by the parser and by `disallowedIdentifiers` so the two cannot
 * disagree about what counts as an identifier — a disagreement would print an
 * operator in a failure message as though it were a rejected license.
 */
export function isStructuralToken(token) {
  const upper = token.toUpperCase();
  return token === "(" || token === ")" || upper === "OR" || upper === "AND";
}

/**
 * Evaluate an SPDX expression against a predicate over bare identifiers.
 *
 * OR is satisfied by either side and AND by both, per SPDX — which is what
 * makes "(MIT OR WTFPL)" pass without WTFPL being allowlisted (we take the MIT
 * option), while "Apache-2.0 AND GPL-3.0" correctly fails (we are bound by
 * both). AND binds tighter than OR.
 *
 * Anything that does not parse — "SEE LICENSE IN LICENSE.md", a bare
 * "UNLICENSED", a WITH exception — throws, and the caller reports it as a
 * failure. Refusing to guess is the safe direction for a legal gate.
 */
export function evaluateSpdxExpression(expression, isAllowed) {
  const tokens = tokenizeSpdxExpression(expression);
  let position = 0;

  const peek = () => tokens[position];

  const parseExpression = () => {
    let value = parseTerm();
    while (peek()?.toUpperCase() === "OR") {
      position += 1;
      // Parse before combining: `||` short-circuits, and a skipped parse would
      // leave the cursor mid-expression and mis-report the trailing-token check.
      const right = parseTerm();
      value = value || right;
    }
    return value;
  };

  const parseTerm = () => {
    let value = parseFactor();
    while (peek()?.toUpperCase() === "AND") {
      position += 1;
      const right = parseFactor();
      value = value && right;
    }
    return value;
  };

  const parseFactor = () => {
    const token = tokens[position];
    if (token === undefined) {
      throw new SpdxParseError(`unexpected end of expression in ${JSON.stringify(expression)}`);
    }
    if (token === "(") {
      position += 1;
      const value = parseExpression();
      if (tokens[position] !== ")") {
        throw new SpdxParseError(`unbalanced parentheses in ${JSON.stringify(expression)}`);
      }
      position += 1;
      return value;
    }
    if (isStructuralToken(token)) {
      throw new SpdxParseError(
        `unexpected ${JSON.stringify(token)} in ${JSON.stringify(expression)}`,
      );
    }
    position += 1;
    return isAllowed(token);
  };

  const value = parseExpression();
  if (position !== tokens.length) {
    throw new SpdxParseError(
      `trailing ${JSON.stringify(tokens[position])} in ${JSON.stringify(expression)}`,
    );
  }
  return value;
}

/**
 * The bare identifiers in an expression that the predicate rejects.
 *
 * Only meaningful once evaluation has already failed: in a satisfied OR the
 * rejected half is irrelevant, so naming it would misdirect the reader.
 */
export function disallowedIdentifiers(expression, isAllowed) {
  return Array.from(
    new Set(
      tokenizeSpdxExpression(expression).filter(
        (token) => !isStructuralToken(token) && !isAllowed(token),
      ),
    ),
  );
}

/**
 * Check one set of records against the allowlist.
 *
 * `subject` prefixes the label so a failure says which surface the record came
 * from — an offender named without that context sends the reader looking in the
 * production tree for a devDependency.
 */
function checkRecords(records, { subject = "" } = {}) {
  const failures = [];

  for (const record of records) {
    const label = `${subject}${record.name}@${record.version || "?"}`;
    let allowed;
    try {
      allowed = evaluateSpdxExpression(record.declaredLicense, isPermissive);
    } catch (error) {
      failures.push(
        `${label} declares ${JSON.stringify(record.declaredLicense)}, which is not a parseable `
          + `SPDX expression (${error.message}). A dependency whose license cannot be read `
          + `cannot be shipped.`,
      );
      continue;
    }
    if (allowed) continue;

    const offenders = disallowedIdentifiers(record.declaredLicense, isPermissive);
    const isCopyleft = offenders.some((id) => COPYLEFT_PATTERN.test(id));
    failures.push(
      `${label} declares ${JSON.stringify(record.declaredLicense)}; `
        + `${offenders.join(", ")} ${offenders.length === 1 ? "is" : "are"} not on the allowlist `
        + `in scripts/check-third-party-license-allowlist.mjs.`
        + (isCopyleft
          ? " This is a copyleft license — do not allowlist it to make CI green; drop or replace"
            + " the dependency, or escalate the licensing decision."
          : ""),
    );
  }

  return failures;
}

export function checkNpmDependencyLicenses(records) {
  return checkRecords(records);
}

/**
 * The devDependencies the notice discloses because they ship — Electron today.
 *
 * Filtered from the `all` report by the same set the generator merges them in
 * with, so the gate's coverage tracks the notice's contents.
 */
export function checkNoticeDevDependencyLicenses(allRecords) {
  return checkRecords(
    allRecords.filter((record) => NOTICE_DEV_DEPENDENCIES.has(record.name)),
    { subject: "shipped devDependency " },
  );
}

export function checkThirdPartyLicenseAllowlist({ productionRecords = [], allRecords = [] } = {}) {
  return [
    ...checkNpmDependencyLicenses(productionRecords),
    ...checkNoticeDevDependencyLicenses(allRecords),
  ].sort((a, b) => a.localeCompare(b));
}

function main() {
  // Two reports for the same reason the generator takes two: the production
  // tree, plus the `all` tree that Electron (a devDependency that ships) is
  // only visible in.
  const productionRecords = flattenLicenseReport(runPnpmLicenses(NOTICE_PNPM_ARGS.production));
  const allRecords = flattenLicenseReport(runPnpmLicenses(NOTICE_PNPM_ARGS.all));
  const failures = checkThirdPartyLicenseAllowlist({ productionRecords, allRecords });

  if (failures.length > 0) {
    console.error("third-party license allowlist check failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("third-party license allowlist check passed");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
