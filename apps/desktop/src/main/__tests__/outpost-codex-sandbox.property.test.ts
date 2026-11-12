import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildCodexClientArgs } from "../app-server/codex-thread-config";
import {
  OUTPOST_MANAGED_CONFIG_KEYS,
  OUTPOST_PERMISSION_PROFILE_IDS,
  createOutpostCodexMessageRewriter,
} from "../headless/outpost-codex-sandbox";
import { createOutpostRuntimePolicy } from "../owner-runtime-policy";

// Rule: no Codex sandbox an Outpost generates lets an agent command reach the
// Outpost's control channel or the secret beside it. Agent commands run as the
// Outpost's own Unix user, so only the sandbox can keep them out of
// `<root>/profiles/<profile>/state`, which holds `headless/rpc.sock`,
// `headless-secret.key` and the state database it unlocks.
//
// `effectiveAccess` models how Codex resolves a profile's filesystem entries:
// the most specific matching entry wins; at equal specificity deny beats write
// beats read. Codex 0.159.2 and 0.164.0 behaved this way in a disposable
// Outpost container, including a workspace root inside a denied directory
// regaining write access, which is why the rewriter refuses one.

type Toml = string | boolean | { [key: string]: Toml };

/** Parses the inline-table subset the Outpost emits: basic strings, booleans, tables. */
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
    if (source[index] !== "{") throw new Error(`Unexpected TOML at ${index}: ${source}`);
    index++;
    const table: Record<string, Toml> = {};
    skip();
    while (source[index] !== "}") {
      skip();
      const key = string();
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
  const entries: Array<[string, Access]> = [];
  for (const [key, access] of Object.entries(filesystem)) {
    if (key === ":workspace_roots") {
      for (const [sub, nested] of Object.entries(access as Record<string, Toml>)) {
        for (const root of workspaceRoots) entries.push([path.posix.join(root, sub), nested as Access]);
      }
    } else if (key === ":root") entries.push(["/", access as Access]);
    else if (key.startsWith(":")) throw new Error(`Unmodelled special path ${key}`);
    else entries.push([key, access as Access]);
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

const policyFor = (root: string) => createOutpostRuntimePolicy({ PWRAGENT_HOME: root });
// Codex sees real paths; a generated root may name a symlink such as /tmp.
const canonicalRoot = (root: string) => path.posix.dirname(policyFor(root).codexProtectedRoots[0]!);

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
  it("every launch profile denies the control channel and secret from any workspace outside them", () => {
    fc.assert(fc.property(absolutePath, profileName, fc.string(), absolutePath, (root, profile, pathValue, cwd) => {
      const args = buildCodexClientArgs({ PATH: pathValue }, [], [], policyFor(root));
      const values = launchOverrides(args);
      // A legacy sandbox key would take precedence over the profiles.
      for (const key of values.keys()) {
        expect(key === "sandbox_mode" || key.startsWith("sandbox_workspace_write")).toBe(false);
      }
      expect(Object.values(OUTPOST_PERMISSION_PROFILE_IDS)).toContain(JSON.parse(values.get("default_permissions")!));
      fc.pre(!within(cwd, path.posix.join(root, "profiles")));
      for (const [id, { filesystem, network }] of profilesFrom(args)) {
        expect(network, id).toBe(false);
        for (const target of controlPaths(canonicalRoot(root), profile)) {
          expect(effectiveAccess(filesystem, target, [cwd]), `${id} ${target}`).toBe("deny");
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
      fc.option(fc.oneof(absolutePath, fc.constant("inside")), { nil: undefined }),
      fc.option(fc.dictionary(configKey, fc.constant(true)), { nil: undefined }),
      (root, profile, method, sandbox, sandboxPolicy, permissions, permissionProfile, cwdChoice, config) => {
        const protectedProfiles = path.posix.join(root, "profiles");
        const cwd = cwdChoice === "inside" ? path.posix.join(protectedProfiles, profile, "state") : cwdChoice;
        const params: Record<string, unknown> = { threadId: "t" };
        for (const [key, value] of Object.entries({ sandbox, sandboxPolicy, permissions, permissionProfile, cwd, config })) {
          if (value !== undefined) params[key] = value;
        }
        const rewrite = createOutpostCodexMessageRewriter(policyFor(root).codexProtectedRoots);
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
        expect(within(workspace, path.posix.join(canonicalRoot(root), "profiles"))).toBe(false);
        const { filesystem } = profilesFrom(buildCodexClientArgs({}, [], [], policyFor(root))).get(
          typeof selected === "string" ? selected : OUTPOST_PERMISSION_PROFILE_IDS["read-only"])!;
        for (const target of controlPaths(canonicalRoot(root), profile)) {
          expect(effectiveAccess(filesystem, target, [workspace]), target).toBe("deny");
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
      expect(protectedRoots).toEqual([path.join(real, "profiles")]);
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
});
