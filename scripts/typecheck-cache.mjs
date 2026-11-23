import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function readOptional(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

function workspaceDirectories(root) {
  const solution = readOptional(join(root, "tsconfig.typecheck.json"));
  const references = solution ? JSON.parse(solution).references ?? [] : [];
  return new Set([root, ...references.map(({ path }) => {
    const project = resolve(root, path);
    return path.endsWith(".json") ? dirname(project) : project;
  })]);
}

function cacheDirectory(workspace) {
  return join(workspace, "node_modules", ".cache", "pwragent-typecheck");
}

function resolvedDependency(workspace, name) {
  try {
    return realpathSync.native(join(workspace, "node_modules", name));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

function dependencyFingerprint(root, workspaces) {
  const installedModules = readOptional(join(root, "node_modules/.modules.yaml"));
  const virtualStoreDir = installedModules?.trimStart().startsWith("{")
    ? JSON.parse(installedModules).virtualStoreDir
    : undefined;
  const inputs = [
    readOptional(join(root, "pnpm-lock.yaml")),
    readOptional(join(root, "pnpm-workspace.yaml")),
    readOptional(join(root, ".npmrc")),
    installedModules,
    readOptional(resolve(root, "node_modules", virtualStoreDir ?? ".pnpm", "lock.yaml")),
  ];
  for (const workspace of workspaces) {
    const manifest = readOptional(join(workspace, "package.json"));
    const { dependencies, devDependencies, optionalDependencies, peerDependencies } = JSON.parse(manifest ?? "{}");
    const names = Object.keys({ ...dependencies, ...devDependencies, ...optionalDependencies, ...peerDependencies }).sort();
    inputs.push([workspace, manifest, names.map((name) => resolvedDependency(workspace, name))]);
  }
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
}

export function invalidateTypecheckCaches(root) {
  const workspaces = workspaceDirectories(root);
  const fingerprint = dependencyFingerprint(root, workspaces);
  const stamp = join(cacheDirectory(root), "dependencies.sha256");
  if (readOptional(stamp) === fingerprint) return;

  // A package-only check shares build info with the workspace check. Clear
  // every project's state before recording the new dependency graph.
  for (const workspace of workspaces) {
    const directory = cacheDirectory(workspace);
    for (const name of readdirSyncIfPresent(directory)) {
      if (name.endsWith(".tsbuildinfo")) rmSync(join(directory, name), { force: true });
    }
  }

  mkdirSync(dirname(stamp), { recursive: true });
  const pendingStamp = `${stamp}.${process.pid}`;
  try {
    writeFileSync(pendingStamp, fingerprint);
    renameSync(pendingStamp, stamp);
  } finally {
    rmSync(pendingStamp, { force: true });
  }
}

function readdirSyncIfPresent(directory) {
  try {
    return readdirSync(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return [];
  }
}

export function clearTypecheckCaches(root) {
  for (const workspace of workspaceDirectories(root)) {
    rmSync(cacheDirectory(workspace), { recursive: true, force: true });
  }
}
