import { readFileSync } from "node:fs";

// The release writes pwragentRelease: { tag, commit } into the published
// manifest. A checkout has none, so only string fields are reported.
export function versionInfo(pkg) {
  const source = pkg.pwragentRelease;
  const release = {};
  if (typeof source?.tag === "string") release.tag = source.tag;
  if (typeof source?.commit === "string") release.commit = source.commit;
  return { name: pkg.name, version: pkg.version, ...(Object.keys(release).length ? { release } : {}) };
}

// Read on each call from this package's own manifest, so the CLI reports the
// files currently installed. The daemon reads it once at startup instead.
export function packageVersion() {
  return versionInfo(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));
}

// The version fields that status compares, without the package name.
export function installedVersion() {
  const { version, release } = packageVersion();
  return { version, ...(release ? { release } : {}) };
}

export function formatVersion({ name, version, release }) {
  const details = [release?.tag, release?.commit && `commit ${release.commit}`].filter(Boolean);
  return details.length ? `${name} ${version} (${details.join(", ")})` : `${name} ${version}`;
}

// A daemon that predates version reporting returns no running version. It is
// older than this installation, so it needs a restart too.
export function restartRequired(running, installed) {
  return !running
    || running.version !== installed.version
    || running.release?.commit !== installed.release?.commit;
}
