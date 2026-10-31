import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { releaseMetadata } from "../packages/pwragent/scripts/release.mjs";

export function prepareReleasePackages(desktop, outpost, version = desktop.version) {
  const prepared = { ...outpost, version,
    publishConfig: { ...outpost.publishConfig, tag: version.includes("-") ? "next" : "latest" } };
  releaseMetadata(prepared, { desktopVersion: version });
  return { desktop: { ...desktop, version }, outpost: prepared };
}

export function releasePackageText(text, pkg) {
  const versioned = text.replace(/^(  "version": )"[^"]*"/m, `$1"${pkg.version}"`);
  return pkg.publishConfig ? versioned.replace(/("publishConfig": \{[^}]*"tag": )"[^"]*"/, `$1"${pkg.publishConfig.tag}"`) : versioned;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const desktopPath = new URL("../apps/desktop/package.json", import.meta.url);
  const outpostPath = new URL("../packages/pwragent/package.json", import.meta.url);
  const read = (file) => JSON.parse(readFileSync(file, "utf8"));
  const prepared = prepareReleasePackages(read(desktopPath), read(outpostPath), process.argv[2]);
  writeFileSync(desktopPath, releasePackageText(readFileSync(desktopPath, "utf8"), prepared.desktop));
  writeFileSync(outpostPath, releasePackageText(readFileSync(outpostPath, "utf8"), prepared.outpost));
  console.log(`Prepared desktop and Outpost ${prepared.desktop.version}; add the matching CHANGELOG.md entry`);
}
