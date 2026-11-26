import { constants } from "node:fs";
import { open, opendir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppServerListSkillsResponse, AppServerSkillSummary } from "@pwragent/shared/contracts/normalized-app-server";
import { parse } from "yaml";

const PROJECT_CONFIG_NAMES = [".agents", ".agent", "_agents", "_agent"];
const MAX_SCAN_PATHS = 10_000;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_FRONTMATTER_BYTES = 32 * 1024;
const MAX_INHERIT_DEPTH = 10;
const SKILL_HEADER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m;

type Scope = "repo" | "antigravity-user";
type Filter = { include?: ReadonlySet<string>; exclude: ReadonlySet<string> };
type SkillSource = { plugin?: string; cliGlobal?: boolean; mentionOnly?: boolean };

const PLUGIN_MANIFESTS = [".antigravity-plugin/plugin.json", "plugin.json", ".gemini-plugin/plugin.json"];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

async function fileInfo(file: string) {
  return await stat(file).catch(() => undefined);
}

async function readPrefix(file: string, limit: number): Promise<string | undefined> {
  if (!(await fileInfo(file))?.isFile()) return undefined;
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => undefined);
  if (!handle) return undefined;
  try {
    const buffer = Buffer.alloc(limit);
    let length = 0;
    while (length < limit) {
      const { bytesRead } = await handle.read(buffer, length, limit - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return buffer.toString("utf8", 0, length);
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  const contents = await readPrefix(file, MAX_CONFIG_BYTES + 1);
  if (!contents || Buffer.byteLength(contents) > MAX_CONFIG_BYTES) return {};
  try {
    return asRecord(JSON.parse(contents));
  } catch {
    return {};
  }
}

async function readSkill(file: string, scope: Scope, plugin?: string): Promise<AppServerSkillSummary | undefined> {
  const contents = await readPrefix(file, MAX_FRONTMATTER_BYTES);
  const header = contents?.match(SKILL_HEADER);
  if (!header || header.index !== 0) return undefined;
  try {
    const { name: configuredName, description } = asRecord(parse(header[1], {
      schema: "failsafe",
      maxAliasCount: 0,
    }));
    const summary = typeof description === "string" ? description.trim() : undefined;
    const name = configuredName === undefined && summary
      ? path.basename(path.dirname(file))
      : configuredName;
    if (typeof name !== "string" || !/^[\p{L}\p{N}_-]+$/u.test(name)) return undefined;
    return {
      name: plugin ? `${plugin}:${name}` : name,
      ...(summary === undefined ? {} : { description: summary }),
      path: file,
      scope,
      enabled: true,
      ...(plugin ? { pluginId: plugin } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Match complete path segments, including when a manifest points straight at a skill file. */
function matchesFolderSuffix(patterns: ReadonlySet<string>, directory: string): boolean {
  if (patterns.size === 0) return false;
  const parts = directory.split(path.sep);
  let suffix = "";
  for (const part of parts.reverse()) {
    if (!part) break;
    suffix = suffix ? `${part}/${suffix}` : part;
    if (patterns.has(suffix)) return true;
  }
  return false;
}

function matchesFilters(filters: Filter[], directory: string): boolean {
  return filters.every(({ include, exclude }) =>
    (!include?.size || matchesFolderSuffix(include, directory)) && !matchesFolderSuffix(exclude, directory));
}

function entryFilter(entry: Record<string, unknown>): Filter {
  return { include: new Set(strings(entry.include_only)), exclude: new Set(strings(entry.exclude)) };
}

function isProjectConfigDirectory(directory: string): boolean {
  return PROJECT_CONFIG_NAMES.includes(path.basename(directory));
}

function currentUsername(): string | undefined {
  const username = process.platform === "win32" ? process.env.USERNAME : process.env.USER;
  if (username) return username;
  try {
    return os.userInfo().username || undefined;
  } catch {
    return undefined;
  }
}

async function workspaceAncestors(cwd: string, spendPath: () => void): Promise<string[]> {
  const ancestors = [cwd];
  for (let current = cwd; ; ) {
    // A linked Git worktree has a .git file, which is also a boundary.
    spendPath();
    if (await fileInfo(path.join(current, ".git"))) return ancestors;
    const parent = path.dirname(current);
    if (parent === current) return [cwd];
    ancestors.push(parent);
    current = parent;
  }
}

async function resolveEntry(base: string, repositoryRoot: string, rawPath: string): Promise<string> {
  const local = path.resolve(base, rawPath);
  return base === repositoryRoot || path.isAbsolute(rawPath) || await fileInfo(local)
    ? local
    : path.resolve(repositoryRoot, rawPath);
}

/** The ACP command list gives no distinction between a skill and a slash command,
 * and no file path. Resolve the paths on the thread owner's filesystem. */
export async function discoverAntigravitySkillCatalog(
  cwds: Array<string | undefined>,
): Promise<AppServerListSkillsResponse["data"]> {
  let remainingPaths = MAX_SCAN_PATHS;
  const spendPath = () => {
    if (remainingPaths === 0) throw new Error("Antigravity skill discovery exceeded its scan limit.");
    remainingPaths -= 1;
  };

  const workspaces = new Set<string>();
  for (const cwd of cwds) {
    spendPath();
    if (cwd?.trim()) workspaces.add(path.resolve(cwd));
  }
  const data: AppServerListSkillsResponse["data"] = [];
  // Process workspaces in order so all sources share one allowance and an
  // exhausted request has no scans still running in the background.
  for (const cwd of workspaces.size > 0 ? workspaces : [undefined]) {
    data.push({ cwd, skills: await discoverAntigravitySkills(cwd, spendPath) });
  }
  return data;
}

async function discoverAntigravitySkills(
  cwd: string | undefined,
  spendPath: () => void,
): Promise<AppServerSkillSummary[]> {
  const home = os.homedir();
  const gemini = path.join(home, ".gemini");
  const globalConfig = path.join(gemini, "config");
  const workspace = cwd ? await workspaceAncestors(cwd, spendPath) : [];
  const repo = workspace.at(-1);
  const projectConfigs = workspace.flatMap((directory) =>
    PROJECT_CONFIG_NAMES.map((name) => ({ directory: path.join(directory, name), base: directory })));
  if (repo) {
    spendPath();
    const { personal_customization_dir: personal } = await readJson(path.join(repo, ".gemini", "config.json"));
    if (typeof personal === "string" && personal) {
      const username = currentUsername();
      if (username) {
        const directory = path.resolve(repo, personal.replaceAll("{user}", username));
        projectConfigs.unshift(...PROJECT_CONFIG_NAMES.map((name) => ({ directory: path.join(directory, name), base: directory })));
      }
    }
  }
  const configs: Array<{ directory: string; base: string; scope: Scope; manifest: Record<string, unknown> }> = [];
  for (const config of [...projectConfigs, { directory: globalConfig, base: globalConfig }]) {
    spendPath();
    configs.push({
      ...config,
      scope: config.directory === globalConfig ? "antigravity-user" : "repo",
      manifest: await readJson(path.join(config.directory, "skills.json")),
    });
  }
  const excludes = new Set(configs.flatMap(({ manifest }) => strings(manifest.exclude)));
  const skills = new Map<string, AppServerSkillSummary>();

  async function children(directory: string): Promise<string[]> {
    spendPath();
    const entries = await opendir(directory).catch(() => undefined);
    if (!entries) return [];
    const names: string[] = [];
    for await (const entry of entries) {
      spendPath();
      if (entry.isDirectory() || entry.isSymbolicLink()) names.push(entry.name);
    }
    return names.sort();
  }

  async function add(file: string, scope: Scope, source: SkillSource = {}) {
    spendPath();
    if (!source.cliGlobal && matchesFolderSuffix(excludes, path.dirname(file))) return;
    const skill = await readSkill(file, scope, source.plugin);
    if (skill && (source.cliGlobal || !excludes.has(skill.name)) && !skills.has(skill.name)) {
      skills.set(skill.name, source.mentionOnly ? { ...skill, mentionOnly: true } : skill);
    }
  }

  async function scan(directory: string, scope: Scope, filters: Filter[] = [], source: SkillSource = {}) {
    spendPath();
    // Default discovery is one level deep. Manifest include_only can point
    // directly to a nested skill without recursively crawling the checkout.
    const nested = filters.flatMap(({ include }) => [...(include ?? [])])
      .filter((name) => name.includes("/") && !name.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\\")));
    const candidates = new Set([...(await children(directory)), ...nested]);
    for (const candidate of candidates) {
      const folder = path.join(directory, candidate);
      if (matchesFilters(filters, folder)) {
        await add(path.join(folder, "SKILL.md"), scope, source);
      }
    }
  }

  async function followManifest(
    manifest: Record<string, unknown>,
    base: string,
    repositoryRoot: string,
    scope: Scope,
    filters: Filter[],
    ancestors: string[],
  ): Promise<void> {
    if (ancestors.length > MAX_INHERIT_DEPTH) return;
    const activeFilters = [...filters, { exclude: new Set(strings(manifest.exclude)) }];
    for (const entry of records(manifest.inherits)) {
      if (typeof entry.path !== "string" || !entry.path) continue;
      spendPath();
      const file = await resolveEntry(base, repositoryRoot, entry.path);
      if (ancestors.includes(file)) continue;
      const parent = path.dirname(file);
      const inheritedBase = isProjectConfigDirectory(parent) ? path.dirname(parent) : parent;
      const inheritedRoot = (await workspaceAncestors(inheritedBase, spendPath)).at(-1) ?? inheritedBase;
      await followManifest(
        await readJson(file), inheritedBase, inheritedRoot, scope,
        [...activeFilters, entryFilter(entry)], [...ancestors, file],
      );
    }
    for (const entry of records(manifest.entries)) {
      if (typeof entry.path !== "string" || !entry.path) continue;
      spendPath();
      const target = await resolveEntry(base, repositoryRoot, entry.path);
      const entryFilters = [...activeFilters, entryFilter(entry)];
      if (path.basename(target).toLowerCase() === "skill.md") {
        if (matchesFilters(entryFilters, path.dirname(target))) await add(target, scope);
      } else {
        const direct = path.join(target, "SKILL.md");
        if ((await fileInfo(direct))?.isFile()) {
          if (matchesFilters(entryFilters, target)) await add(direct, scope);
        } else {
          await scan(target, scope, entryFilters);
        }
      }
    }
  }

  await scan(path.join(gemini, "antigravity-cli", "skills"), "antigravity-user", [], { cliGlobal: true });
  await scan(path.join(gemini, "skills"), "antigravity-user", [], { cliGlobal: true });
  for (const { directory, base, scope, manifest } of configs) {
    await scan(path.join(directory, "skills"), scope);
    await followManifest(manifest, base, (scope === "repo" && repo) || base, scope, [], [path.join(directory, "skills.json")]);
  }
  for (const directory of workspace) {
    await scan(path.join(directory, ".gemini", "skills"), "repo", [], { mentionOnly: true });
  }
  // Keep skills from the shared Agent Skills location available for explicit
  // mentions, even when Antigravity's own slash-command loader omits them.
  await scan(path.join(home, ".agents", "skills"), "antigravity-user", [], { mentionOnly: true });

  spendPath();
  const plugins = asRecord((await readJson(path.join(globalConfig, "config.json"))).plugins);
  const pluginRoots = [
    ...configs.map(({ directory, scope }) => ({ directory: path.join(directory, "plugins"), scope })),
    { directory: path.join(gemini, "antigravity-cli", "plugins"), scope: "antigravity-user" as const },
  ];
  for (const { directory, scope } of pluginRoots) {
    for (const folder of await children(directory)) {
      const root = path.join(directory, folder);
      let manifest: Record<string, unknown> = {};
      for (const location of PLUGIN_MANIFESTS) {
        spendPath();
        const file = path.join(root, location);
        if ((await fileInfo(file))?.isFile()) {
          manifest = await readJson(file);
          break;
        }
      }
      const name = manifest.name;
      if (typeof name !== "string" || !name.trim()) continue;
      const enabled = asRecord(plugins[name] ?? plugins[folder]).enabled;
      if (enabled === false || (enabled !== true && manifest.disabled === true)) continue;
      const extra = typeof manifest.skills === "string" ? [manifest.skills] : strings(manifest.skills);
      const roots = new Set(["skills"]);
      for (const entry of extra) {
        spendPath();
        if (!entry.trim() || path.isAbsolute(entry)) continue;
        const relative = path.relative(root, path.resolve(root, entry));
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
        roots.add(relative);
      }
      for (const relative of roots) {
        await scan(path.join(root, relative), scope, [], { plugin: name });
      }
    }
  }

  return [...skills.values()];
}
