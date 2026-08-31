import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  ALLOWED_LICENSE_IDS,
  SpdxParseError,
  checkNoticeDevDependencyLicenses,
  checkNpmDependencyLicenses,
  checkSurfaceCoverage,
  checkThirdPartyLicenseAllowlist,
  evaluateSpdxExpression,
  isPermissive,
  isStructuralToken,
  tokenizeSpdxExpression,
} from "./check-third-party-license-allowlist.mjs";
import {
  NOTICE_DEV_DEPENDENCIES,
  NOTICE_PNPM_ARGS,
  expandOptionalPlatformVariants,
  flattenLicenseReport,
} from "./generate-third-party-licenses.mjs";

/**
 * Build records the way the CLI does — through the generator's own flattener,
 * so a change to the report shape breaks these tests rather than letting them
 * pass against a shape production never sees.
 */
function records(licenseToPackages) {
  const report = {};
  for (const [license, names] of Object.entries(licenseToPackages)) {
    report[license] = names.map((name) => ({
      name,
      versions: ["1.0.0"],
      paths: ["/tmp/x"],
    }));
  }
  return flattenLicenseReport(report);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The license headings of the committed notice's Dependency Summary.
 *
 * The generator underlines each heading with a run of `~` exactly as long as
 * the heading, which is the only thing distinguishing a heading from the `- `
 * package lines around it.
 */
function readCommittedNoticeLicenses() {
  const notice = readFileSync(join(repoRoot, "THIRD_PARTY_LICENSES"), "utf8");
  const summary = notice.split("\nDependency Summary\n")[1]?.split("\nLicense Texts\n")[0];
  if (summary === undefined) {
    throw new Error("THIRD_PARTY_LICENSES has no Dependency Summary section");
  }
  const lines = summary.split("\n");
  return lines.filter(
    (line, index) => line.length > 0 && lines[index + 1] === "~".repeat(line.length),
  );
}

const temporaryDirectories = [];

function createTemporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "pwragent-license-allowlist-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SPDX evaluation", () => {
  const allow = (id) => id === "MIT" || id === "Apache-2.0" || id === "BSD-2-Clause";

  it("passes a bare allowed identifier and fails a bare disallowed one", () => {
    expect(evaluateSpdxExpression("MIT", allow)).toBe(true);
    expect(evaluateSpdxExpression("GPL-3.0", allow)).toBe(false);
  });

  it("satisfies OR from either side, so a dual license passes on its good half", () => {
    // This is why WTFPL never needs allowlisting: "(MIT OR WTFPL)" lets us take
    // the MIT option. Collapsing OR to AND here would fail a real dependency.
    expect(evaluateSpdxExpression("(MIT OR WTFPL)", allow)).toBe(true);
    expect(evaluateSpdxExpression("(BSD-2-Clause OR MIT OR Apache-2.0)", allow)).toBe(true);
    expect(evaluateSpdxExpression("(GPL-3.0 OR AGPL-3.0)", allow)).toBe(false);
  });

  it("requires both sides of AND, so a permissive half cannot launder a copyleft half", () => {
    expect(evaluateSpdxExpression("Apache-2.0 AND MIT", allow)).toBe(true);
    expect(evaluateSpdxExpression("Apache-2.0 AND GPL-3.0", allow)).toBe(false);
  });

  it("binds AND tighter than OR, per SPDX", () => {
    // MIT OR (Apache-2.0 AND GPL-3.0) is satisfiable; (MIT OR Apache-2.0) AND
    // GPL-3.0 is not. Getting the precedence backwards would accept the latter.
    expect(evaluateSpdxExpression("MIT OR Apache-2.0 AND GPL-3.0", allow)).toBe(true);
    expect(evaluateSpdxExpression("(MIT OR Apache-2.0) AND GPL-3.0", allow)).toBe(false);
  });

  it("recognizes operators case-insensitively", () => {
    expect(evaluateSpdxExpression("MIT or GPL-3.0", allow)).toBe(true);
    expect(evaluateSpdxExpression("MIT and GPL-3.0", allow)).toBe(false);
  });

  it("handles nested parentheses", () => {
    expect(evaluateSpdxExpression("((MIT))", allow)).toBe(true);
    expect(evaluateSpdxExpression("(MIT OR (Apache-2.0 AND GPL-3.0))", allow)).toBe(true);
  });

  it("splits parens that are flush against identifiers", () => {
    expect(tokenizeSpdxExpression("(MIT OR WTFPL)")).toEqual(["(", "MIT", "OR", "WTFPL", ")"]);
  });

  it("shares one structural-token predicate between the parser and the reporter", () => {
    // Sharing one predicate is the point: when they diverge, a failure message
    // can name "OR" as though it were a rejected license identifier.
    for (const token of ["(", ")", "OR", "AND", "or", "and"]) {
      expect(isStructuralToken(token), token).toBe(true);
    }
    for (const token of ["MIT", "GPL-3.0", "WITH"]) {
      expect(isStructuralToken(token), token).toBe(false);
    }
  });

  it("throws on an unparseable expression rather than guessing", () => {
    // "SEE LICENSE IN ..." and a dangling operator must not silently evaluate
    // to true on some substring. For a legal gate, refusing to guess is the
    // safe direction.
    expect(() => evaluateSpdxExpression("MIT OR", allow)).toThrow(SpdxParseError);
    expect(() => evaluateSpdxExpression("(MIT", allow)).toThrow(SpdxParseError);
    expect(() => evaluateSpdxExpression("AND MIT", allow)).toThrow(SpdxParseError);
    expect(() => evaluateSpdxExpression("SEE LICENSE IN LICENSE.md", allow)).toThrow(
      SpdxParseError,
    );
  });

  it("throws on a WITH exception instead of reading it as its bare license", () => {
    // "MIT WITH <exception>" must not be accepted as plain MIT — the exception
    // is the part that changes the terms.
    expect(() => evaluateSpdxExpression("MIT WITH Classpath-exception-2.0", allow)).toThrow(
      SpdxParseError,
    );
  });

  it("throws on an empty or whitespace-only license", () => {
    expect(() => evaluateSpdxExpression("", allow)).toThrow(SpdxParseError);
    expect(() => evaluateSpdxExpression("   ", allow)).toThrow(SpdxParseError);
  });
});

describe("case folding", () => {
  it("matches SPDX identifiers case-insensitively, per the spec", () => {
    // A package declaring "license": "mit" is legal SPDX and exists in the
    // wild. Matching case-sensitively would turn that into a red build with no
    // fix short of allowlisting a lowercase duplicate.
    expect(isPermissive("MIT")).toBe(true);
    expect(isPermissive("mit")).toBe(true);
    expect(isPermissive("Apache-2.0")).toBe(true);
    expect(isPermissive("APACHE-2.0")).toBe(true);
  });

  it("does not let a disallowed id through in any casing", () => {
    for (const id of ["GPL-3.0", "gpl-3.0", "Gpl-3.0", "AGPL-3.0", "agpl-3.0"]) {
      expect(isPermissive(id), id).toBe(false);
    }
  });

  it("passes a lowercase declaration end to end", () => {
    expect(checkNpmDependencyLicenses(records({ mit: ["lowercase-dep"] }))).toEqual([]);
  });
});

describe("npm dependency licenses", () => {
  it("passes the license set the production tree actually declared when the gate was written", () => {
    expect(
      checkNpmDependencyLicenses(
        records({
          MIT: ["react"],
          "Apache-2.0": ["typescript"],
          ISC: ["semver"],
          "BSD-2-Clause": ["dotenv"],
          "BSD-3-Clause": ["source-map"],
          "BlueOak-1.0.0": ["jackspeak"],
          "Python-2.0": ["argparse"],
          "(MIT OR WTFPL)": ["expand-template"],
          "(BSD-2-Clause OR MIT OR Apache-2.0)": ["rc"],
        }),
      ),
    ).toEqual([]);
  });

  it("rejects a dependency that flipped from MIT to GPL", () => {
    // The scenario this gate exists for: the generator would happily transcribe
    // a new "GPL-3.0" section into THIRD_PARTY_LICENSES and `--check` would
    // then pass, because the committed file matches the generated one.
    const failures = checkNpmDependencyLicenses(records({ "GPL-3.0": ["some-dep"] }));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/some-dep@1\.0\.0/);
    expect(failures[0]).toMatch(/GPL-3\.0/);
    expect(failures[0]).toMatch(/not on the allowlist/);
  });

  it("warns against allowlisting a copyleft failure to go green", () => {
    const [failure] = checkNpmDependencyLicenses(records({ "AGPL-3.0-only": ["some-dep"] }));
    expect(failure).toMatch(/copyleft/);
    expect(failure).toMatch(/do not allowlist it to make CI green/);
  });

  it("gives LGPL the same copyleft steer as GPL and AGPL", () => {
    // An anchored pattern misses "LGPL-3.0-or-later", and the reader loses the
    // one line telling them not to allowlist their way out.
    const [failure] = checkNpmDependencyLicenses(records({ "LGPL-3.0-or-later": ["some-dep"] }));
    expect(failure).toMatch(/do not allowlist it to make CI green/);
  });

  it("rejects a transitive GPL dep dragged in by a bump", () => {
    const failures = checkNpmDependencyLicenses(
      records({ MIT: ["react", "hono"], "GPL-2.0-or-later": ["sneaky-transitive"] }),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/sneaky-transitive/);
  });

  it("rejects weak copyleft, which is permitted nowhere in this tree", () => {
    // PwrAgent ships no LGPL slice and the notice carries no FSF text or
    // written source offer, so an LGPL arrival has nothing to disclose with.
    const failures = checkNpmDependencyLicenses(records({ "LGPL-3.0-or-later": ["some-dep"] }));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/LGPL-3\.0-or-later/);
  });

  it("rejects a source-available license", () => {
    const failures = checkNpmDependencyLicenses(
      records({ "BUSL-1.1": ["source-available-dep"], "SSPL-1.0": ["mongo-ish"] }),
    );
    expect(failures).toHaveLength(2);
  });

  it("rejects an unresolvable license string", () => {
    const failures = checkNpmDependencyLicenses(
      records({ UNLICENSED: ["private-thing"], "SEE LICENSE IN LICENSE.md": ["vague-thing"] }),
    );
    expect(failures).toHaveLength(2);
    expect(failures.join("\n")).toMatch(/private-thing/);
    expect(failures.join("\n")).toMatch(/not a parseable SPDX expression/);
  });

  it("names every offending dependency, not just the first", () => {
    const failures = checkNpmDependencyLicenses(records({ "GPL-3.0": ["one", "two"], MIT: ["ok"] }));
    expect(failures).toHaveLength(2);
  });

  it("names only the identifiers that were actually rejected", () => {
    // In "Apache-2.0 AND GPL-3.0" the Apache half is fine; listing it as an
    // offender would send the reader after the wrong license.
    const [failure] = checkNpmDependencyLicenses(
      records({ "Apache-2.0 AND GPL-3.0": ["mixed-dep"] }),
    );
    expect(failure).toMatch(/GPL-3\.0 is not on the allowlist/);
  });
});

describe("shipped devDependencies", () => {
  it("gates Electron even though --prod never reports it", () => {
    // Electron is a devDependency that ships, so the generator merges it in
    // from the `all` report. Reading only the production report would leave the
    // single largest shipped component with an unchecked license.
    expect(NOTICE_DEV_DEPENDENCIES.has("electron")).toBe(true);
    const failures = checkNoticeDevDependencyLicenses(records({ "GPL-3.0": ["electron"] }));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/electron/);
  });

  it("passes a permissive Electron", () => {
    expect(checkNoticeDevDependencyLicenses(records({ MIT: ["electron"] }))).toEqual([]);
  });

  it("does not gate devDependencies the notice does not disclose", () => {
    // Dev-only tooling does not ship, so its license is out of scope; gating it
    // would turn an unrelated GPL dev tool into a failed build.
    expect(checkNoticeDevDependencyLicenses(records({ "GPL-3.0": ["some-dev-tool"] }))).toEqual([]);
  });

  it("says which surface a failing record came from", () => {
    // An offender named without that context sends the reader looking through
    // the production tree for something `--prod` never reports.
    const [failure] = checkNoticeDevDependencyLicenses(records({ "GPL-3.0": ["electron"] }));
    expect(failure).toMatch(/^shipped devDependency electron@/);
  });
});

describe("notice coverage", () => {
  it("reads the same pnpm reports the generator builds the notice from", () => {
    // A gate that queried a different surface would report a pass for records
    // the notice never contained.
    expect(NOTICE_PNPM_ARGS.production).toEqual(["--prod"]);
    expect(NOTICE_PNPM_ARGS.all).toEqual([]);
  });

  it("allows every license the committed notice actually discloses", () => {
    // Closes the loop against the artifact rather than against the tree. The
    // gate's input set is meant to match what the notice contains, but that is
    // a claim about the generator's sources — if a future change adds a fourth
    // one, the notice gains a heading this gate never judged and `--check`
    // still passes because committed matches generated. This reads the
    // committed file, so it catches that with no install and no pnpm run.
    const disclosed = readCommittedNoticeLicenses();
    expect(disclosed.length).toBeGreaterThan(0);
    for (const declaredLicense of disclosed) {
      expect(
        evaluateSpdxExpression(declaredLicense, isPermissive),
        `THIRD_PARTY_LICENSES discloses ${declaredLicense}, which the gate does not allow`,
      ).toBe(true);
    }
  });

  it("gates the synthesized platform variants through their parent record", () => {
    // expandOptionalPlatformVariants adds the per-platform packages this
    // machine's install does not materialize. They copy declaredLicense from
    // the parent, so gating the production report gates them too — this asserts
    // that inheritance, because if a variant ever carried a license of its own
    // the notice would disclose a string this gate never judged.
    const directory = createTemporaryDirectory();
    const packagePath = join(directory, "example-native");
    mkdirSync(packagePath, { recursive: true });
    writeFileSync(
      join(packagePath, "package.json"),
      JSON.stringify({
        name: "example-native",
        version: "1.2.3",
        optionalDependencies: { "example-native-win32-x64": "1.2.3" },
      }),
    );

    const expanded = expandOptionalPlatformVariants([
      {
        name: "example-native",
        version: "1.2.3",
        declaredLicense: "GPL-3.0",
        packagePath,
      },
    ]);

    expect(expanded.map((record) => record.name)).toContain("example-native-win32-x64");
    expect(new Set(expanded.map((record) => record.declaredLicense))).toEqual(new Set(["GPL-3.0"]));
  });
});

describe("surface coverage", () => {
  const present = {
    productionRecords: records({ MIT: ["react"] }),
    allRecords: records({ MIT: ["electron"] }),
  };

  it("passes when every surface produced records", () => {
    expect(checkSurfaceCoverage(present)).toEqual([]);
  });

  it("fails an empty production report instead of reporting a clean tree", () => {
    // Zero records yield zero allowlist failures, so without this the gate
    // prints a pass having judged nothing at all.
    const [failure] = checkSurfaceCoverage({ ...present, productionRecords: [] });
    expect(failure).toMatch(/judged nothing/);
    expect(failure).toMatch(/pnpm install/);
  });

  it("fails when a NOTICE_DEV_DEPENDENCIES name is missing from the all report", () => {
    // Electron is the entire reason that surface exists. A filter or rename
    // that hides it would otherwise leave the largest shipped component ungated
    // while the gate kept printing an unqualified pass.
    const [failure] = checkSurfaceCoverage({ ...present, allRecords: records({ MIT: ["react"] }) });
    expect(failure).toMatch(/electron/);
    expect(failure).toMatch(/NOTICE_DEV_DEPENDENCIES/);
  });

  it("reports each missing surface separately", () => {
    expect(checkSurfaceCoverage({ productionRecords: [], allRecords: [] })).toHaveLength(
      1 + NOTICE_DEV_DEPENDENCIES.size,
    );
  });

  it("treats omitted surfaces as missing rather than as satisfied", () => {
    expect(checkSurfaceCoverage()).toHaveLength(1 + NOTICE_DEV_DEPENDENCIES.size);
  });
});

describe("allowlist contents", () => {
  it("carries no copyleft or source-available identifier", () => {
    for (const id of ALLOWED_LICENSE_IDS) {
      expect(id).not.toMatch(/GPL|SSPL|BUSL|Commons-Clause|Elastic|RSAL/i);
    }
  });

  it("carries only identifiers that parse as a bare SPDX identifier", () => {
    // An entry with a stray operator or paren could never match a declaration,
    // so it would sit on the list looking like coverage it does not provide.
    for (const id of ALLOWED_LICENSE_IDS) {
      expect(tokenizeSpdxExpression(id), id).toEqual([id]);
      expect(isStructuralToken(id), id).toBe(false);
    }
  });
});

describe("combined check", () => {
  it("reports npm and devDependency failures together, sorted", () => {
    const failures = checkThirdPartyLicenseAllowlist({
      productionRecords: records({ "GPL-3.0": ["zzz-dep"] }),
      allRecords: records({ "GPL-3.0": ["electron"] }),
    });
    expect(failures).toHaveLength(2);
    expect(failures).toEqual([...failures].sort((a, b) => a.localeCompare(b)));
  });

  it("produces no failures for a clean tree", () => {
    expect(
      checkThirdPartyLicenseAllowlist({
        productionRecords: records({ MIT: ["react"] }),
        allRecords: records({ MIT: ["electron"] }),
      }),
    ).toEqual([]);
  });

  it("defaults omitted surfaces to empty rather than throwing", () => {
    expect(checkThirdPartyLicenseAllowlist()).toEqual([]);
  });
});
