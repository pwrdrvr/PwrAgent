#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(repoRoot, "THIRD_PARTY_LICENSES");
const desktopFilter = "@pwragent/desktop";
const check = process.argv.includes("--check");

function runPnpmLicenses(args) {
  const result = spawnSync(
    "pnpm",
    ["licenses", "list", "--json", "--filter", desktopFilter, ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return JSON.parse(result.stdout);
}

function flattenLicenseReport(report) {
  const records = [];
  for (const [declaredLicense, entries] of Object.entries(report)) {
    for (const entry of entries) {
      const versions = entry.versions?.length ? entry.versions : [""];
      const paths = entry.paths?.length ? entry.paths : [undefined];
      for (let index = 0; index < versions.length; index += 1) {
        records.push({
          name: entry.name,
          version: versions[index] ?? versions[0] ?? "",
          declaredLicense,
          packagePath: paths[index] ?? paths[0],
          homepage: entry.homepage,
          author: entry.author,
          description: entry.description,
        });
      }
    }
  }
  return records;
}

function readPackageJson(packagePath) {
  if (!packagePath) {
    return undefined;
  }
  const packageJsonPath = join(packagePath, "package.json");
  if (!existsSync(packageJsonPath)) {
    return undefined;
  }
  return JSON.parse(readFileSync(packageJsonPath, "utf8"));
}

function normalizeRepository(repository) {
  const raw =
    typeof repository === "string"
      ? repository
      : repository && typeof repository.url === "string"
        ? repository.url
        : undefined;
  if (!raw) {
    return undefined;
  }
  return raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");
}

function npmPackageUrl(name) {
  return `https://www.npmjs.com/package/${encodeURIComponent(name).replace(
    "%40",
    "@",
  )}`;
}

function findLicenseFile(packagePath) {
  if (!packagePath || !existsSync(packagePath)) {
    return undefined;
  }
  const candidates = readdirSync(packagePath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^(licen[cs]e|copying|copyright)(?:[.-].*)?$/i.test(name))
    .sort((a, b) => a.localeCompare(b));
  return candidates[0] ? join(packagePath, candidates[0]) : undefined;
}

function formatAuthor(author) {
  if (!author) {
    return undefined;
  }
  if (typeof author === "string") {
    return author;
  }
  if (typeof author.name === "string") {
    return author.name;
  }
  return undefined;
}

function declaredLicenseFallbackText(record, packageJson) {
  if (record.declaredLicense === "MIT") {
    const holder = formatAuthor(packageJson?.author) ?? record.name;
    return `The installed package does not include a separate license file. Its package metadata declares MIT.

MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
  }

  return [
    `No license text file was found in the installed package for ${stableRecordKey(
      record,
    )}.`,
    `The package declares license: ${record.declaredLicense}.`,
  ].join("\n");
}

function normalizeLicenseText(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function stableRecordKey(record) {
  return `${record.name}@${record.version}`;
}

function enrichRecord(record) {
  const packageJson = readPackageJson(record.packagePath);
  const licensePath = findLicenseFile(record.packagePath);
  const licenseText = licensePath
    ? normalizeLicenseText(readFileSync(licensePath, "utf8"))
    : declaredLicenseFallbackText(record, packageJson);
  return {
    ...record,
    source:
      normalizeRepository(packageJson?.repository) ??
      packageJson?.homepage ??
      record.homepage ??
      npmPackageUrl(record.name),
    licenseFile: licensePath
      ? relative(record.packagePath, licensePath)
      : "package metadata",
    licenseText,
    licenseTextHash: createHash("sha256").update(licenseText).digest("hex"),
  };
}

function compareRecords(a, b) {
  return (
    a.name.localeCompare(b.name) ||
    a.version.localeCompare(b.version) ||
    a.declaredLicense.localeCompare(b.declaredLicense)
  );
}

const productionRecords = flattenLicenseReport(runPnpmLicenses(["--prod"]));
const allRecords = flattenLicenseReport(runPnpmLicenses([]));
const recordsByKey = new Map();

for (const record of productionRecords) {
  recordsByKey.set(stableRecordKey(record), record);
}

for (const record of allRecords) {
  if (record.name === "electron") {
    recordsByKey.set(stableRecordKey(record), record);
  }
}

const records = Array.from(recordsByKey.values()).sort(compareRecords).map(enrichRecord);

const recordsByLicense = new Map();
for (const record of records) {
  const group = recordsByLicense.get(record.declaredLicense) ?? [];
  group.push(record);
  recordsByLicense.set(record.declaredLicense, group);
}

const textGroups = new Map();
for (const record of records) {
  const group = textGroups.get(record.licenseTextHash) ?? {
    declaredLicenses: new Set(),
    records: [],
    text: record.licenseText,
    representative: record,
  };
  group.declaredLicenses.add(record.declaredLicense);
  group.records.push(record);
  textGroups.set(record.licenseTextHash, group);
}

const lines = [];
lines.push("PwrAgent Third-Party Licenses");
lines.push("==============================");
lines.push("");
lines.push("Generated by scripts/generate-third-party-licenses.mjs.");
lines.push("Do not edit this file manually; run `pnpm licenses:generate`.");
lines.push("");
lines.push("Scope");
lines.push("-----");
lines.push("");
lines.push(
  "This notice covers npm production dependencies for @pwragent/desktop plus the Electron runtime package.",
);
lines.push(
  "Electron includes Chromium and Node.js runtime components. PwrAgent includes Electron's MIT runtime license here; Chromium's generated credits are maintained upstream by Chromium/Electron and are intentionally not appended to this text notice because Electron's generated LICENSES.chromium.html is about 18 MB for the pinned runtime.",
);
lines.push(
  "For Chromium runtime credits, see https://source.chromium.org/chromium and Electron's packaged LICENSES.chromium.html in the corresponding Electron release.",
);
lines.push(
  "Codex App Server Rust dependency disclosures are maintained by the Codex distribution; PwrAgent invokes a local Codex App Server and does not vendor those Rust crates into this npm notice.",
);
lines.push("");
lines.push("Dependency Summary");
lines.push("------------------");
lines.push("");

for (const [declaredLicense, group] of Array.from(recordsByLicense.entries()).sort(
  ([a], [b]) => a.localeCompare(b),
)) {
  lines.push(`${declaredLicense}`);
  lines.push("~".repeat(declaredLicense.length));
  for (const record of group.sort(compareRecords)) {
    lines.push(`- ${stableRecordKey(record)} | ${record.source}`);
  }
  lines.push("");
}

lines.push("License Texts");
lines.push("-------------");
lines.push("");

const sortedTextGroups = Array.from(textGroups.values()).sort((a, b) => {
  const aFirst = a.records.slice().sort(compareRecords)[0];
  const bFirst = b.records.slice().sort(compareRecords)[0];
  return compareRecords(aFirst, bFirst);
});

for (const group of sortedTextGroups) {
  const appliesTo = group.records.slice().sort(compareRecords);
  const licenses = Array.from(group.declaredLicenses).sort().join(", ");
  lines.push(`${stableRecordKey(group.representative)} (${licenses})`);
  lines.push("-".repeat(`${stableRecordKey(group.representative)} (${licenses})`.length));
  lines.push("");
  lines.push("Applies to:");
  for (const record of appliesTo) {
    lines.push(`- ${stableRecordKey(record)} (${record.declaredLicense})`);
  }
  lines.push("");
  lines.push(`Representative file: ${stableRecordKey(group.representative)}/${group.representative.licenseFile}`);
  lines.push("");
  lines.push(group.text);
  lines.push("");
}

const output = `${lines.join("\n").replace(/[ \t]+$/gm, "").trimEnd()}\n`;

if (check) {
  const current = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
  if (current !== output) {
    console.error(
      "THIRD_PARTY_LICENSES is out of date. Run `pnpm licenses:generate` and commit the result.",
    );
    process.exit(1);
  }
  console.log("third-party license notice check passed");
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, output);
  console.log(`wrote ${relative(repoRoot, outputPath)} (${records.length} packages)`);
}
