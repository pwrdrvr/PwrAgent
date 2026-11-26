import fs from "node:fs";
import path from "node:path";

const CANDIDATE_PACKAGE_GLOBS = [
  "packages",
  path.join("packages", "messaging"),
  path.join("packages", "messaging", "providers"),
];

const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", ".cjs", ".json"];

function resolveFileCandidate(basePath) {
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = `${basePath}${ext}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
    for (const indexName of ["index.ts", "index.tsx", "index.mts", "index.mjs", "index.js"]) {
      const candidate = path.join(basePath, indexName);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
  }
  return null;
}

function selectExportTarget(target) {
  if (typeof target === "string") return target;
  if (target && typeof target === "object" && !Array.isArray(target)) {
    return selectExportTarget(target.import ?? target.default ?? target.node ?? target.require);
  }
  return null;
}

/**
 * Discover every workspace package manifest under `repoRoot/packages/**`.
 */
export function discoverWorkspacePackages(repoRoot) {
  const packages = new Map();
  for (const parentRel of CANDIDATE_PACKAGE_GLOBS) {
    const parentDir = path.join(repoRoot, parentRel);
    if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) continue;
    for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgDir = path.join(parentDir, entry.name);
      const manifestPath = path.join(pkgDir, "package.json");
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const pkg = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        if (typeof pkg.name === "string" && pkg.name.startsWith("@pwragent/")) {
          packages.set(pkg.name, { dir: pkgDir, pkg });
        }
      } catch {
        // Ignore malformed manifests.
      }
    }
  }
  return packages;
}

/**
 * Resolve any `@pwragent/*` workspace import strictly within `repoRoot`
 * (never through donor checkout `node_modules` symlinks).
 */
export function resolveWorkspacePackageSpecifier(specifier, repoRoot, workspaceMap) {
  if (!specifier.startsWith("@pwragent/")) return null;

  if (specifier.startsWith("@pwragent/desktop-main/")) {
    const subpath = specifier.slice("@pwragent/desktop-main/".length);
    return resolveFileCandidate(path.join(repoRoot, "apps", "desktop", "src", "main", subpath));
  }

  let matchedName = null;
  for (const name of workspaceMap.keys()) {
    if (specifier === name || specifier.startsWith(`${name}/`)) {
      if (!matchedName || name.length > matchedName.length) {
        matchedName = name;
      }
    }
  }
  if (!matchedName) return null;

  const { dir, pkg } = workspaceMap.get(matchedName);
  const subpath = specifier === matchedName ? "." : `./${specifier.slice(matchedName.length + 1)}`;
  const exportsField = pkg.exports;

  if (typeof exportsField === "string") {
    if (subpath === ".") {
      return resolveFileCandidate(path.resolve(dir, exportsField));
    }
    return null;
  }

  if (exportsField && typeof exportsField === "object" && !Array.isArray(exportsField)) {
    if (Object.prototype.hasOwnProperty.call(exportsField, subpath)) {
      const target = selectExportTarget(exportsField[subpath]);
      if (target) {
        const resolved = resolveFileCandidate(path.resolve(dir, target));
        if (resolved) return resolved;
      }
    }
    for (const [pattern, rawTarget] of Object.entries(exportsField)) {
      const starIdx = pattern.indexOf("*");
      if (starIdx === -1) continue;
      const prefix = pattern.slice(0, starIdx);
      const suffix = pattern.slice(starIdx + 1);
      if (subpath.startsWith(prefix) && subpath.endsWith(suffix)
        && subpath.length >= prefix.length + suffix.length) {
        const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
        const targetTemplate = selectExportTarget(rawTarget);
        if (!targetTemplate) continue;
        const target = targetTemplate.replace("*", matched);
        const resolved = resolveFileCandidate(path.resolve(dir, target));
        if (resolved) return resolved;
      }
    }
  }

  if (subpath === "." && typeof pkg.main === "string") {
    return resolveFileCandidate(path.resolve(dir, pkg.main));
  }

  if (subpath !== ".") {
    return resolveFileCandidate(path.resolve(dir, "src", subpath.slice(2)));
  }

  return resolveFileCandidate(path.join(dir, "src", "index"));
}
