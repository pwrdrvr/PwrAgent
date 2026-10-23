import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const inside = (root, value) => value === root || value.startsWith(root + path.sep);
const credentials = new Set(["auth.json", "credentials.json", "credentials", ".codex", ".pwragent", ".ssh", ".aws", ".netrc", ".npmrc", ".git-credentials", ".env", "id_rsa", "id_ed25519"]);
function safeName(name) {
  const parts = name.split(/[\\/]/);
  if (path.isAbsolute(name) || parts.includes("..") || parts.some((part) => credentials.has(part.toLowerCase()))) throw new Error("Unsafe artifact path or credential path");
}

// Read only a regular HEAD/loose ref, never git config, objects, hooks, logs,
// symlink metadata or external worktree pointers. Missing provenance is OK.
function repositoryHead(directory) {
  const read = (name) => {
    safeName(name);
    let file = directory;
    for (const part of name.split("/")) {
      file = path.join(file, part);
      if (lstatSync(file).isSymbolicLink()) throw new Error("Linked Git metadata");
    }
    const info = lstatSync(file);
    if (!info.isFile() || info.size > 4096) throw new Error("Invalid Git metadata");
    return readFileSync(file, "utf8").trim();
  };
  try {
    let head = read("HEAD");
    if (head.startsWith("ref: refs/heads/")) head = read(head.slice(5));
    return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) ? head : undefined;
  } catch { return undefined; }
}

export function stageTaskExports(root, stage, names, redact) {
  root = realpathSync(root);
  stage = realpathSync(stage);
  const manifest = { repositories: [], omitted: [], entries: [] };
  function walk(name) {
    safeName(name);
    const source = path.resolve(root, name);
    const target = path.resolve(stage, name);
    if (!inside(root, source) || !inside(stage, target) || source === root || realpathSync(path.dirname(source)) !== path.dirname(source)) throw new Error("Unsafe artifact path");
    const info = lstatSync(source);
    if (path.basename(source) === ".git") {
      if (info.isDirectory()) manifest.repositories.push({ path: path.relative(root, path.dirname(source)), head: repositoryHead(source) });
      manifest.omitted.push({ path: name, reason: "git-private-state" });
      return;
    }
    if (path.relative(root, source).split(path.sep).includes(".git")) throw new Error("Unsafe artifact path through Git state");
    mkdirSync(path.dirname(target), { recursive: true });
    if (info.isSymbolicLink()) {
      const link = readlinkSync(source);
      const resolved = path.resolve(path.dirname(source), link);
      if (path.isAbsolute(link) || redact(link) !== link || !inside(root, resolved) || !inside(root, realpathSync(source))) throw new Error("Unsafe artifact symlink");
      safeName(path.relative(root, resolved));
      safeName(path.relative(root, realpathSync(source)));
      if (path.relative(root, resolved).split(path.sep).includes(".git") || path.relative(root, realpathSync(source)).split(path.sep).includes(".git")) throw new Error("Unsafe artifact symlink to Git state");
      symlinkSync(link, target);
    } else if (info.isDirectory()) {
      mkdirSync(target, { recursive: true, mode: info.mode & 0o777 });
      for (const entry of readdirSync(source).sort()) walk(path.join(name, entry));
    } else if (info.isFile()) {
      writeFileSync(target, Buffer.from(redact(readFileSync(source).toString("latin1")), "latin1"), { mode: info.mode & 0o777 });
    } else throw new Error("Unsupported artifact file type");
  }
  for (const name of names) {
    walk(name);
    if (path.basename(path.resolve(name)) !== ".git") manifest.entries.push(name);
  }
  return manifest;
}
