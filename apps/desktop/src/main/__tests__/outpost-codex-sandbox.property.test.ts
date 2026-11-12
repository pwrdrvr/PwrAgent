import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildCodexClientArgs } from "../app-server/codex-thread-config";
import {
  OUTPOST_CODEX_CREDENTIAL_ENTRIES,
  OUTPOST_CODEX_PRIVATE_ENTRIES,
  OUTPOST_CODEX_PRIVATE_GLOBS,
  OUTPOST_MANAGED_CONFIG_KEYS,
  OUTPOST_PERMISSION_PROFILE_IDS,
  createOutpostCodexMessageRewriter,
} from "../headless/outpost-codex-sandbox";
import { createOutpostRuntimePolicy } from "../owner-runtime-policy";

// Rule: no Codex sandbox an Outpost generates lets an agent command reach the
// Outpost's control channel, the secret beside it, or the Codex credentials.
// Agent commands run as the Outpost's own Unix user, so only the sandbox can
// keep them out of `<root>/profiles/<profile>/state`, which holds
// `headless/rpc.sock`, `headless-secret.key` and the state database it
// unlocks, and out of the Codex home's credentials, configuration,
// transcripts, logs and SQLite state. The rest of the Codex home (skills,
// plugin skills, memories, generated images, shell snapshots, the
// `apply_patch` helper) stays readable: the model and every command use it.
// No agent command may write the Codex home, from any workspace the rewriter
// lets through: a planted skill, hook or AGENTS.md would steer Codex itself.
//
// `effectiveAccess` models how Codex resolves a profile's filesystem entries:
// the most specific matching entry wins; at equal specificity deny beats write
// beats read. Codex expands a glob entry to the files it matches when each
// command starts, so a match is as specific as the file itself. Codex 0.159.2 and 0.164.0 behaved this way in a disposable
// Outpost container, including a workspace root inside a denied directory
// regaining write access, which is why the rewriter refuses one.

type Toml = string | boolean | number | { [key: string]: Toml };

/** Parses the inline-table subset the Outpost emits: basic strings, bare keys, integers, booleans, tables. */
function parseToml(source: string): Toml {
  let index = 0;
  const skip = () => { while (source[index] === " ") index++; };
  const string = (): string => {
    const start = index++;
    while (source[index] !== "\"") index += source[index] === "\\" ? 2 : 1;
    return JSON.parse(source.slice(start, ++index)) as string;
  };
  const value = (): Toml => {
    skip();
    if (source[index] === "\"") return string();
    if (source.startsWith("true", index)) { index += 4; return true; }
    if (source.startsWith("false", index)) { index += 5; return false; }
    const integer = /^\d+/.exec(source.slice(index));
    if (integer) { index += integer[0].length; return Number(integer[0]); }
    if (source[index] !== "{") throw new Error(`Unexpected TOML at ${index}: ${source}`);
    index++;
    const table: Record<string, Toml> = {};
    skip();
    while (source[index] !== "}") {
      skip();
      const bare = /^[A-Za-z0-9_-]+/.exec(source.slice(index));
      const key = bare ? (index += bare[0].length, bare[0]) : string();
      skip();
      if (source[index++] !== "=") throw new Error(`Expected = in ${source}`);
      table[key] = value();
      skip();
      if (source[index] === ",") index++;
      skip();
    }
    index++;
    return table;
  };
  const result = value();
  if (index !== source.length) throw new Error(`Trailing TOML: ${source}`);
  return result;
}

function launchOverrides(args: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "-c") continue;
    const override = args[++index]!;
    const separator = override.indexOf("=");
    values.set(override.slice(0, separator), override.slice(separator + 1));
  }
  return values;
}

type Access = "read" | "write" | "deny";
const STRENGTH: Record<Access, number> = { read: 0, write: 1, deny: 2 };

function within(target: string, root: string): boolean {
  return target === root || root === "/" || target.startsWith(root + "/");
}

function effectiveAccess(filesystem: Record<string, Toml>, target: string, workspaceRoots: readonly string[]): Access | undefined {
  // Uncapped, Linux expands a glob into every subdirectory, including ones
  // the profile masks, which aborts every command.
  if (Object.keys(filesystem).some((key) => key.includes("*"))) expect(filesystem.glob_scan_max_depth).toBe(1);
  const entries: Array<[string, Access]> = [];
  for (const [key, access] of Object.entries(filesystem)) {
    if (key === "glob_scan_max_depth") {
      // `*` below never crosses a slash, which is what a depth of 1 gives.
      expect(access).toBe(1);
      continue;
    }
    if (key === ":workspace_roots") {
      for (const [sub, nested] of Object.entries(access as Record<string, Toml>)) {
        for (const root of workspaceRoots) entries.push([path.posix.join(root, sub), nested as Access]);
      }
    } else if (key === ":root") entries.push(["/", access as Access]);
    else if (key.startsWith(":")) throw new Error(`Unmodelled special path ${key}`);
    else if (key.includes("*")) {
      const pattern = new RegExp(`^${key.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
      if (pattern.test(target)) entries.push([target, access as Access]);
    } else entries.push([key, access as Access]);
  }
  let best: [number, Access] | undefined;
  for (const [root, access] of entries) {
    if (!within(target, root)) continue;
    const depth = root === "/" ? 0 : root.split("/").length;
    if (!best || depth > best[0] || (depth === best[0] && STRENGTH[access] > STRENGTH[best[1]])) best = [depth, access];
  }
  return best?.[1];
}

const segment = fc.oneof(
  fc.stringMatching(/^[A-Za-z0-9_-]{1,10}$/),
  // Stresses TOML quoting of real directory names.
  fc.constantFrom("with space", "quote\"d", "eq=ls", "com,ma", "br{ace}", "unié", "back\\slash"),
);
const absolutePath = fc.array(segment, { minLength: 1, maxLength: 4 }).map((parts) => "/" + parts.join("/"));
const profileName = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,15}$/);

function controlPaths(root: string, profile: string): string[] {
  const state = path.posix.join(root, "profiles", profile, "state");
  return [
    path.posix.join(state, "headless", "rpc.sock"),
    path.posix.join(state, "headless-secret.key"),
    path.posix.join(state, "state.db"),
    path.posix.join(root, "profiles", profile, "config.toml"),
  ];
}

// Codex credential files, by the names Codex 0.164.0 writes them under.
function credentialPaths(codexHome: string): string[] {
  return [
    path.posix.join(codexHome, "auth.json"),
    path.posix.join(codexHome, ".credentials.json"),
    path.posix.join(codexHome, "secrets", "codex_auth.age"),
    path.posix.join(codexHome, "secrets", "mcp_oauth.age"),
    path.posix.join(codexHome, "secrets", "local.age"),
  ];
}

// What only Codex itself reads: configuration, transcripts, logs and its
// SQLite state, including a versioned file a later Codex release adds.
function privatePaths(codexHome: string): string[] {
  return [
    path.posix.join(codexHome, "config.toml"),
    path.posix.join(codexHome, "sessions", "2026", "11", "12", "rollout-x.jsonl"),
    path.posix.join(codexHome, "archived_sessions", "rollout-y.jsonl"),
    path.posix.join(codexHome, "history.jsonl"),
    path.posix.join(codexHome, "session_index.jsonl"),
    path.posix.join(codexHome, "log", "codex-tui.log"),
    path.posix.join(codexHome, "state_5.sqlite"),
    path.posix.join(codexHome, "logs_2.sqlite-wal"),
    path.posix.join(codexHome, "state_9.sqlite-shm"),
  ];
}

// What the model and every command read in the Codex home. Denying these
// breaks skills, image output, the shell environment or apply_patch.
function modelReadablePaths(codexHome: string): string[] {
  return [
    path.posix.join(codexHome, "skills", "demo", "SKILL.md"),
    path.posix.join(codexHome, "skills", ".system", "demo", "SKILL.md"),
    path.posix.join(codexHome, "skills", "demo", "fixtures", "data.sqlite"),
    path.posix.join(codexHome, "plugins", "cache", "p", "skills", "s", "SKILL.md"),
    path.posix.join(codexHome, "memories", "notes.md"),
    path.posix.join(codexHome, "AGENTS.md"),
    path.posix.join(codexHome, "generated_images", "image.png"),
    path.posix.join(codexHome, "shell_snapshots", "snapshot.sh"),
    path.posix.join(codexHome, "tmp", "arg0", "codex-arg0x", "apply_patch"),
  ];
}

// Codex home paths a command could use to steer Codex itself if it could
// write them. `name` varies so a workspace inside the home covers one.
function steeringPaths(codexHome: string, name: string): string[] {
  return [
    path.posix.join(codexHome, "skills", name, "SKILL.md"),
    path.posix.join(codexHome, "hooks.json"),
    path.posix.join(codexHome, "AGENTS.md"),
    path.posix.join(codexHome, "rules", "default.rules"),
  ];
}

// The Codex home's own path is the stem of glob entries.
const hasGlobSyntax = (value: string) => /[*?[\]{}\\]/.test(value);

const DEFAULT_CODEX_HOME = "/srv/codex-home";
const policyFor = (root: string, codexHome = DEFAULT_CODEX_HOME) =>
  createOutpostRuntimePolicy({ PWRAGENT_HOME: root, PWRAGENT_CODEX_HOME: codexHome });
// Codex sees real paths; a generated root may name a symlink such as /tmp.
const canonicalRoot = (root: string) => path.posix.dirname(policyFor(root).codexProtectedRoots[0]!);
const canonicalCodexHome = (root: string, codexHome: string) =>
  path.posix.dirname(policyFor(root, codexHome).codexProtectedRoots.find((entry) => entry.endsWith("/auth.json"))!);
const withinAny = (target: string, roots: readonly string[]) => roots.some((root) => within(target, root));

function profilesFrom(args: readonly string[]): Map<string, { filesystem: Record<string, Toml>; network: Toml | undefined }> {
  const values = launchOverrides(args);
  const profiles = new Map<string, { filesystem: Record<string, Toml>; network: Toml | undefined }>();
  for (const id of Object.values(OUTPOST_PERMISSION_PROFILE_IDS)) {
    const filesystem = values.get(`permissions.${id}.filesystem`);
    profiles.set(id, {
      filesystem: filesystem === undefined ? {} : parseToml(filesystem) as Record<string, Toml>,
      network: values.has(`permissions.${id}.network.enabled`) ? parseToml(values.get(`permissions.${id}.network.enabled`)!) : undefined,
    });
  }
  return profiles;
}

// The Outpost refuses to start outside Linux and macOS, and this model is
// Codex's POSIX path resolution. Windows still builds the policy for the
// desktop suites that boot the headless owner on a native root.
describe.skipIf(process.platform === "win32")("Outpost Codex sandbox", () => {
  it("every launch profile denies the Outpost state and Codex private files, and keeps the Codex home read-only, from any workspace the rewriter admits", () => {
    const workspaceFor = (codexHome: string) => fc.oneof(
      absolutePath,
      // A workspace above the Codex home must not make it writable.
      fc.constant("/"), fc.constant(path.posix.dirname(codexHome)),
    );
    const scenario = fc.tuple(absolutePath, absolutePath).chain(([root, codexHome]) =>
      fc.tuple(fc.constant(root), fc.constant(codexHome), workspaceFor(codexHome)));
    fc.assert(fc.property(scenario, profileName, fc.string(), ([root, codexHome, cwd], profile, pathValue) => {
      fc.pre(!within(codexHome, root) && !within(root, codexHome) && !hasGlobSyntax(codexHome));
      const policy = policyFor(root, codexHome);
      const args = buildCodexClientArgs({ PATH: pathValue }, [], [], policy);
      const values = launchOverrides(args);
      // A legacy sandbox key would take precedence over the profiles.
      for (const key of values.keys()) {
        expect(key === "sandbox_mode" || key.startsWith("sandbox_workspace_write")).toBe(false);
      }
      expect(Object.values(OUTPOST_PERMISSION_PROFILE_IDS)).toContain(JSON.parse(values.get("default_permissions")!));
      // A workspace inside a protected path or the Codex home is refused
      // before Codex sees it.
      fc.pre(!withinAny(cwd, [...policy.codexProtectedRoots, ...policy.codexReadOnlyRoots]));
      const home = canonicalCodexHome(root, codexHome);
      for (const [id, { filesystem, network }] of profilesFrom(args)) {
        expect(network, id).toBe(false);
        for (const target of [...controlPaths(canonicalRoot(root), profile), ...credentialPaths(home), ...privatePaths(home)]) {
          expect(effectiveAccess(filesystem, target, [cwd]), `${id} ${target}`).toBe("deny");
        }
        for (const target of [...modelReadablePaths(home), ...steeringPaths(home, profile)]) {
          expect(effectiveAccess(filesystem, target, [cwd]), `${id} ${target}`).toBe("read");
        }
      }
    }));
  });

  it("every outbound request selects an Outpost profile, keeps the deny, and never widens the requested sandbox", () => {
    const sandboxValue = fc.constantFrom<unknown>(
      undefined, null, "read-only", "workspace-write", "danger-full-access", "external",
      { type: "readOnly", networkAccess: false },
      { type: "workspaceWrite", writableRoots: ["/"], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      { type: "dangerFullAccess" }, { type: "externalSandbox", networkAccess: "enabled" },
    );
    const profileValue = fc.oneof(
      fc.constant(undefined), fc.constant(null), fc.string(),
      fc.constantFrom(...Object.values(OUTPOST_PERMISSION_PROFILE_IDS), ":danger-full-access", ":workspace"),
    );
    const configKey = fc.oneof(fc.constantFrom(...OUTPOST_MANAGED_CONFIG_KEYS, "permissions.x.filesystem", "mcp_servers", "model"), fc.string());
    fc.assert(fc.property(
      absolutePath, profileName,
      fc.constantFrom("thread/start", "thread/resume", "thread/fork", "turn/start", "thread/settings/update", "command/exec", "thread/read"),
      sandboxValue, sandboxValue, profileValue, profileValue,
      fc.option(fc.oneof(absolutePath, fc.constantFrom("inside", "inside-codex-secrets", "inside-codex-home", "codex-home", "above-codex-home")), { nil: undefined }),
      fc.option(fc.dictionary(configKey, fc.constant(true)), { nil: undefined }),
      (root, profile, method, sandbox, sandboxPolicy, permissions, permissionProfile, cwdChoice, config) => {
        const protectedProfiles = path.posix.join(root, "profiles");
        const cwd = cwdChoice === "inside" ? path.posix.join(protectedProfiles, profile, "state")
          : cwdChoice === "inside-codex-secrets" ? path.posix.join(DEFAULT_CODEX_HOME, "secrets", profile)
          : cwdChoice === "inside-codex-home" ? path.posix.join(DEFAULT_CODEX_HOME, "skills", profile)
          : cwdChoice === "codex-home" ? DEFAULT_CODEX_HOME
          : cwdChoice === "above-codex-home" ? path.posix.dirname(DEFAULT_CODEX_HOME)
          : cwdChoice;
        const params: Record<string, unknown> = { threadId: "t" };
        for (const [key, value] of Object.entries({ sandbox, sandboxPolicy, permissions, permissionProfile, cwd, config })) {
          if (value !== undefined) params[key] = value;
        }
        const policy = policyFor(root);
        const rewrite = createOutpostCodexMessageRewriter(policy.codexProtectedRoots, { readOnlyRoots: policy.codexReadOnlyRoots });
        let sent: { params: Record<string, unknown> };
        try { sent = JSON.parse(rewrite(JSON.stringify({ id: 1, method, params }))); }
        catch { return; } // A refused request never reaches Codex.

        const out = sent.params;
        expect(out).not.toHaveProperty("sandbox");
        expect(out).not.toHaveProperty("sandboxPolicy");
        const profileField = method === "command/exec" ? "permissionProfile" : "permissions";
        const otherField = profileField === "permissions" ? "permissionProfile" : "permissions";
        expect(out[otherField] ?? null).toBeNull();
        const selected = out[profileField];
        if (["thread/start", "thread/resume", "thread/fork", "command/exec"].includes(method)) expect(selected).toBeDefined();
        if (selected !== undefined && selected !== null) {
          expect(Object.values(OUTPOST_PERMISSION_PROFILE_IDS)).toContain(selected);
        }
        const askedReadOnly = [sandbox, sandboxPolicy].some((value) => value === "read-only" || (value as { type?: string } | null)?.type === "readOnly")
          || [permissions, permissionProfile].includes(OUTPOST_PERMISSION_PROFILE_IDS["read-only"]);
        if (askedReadOnly) expect(selected).toBe(OUTPOST_PERMISSION_PROFILE_IDS["read-only"]);
        if (out.config) expect(Object.keys(out.config as object).some((key) =>
          OUTPOST_MANAGED_CONFIG_KEYS.some((managed) => key === managed || key.startsWith(`${managed}.`)))).toBe(false);

        // The profile Codex will apply, from where Codex will run.
        const workspace = typeof out.cwd === "string" ? out.cwd : "/";
        expect(withinAny(workspace, [...policy.codexProtectedRoots, ...policy.codexReadOnlyRoots])).toBe(false);
        const { filesystem } = profilesFrom(buildCodexClientArgs({}, [], [], policy)).get(
          typeof selected === "string" ? selected : OUTPOST_PERMISSION_PROFILE_IDS["read-only"])!;
        const home = canonicalCodexHome(root, DEFAULT_CODEX_HOME);
        for (const target of [...controlPaths(canonicalRoot(root), profile), ...credentialPaths(home), ...privatePaths(home)]) {
          expect(effectiveAccess(filesystem, target, [workspace]), target).toBe("deny");
        }
        for (const target of [...modelReadablePaths(home), ...steeringPaths(home, profile)]) {
          expect(effectiveAccess(filesystem, target, [workspace]), target).toBe("read");
        }
      },
    ));
  });

  it("refuses operator overrides that could redefine the Outpost sandbox", () => {
    fc.assert(fc.property(
      fc.constantFrom(...OUTPOST_MANAGED_CONFIG_KEYS),
      fc.constantFrom("", ".pwragent-outpost-workspace-write.filesystem", ".enabled"),
      (key, suffix) => {
        expect(() => buildCodexClientArgs({}, [`${key}${suffix}=true`], [], policyFor("/srv/pwragent"))).toThrow();
      },
    ));
  });

  // bubblewrap aborts every command when a deny entry names a symlink, and a
  // case-insensitive volume reaches one directory by many spellings.
  it("denies one canonical root and refuses every spelling of a directory inside it", () => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "outpost-sandbox-")));
    try {
      const real = path.join(base, "real");
      fs.mkdirSync(path.join(real, "profiles", "p", "state"), { recursive: true });
      const link = path.join(base, "link");
      fs.symlinkSync(real, link);
      const protectedRoots = policyFor(link).codexProtectedRoots;
      expect(protectedRoots[0]).toBe(path.join(real, "profiles"));
      expect(buildCodexClientArgs({}, [], [], policyFor(link)).join(" ")).not.toContain(link);
      const rewrite = createOutpostCodexMessageRewriter(protectedRoots);
      const cwds = [
        path.join(link, "profiles", "p", "state"),
        path.join(link, "profiles", "p", "not-yet-created", "deeper"),
        path.join(real, "profiles"),
      ];
      const caseInsensitive = fs.existsSync(path.join(base, "REAL"));
      if (caseInsensitive) cwds.push(path.join(base, "REAL", "PROFILES", "p"));
      for (const cwd of cwds) {
        expect(() => rewrite(JSON.stringify({ id: 1, method: "thread/start", params: { cwd } })), cwd)
          .toThrow(/inside its own state/);
      }
      expect(() => rewrite(JSON.stringify({ id: 1, method: "thread/start", params: { cwd: base } }))).not.toThrow();
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  // An operator may link a credential to a mounted secret. Codex 0.159.2 and
  // 0.164.0 then fail every command if the deny entry names the link, and a
  // deny at the link alone would leave the target readable.
  it("denies a linked Codex credential at its target and names no symlink", () => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "outpost-codex-home-")));
    try {
      const home = path.join(base, "codex");
      const mounted = path.join(base, "mounted");
      fs.mkdirSync(home);
      fs.mkdirSync(mounted);
      fs.mkdirSync(path.join(base, "state", "profiles"), { recursive: true });
      fs.symlinkSync(path.join(mounted, "auth"), path.join(home, "auth.json"));
      fs.writeFileSync(path.join(mounted, "auth"), "");
      fs.symlinkSync(home, path.join(base, "home-link"));
      const policy = policyFor(path.join(base, "state"), path.join(base, "home-link"));
      expect(policy.codexProtectedRoots).toEqual([
        path.join(base, "state", "profiles"),
        path.join(mounted, "auth"),
        ...[...OUTPOST_CODEX_CREDENTIAL_ENTRIES.slice(1), ...OUTPOST_CODEX_PRIVATE_ENTRIES, ...OUTPOST_CODEX_PRIVATE_GLOBS]
          .map((entry) => path.join(home, entry)),
      ]);
      expect(policy.codexReadOnlyRoots).toEqual([home]);
      for (const entry of policy.codexProtectedRoots) {
        expect(fs.realpathSync.native(path.dirname(entry)), entry).toBe(path.dirname(entry));
      }
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  // The Codex home is the stem of glob deny entries, so syntax in its path
  // would deny the wrong files or none.
  it("refuses a Codex home whose path contains glob syntax", () => {
    fc.assert(fc.property(absolutePath, fc.constantFrom("*", "?", "[", "]", "{", "}", "\\"), (base, syntax) => {
      expect(() => policyFor("/srv/pwragent", `${base}/co${syntax}dex`)).toThrow(/glob|must not contain/);
    }));
  });
});
