import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BLOCKED_BINARIES = [
  "gh",
  "hub",
  "glab",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "curl",
  "wget",
  "git-remote-http",
  "git-remote-https",
  "git-remote-ftp",
  "git-remote-ftps",
];

const CODEX_CREDENTIAL_FILES = ["auth.json", ".credentials.json"];
const ANTIGRAVITY_AUTH_FILES = [
  "jetski_state.pbtxt",
  "installation_id",
  "cache/acp-auth-state.json",
  "cache/onboarding.json",
  "cache/default_project_id.txt",
];

/**
 * Resolve the canonical path of the nearest existing ancestor plus any missing
 * tail, matching PwrAgent's Outpost path canonicalization.
 */
export function canonicalPath(value) {
  let existing = path.resolve(value);
  const missing = [];
  if (process.platform === "win32") return existing;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(existing), ...missing.reverse());
    } catch (error) {
      if ((error.code !== "ENOENT" && error.code !== "ENOTDIR") || existing === path.parse(existing).root) {
        throw error;
      }
      missing.push(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
}

export function isWithin(child, parent) {
  const c = canonicalPath(child);
  const p = canonicalPath(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/**
 * Pick a default staging parent outside user home directories and outside
 * macOS /private/var/folders so both can be unconditionally denied.
 */
export function defaultRunnerParent(platform = process.platform) {
  if (platform === "darwin" || platform === "linux") {
    return canonicalPath("/tmp");
  }
  return canonicalPath(os.tmpdir());
}

export function assertRunnerRootSafe(runnerRoot, sensitiveRoots) {
  const canonicalRunner = canonicalPath(runnerRoot);
  for (const root of sensitiveRoots) {
    if (!root) continue;
    const canonicalSensitive = canonicalPath(root);
    if (isWithin(canonicalRunner, canonicalSensitive) || isWithin(canonicalSensitive, canonicalRunner)) {
      throw new Error("Isolated runner root must be completely disjoint from repository, cohort, controller output, and denied roots.");
    }
  }
}

export function resolveDeniedRoots({
  repoCwd,
  cohortPath,
  outDir,
  extraDeniedPaths = [],
  runnerRoot,
  platform = process.platform,
  hostHome = os.homedir(),
}) {
  const mandatorySensitive = [
    repoCwd,
    cohortPath ? path.dirname(cohortPath) : undefined,
    outDir,
    ...extraDeniedPaths,
  ].filter(Boolean);
  assertRunnerRootSafe(runnerRoot, mandatorySensitive);

  const candidates = [...mandatorySensitive];
  if (platform === "darwin") {
    candidates.push("/Users", "/private/var/folders");
    if (hostHome && !isWithin(hostHome, "/Users")) candidates.push(hostHome);
  } else if (platform === "linux") {
    candidates.push("/home", "/root");
    if (hostHome && !isWithin(hostHome, "/home") && !isWithin(hostHome, "/root")) {
      candidates.push(hostHome);
    }
  }

  const seen = new Set();
  const denied = [];
  for (const candidate of candidates) {
    const resolved = canonicalPath(candidate);
    if (resolved === path.parse(resolved).root) continue;
    if (isWithin(runnerRoot, resolved) || isWithin(resolved, runnerRoot)) continue;
    if (!seen.has(resolved)) {
      seen.add(resolved);
      denied.push(resolved);
    }
  }
  return denied;
}

export function resolveExecutable(command, env = process.env) {
  if (!command) return undefined;
  if (path.isAbsolute(command)) {
    return fs.existsSync(command) ? canonicalPath(command) : undefined;
  }
  for (const dir of (env.PATH || "/usr/bin:/bin").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return canonicalPath(candidate);
    } catch {
      // continue searching
    }
  }
  return undefined;
}

/**
 * Create a high-precedence bin directory with fail-closed shims for forge and
 * remote-fetch CLIs so reviewer processes cannot invoke them even via PATH.
 */
export function createRestrictedBinDir(cellRoot) {
  const binDir = path.join(cellRoot, "bin");
  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  for (const name of BLOCKED_BINARIES) {
    const file = path.join(binDir, name);
    fs.writeFileSync(
      file,
      `#!/bin/sh\necho "${name} is disabled in the isolated managed-review-eval runner." >&2\nexit 126\n`,
      { mode: 0o755 },
    );
  }
  return binDir;
}

export function buildIsolatedEnv({
  arm,
  cellRoot,
  pwragentHome,
  runnerHome,
  codexHome,
  restrictedBinDir,
  antigravityCliPath,
  codexCommand,
  nodeExecutable = process.execPath,
  extraPathDirs = [],
  passthroughEnv = {},
  createTmpDir = true,
}) {
  const tmpDir = path.join(cellRoot, "tmp");
  if (createTmpDir) {
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  }

  const pathDirs = [
    restrictedBinDir,
    ...(createTmpDir ? [path.dirname(canonicalPath(nodeExecutable))] : []),
    ...extraPathDirs.filter(Boolean).map(canonicalPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  if (codexCommand) pathDirs.splice(1, 0, path.dirname(canonicalPath(codexCommand)));
  if (antigravityCliPath) pathDirs.splice(1, 0, path.dirname(canonicalPath(antigravityCliPath)));
  const uniquePath = [...new Set(pathDirs)].join(path.delimiter);

  const env = {
    PATH: uniquePath,
    HOME: runnerHome,
    TMPDIR: tmpDir,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TERM: "dumb",
    USER: "eval-runner",
    LOGNAME: "eval-runner",
    PWRAGENT_HOME: pwragentHome,
    PWRAGENT_PROFILE: "eval",
    PWRAGENT_DISABLE_MESSAGING: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "",
  };
  if (arm === "codex" && codexHome) {
    env.CODEX_HOME = codexHome;
    if (codexCommand) env.PWRAGENT_CODEX_COMMAND = canonicalPath(codexCommand);
  }
  if (arm === "neon") {
    env.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
    if (antigravityCliPath) {
      env.PWRAGENT_ACP_AGENTS_ANTIGRAVITY_CLI_PATH = canonicalPath(antigravityCliPath);
    }
  }
  for (const [key, value] of Object.entries(passthroughEnv)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

/**
 * Copy ONLY minimal Codex credentials into an isolated ephemeral CODEX_HOME
 * and write an empty config.toml with no user MCP servers, skills, or history.
 */
export function stageIsolatedCodexHome({ sourceCodexHome, targetCodexHome }) {
  fs.mkdirSync(targetCodexHome, { recursive: true, mode: 0o700 });
  const copied = [];
  if (sourceCodexHome && fs.existsSync(sourceCodexHome)) {
    for (const file of CODEX_CREDENTIAL_FILES) {
      const src = path.join(sourceCodexHome, file);
      if (fs.existsSync(src) && fs.statSync(src).isFile()) {
        const dst = path.join(targetCodexHome, file);
        fs.copyFileSync(src, dst);
        fs.chmodSync(dst, 0o600);
        copied.push(file);
      }
    }
  }
  fs.writeFileSync(
    path.join(targetCodexHome, "config.toml"),
    "# Isolated managed-review-eval Codex home (no user MCP servers or skills).\n",
    { mode: 0o600 },
  );
  return { copied };
}

/**
 * Stage an isolated ephemeral HOME for Antigravity Neon with NO prior
 * conversations, brain artifacts, summaries DB, user MCP servers, or skills.
 */
export function stageIsolatedAntigravityHome({
  sourceHome = os.homedir(),
  targetHome,
  allowMacKeychain = process.platform === "darwin",
}) {
  const dstAgy = path.join(targetHome, ".gemini", "antigravity-cli");
  const dstConfig = path.join(targetHome, ".gemini", "config");
  fs.mkdirSync(path.join(dstAgy, "cache"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(dstConfig, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dstConfig, "mcp_config.json"), '{"mcpServers":{}}\n', { mode: 0o600 });

  const copied = [];
  const srcAgy = sourceHome ? path.join(sourceHome, ".gemini", "antigravity-cli") : undefined;
  if (srcAgy && fs.existsSync(srcAgy)) {
    for (const rel of ANTIGRAVITY_AUTH_FILES) {
      const src = path.join(srcAgy, rel);
      if (fs.existsSync(src) && fs.statSync(src).isFile()) {
        const dst = path.join(dstAgy, rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
        fs.copyFileSync(src, dst);
        fs.chmodSync(dst, 0o600);
        copied.push(rel);
      }
    }
  }

  let keychainPath;
  if (allowMacKeychain && sourceHome) {
    const srcKeychains = path.join(sourceHome, "Library", "Keychains");
    if (fs.existsSync(srcKeychains)) {
      keychainPath = canonicalPath(srcKeychains);
      fs.mkdirSync(path.join(targetHome, "Library"), { recursive: true, mode: 0o700 });
      fs.symlinkSync(keychainPath, path.join(targetHome, "Library", "Keychains"));
    }
  }
  return { copied, keychainPath };
}

function escapeSeatbeltString(value) {
  if (/[\r\n\0]/.test(value)) {
    throw new Error("Seatbelt profile path cannot contain control characters.");
  }
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function ancestorDirectories(targetPath) {
  const ancestors = [];
  let current = path.dirname(canonicalPath(targetPath));
  while (current && current !== path.parse(current).root) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ancestors;
}

/**
 * Build a macOS Seatbelt (sandbox-exec) profile that denies reads across user
 * homes, host temp roots, repository checkout, cohort, scoring, and raw logs,
 * while permitting only the staged cell root, read-only node_modules/binaries,
 * and optional macOS Keychain for Antigravity auth.
 */
export function buildSeatbeltProfile({
  cellRoot,
  workspacePath,
  deniedRoots,
  allowReadSubpaths = [],
  allowReadLiterals = [],
  allowWriteSubpaths = [],
  denyExecLiterals = [],
}) {
  const canonicalCell = canonicalPath(cellRoot);
  const canonicalWorkspace = canonicalPath(workspacePath);
  const q = (p) => `"${escapeSeatbeltString(canonicalPath(p))}"`;

  const lines = [
    "(version 1)",
    "(allow default)",
  ];

  // Deny reading all sensitive roots plus /private/tmp so sibling temp files
  // and controller artifacts are unreachable.
  const allDenied = [...new Set([...deniedRoots.map(canonicalPath), canonicalPath("/tmp")])];
  for (const root of allDenied) {
    lines.push(`(deny file-read* (subpath ${q(root)}))`);
  }

  // Keep the entire staged workspace read-only (including .git/config).
  lines.push(`(deny file-write* (subpath ${q(canonicalWorkspace)}))`);

  // Allow stat-only traversal of ancestor directories for explicitly allowed
  // paths (never file-read-data, so readdir on denied parents fails with EPERM).
  const metadataAncestors = new Set();
  for (const allowed of [canonicalCell, ...allowReadSubpaths, ...allowReadLiterals]) {
    if (!allowed) continue;
    for (const anc of ancestorDirectories(allowed)) metadataAncestors.add(anc);
  }
  for (const anc of [...metadataAncestors].sort()) {
    lines.push(`(allow file-read-metadata (literal ${q(anc)}))`);
  }

  // Explicitly allow reading ONLY the cell root and minimal runtime dependencies.
  for (const sub of [...new Set([canonicalCell, ...allowReadSubpaths.filter(Boolean).map(canonicalPath)])]) {
    lines.push(`(allow file-read* (subpath ${q(sub)}))`);
  }
  for (const lit of [...new Set(allowReadLiterals.filter(Boolean).map(canonicalPath))]) {
    lines.push(`(allow file-read* (literal ${q(lit)}))`);
  }

  // Explicitly allow writes ONLY to the cell's writable state directories and
  // the pre-created refs/pwragent dir needed by resolvePullRequestReview.
  const writableDirs = [
    path.join(canonicalCell, "home"),
    path.join(canonicalCell, "pwragent-home"),
    path.join(canonicalCell, "result"),
    path.join(canonicalCell, "tmp"),
    path.join(canonicalWorkspace, ".git", "refs", "pwragent"),
    ...allowWriteSubpaths.filter(Boolean),
  ];
  for (const sub of [...new Set(writableDirs.map(canonicalPath))]) {
    lines.push(`(allow file-write* (subpath ${q(sub)}))`);
  }

  // Block direct execution of forge/network/remote-transport tools by path.
  const blockedExec = new Set(denyExecLiterals.filter(Boolean).map(canonicalPath));
  for (const name of BLOCKED_BINARIES) {
    const resolved = resolveExecutable(name);
    if (resolved) blockedExec.add(resolved);
  }
  for (const bin of [...blockedExec].sort()) {
    lines.push(`(deny process-exec (literal ${q(bin)}))`);
  }

  return `${lines.join("\n")}\n`;
}

export function buildBwrapArgs({
  cellRoot,
  workspacePath,
  allowReadSubpaths = [],
  command,
  args,
}) {
  const canonicalCell = canonicalPath(cellRoot);
  const canonicalWorkspace = canonicalPath(workspacePath);
  const bwrap = [
    "--die-with-parent",
    "--unshare-pid",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
  ];
  for (const sysDir of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/ssl", "/etc/ca-certificates"]) {
    if (fs.existsSync(sysDir)) bwrap.push("--ro-bind", sysDir, sysDir);
  }
  for (const etcFile of ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group"]) {
    if (fs.existsSync(etcFile)) bwrap.push("--ro-bind", etcFile, etcFile);
  }
  for (const ro of [...new Set(allowReadSubpaths.filter(Boolean).map(canonicalPath))]) {
    if (fs.existsSync(ro)) bwrap.push("--ro-bind", ro, ro);
  }
  bwrap.push("--bind", canonicalCell, canonicalCell);
  // Mount the workspace read-only except the single ref namespace needed for
  // pinned SHA pinning during resolvePullRequestReview.
  bwrap.push("--ro-bind", canonicalWorkspace, canonicalWorkspace);
  const reviewObjectsDir = path.join(canonicalWorkspace, ".git", "refs", "pwragent");
  if (fs.existsSync(reviewObjectsDir)) {
    bwrap.push("--bind", reviewObjectsDir, reviewObjectsDir);
  }
  bwrap.push("--chdir", canonicalWorkspace, "--", command, ...args);
  return bwrap;
}

export function buildDockerArgs({
  image,
  cellRoot,
  containerCellRoot = "/eval",
  seccompProfile,
  env = {},
  command,
  args = [],
}) {
  if (!image) {
    throw new Error("Docker isolation requires --docker-image <image>.");
  }
  const canonicalCell = canonicalPath(cellRoot);
  const docker = [
    "run",
    "--rm",
    "--init",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
  ];
  if (seccompProfile) {
    docker.push("--security-opt", `seccomp=${canonicalPath(seccompProfile)}`);
  }
  // Mount ONLY the single cell exchange root. Never mount host home, repo,
  // cohorts, controller outputs, scoring batches, or raw holdout logs.
  docker.push("-v", `${canonicalCell}:${containerCellRoot}:rw`);
  docker.push("-w", path.posix.join(containerCellRoot, "workspace"));
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") docker.push("-e", `${key}=${value}`);
  }
  docker.push(image, command, ...args);
  return docker;
}

export function hasCommand(cmd) {
  return Boolean(resolveExecutable(cmd));
}

export function resolveIsolationBackend({ requested = "auto", arm, platform = process.platform }) {
  const valid = new Set(["auto", "seatbelt", "codex-sandbox", "bwrap", "docker"]);
  if (!valid.has(requested)) {
    throw new Error(`Unsupported --isolation mode "${requested}". Use auto, seatbelt, codex-sandbox, bwrap, or docker.`);
  }
  if (requested === "docker") {
    if (!hasCommand("docker")) throw new Error("Docker isolation requested, but docker is not available.");
    return "docker";
  }
  if (requested === "seatbelt") {
    if (platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec")) {
      throw new Error("Seatbelt isolation requires macOS with /usr/bin/sandbox-exec.");
    }
    return "seatbelt";
  }
  if (requested === "bwrap") {
    if (platform !== "linux" || !hasCommand("bwrap")) {
      throw new Error("Bubblewrap isolation requires Linux with bwrap installed.");
    }
    return "bwrap";
  }
  if (requested === "codex-sandbox") {
    if (arm !== "codex") {
      throw new Error("codex-sandbox isolation applies only to the codex arm; use seatbelt, bwrap, or docker for neon.");
    }
    if (platform !== "darwin" && platform !== "linux") {
      throw new Error("codex-sandbox isolation requires macOS or Linux.");
    }
    return "codex-sandbox";
  }

  // auto selection: fail closed if no OS isolation boundary is available.
  if (platform === "darwin") {
    if (!fs.existsSync("/usr/bin/sandbox-exec")) {
      throw new Error("macOS /usr/bin/sandbox-exec is unavailable; cannot isolate blind review runner.");
    }
    // On macOS, Seatbelt cannot nest sandbox_apply, so Neon runs inside an
    // outer Seatbelt profile while Codex enforces Seatbelt via its own
    // permission profile (codexProtectedRoots + agentNetwork=false).
    return arm === "codex" ? "codex-sandbox" : "seatbelt";
  }
  if (platform === "linux") {
    if (hasCommand("bwrap")) return "bwrap";
    throw new Error("Blind evaluation on Linux requires bwrap or --isolation docker.");
  }
  throw new Error(`No supported OS isolation backend on platform ${platform}.`);
}

export function spawnIsolatedProcess({
  isolation,
  command,
  args,
  cwd,
  env,
  cellRoot,
  workspacePath,
  deniedRoots,
  allowReadSubpaths = [],
  allowReadLiterals = [],
  allowWriteSubpaths = [],
  dockerImage,
  seccompProfile,
  stdio = ["ignore", "pipe", "pipe"],
}) {
  if (isolation === "seatbelt") {
    const profile = buildSeatbeltProfile({
      cellRoot,
      workspacePath,
      deniedRoots,
      allowReadSubpaths,
      allowReadLiterals,
      allowWriteSubpaths,
    });
    const profilePath = path.join(cellRoot, "seatbelt.sb");
    fs.writeFileSync(profilePath, profile, { mode: 0o600 });
    return spawn("/usr/bin/sandbox-exec", ["-f", profilePath, command, ...args], {
      cwd,
      env,
      stdio,
    });
  }
  if (isolation === "bwrap") {
    const bwrapArgs = buildBwrapArgs({
      cellRoot,
      workspacePath,
      allowReadSubpaths,
      command,
      args,
    });
    return spawn("bwrap", bwrapArgs, { cwd, env, stdio });
  }
  if (isolation === "docker") {
    const dockerArgs = buildDockerArgs({
      image: dockerImage,
      cellRoot,
      seccompProfile,
      env,
      command,
      args,
    });
    return spawn("docker", dockerArgs, { cwd, stdio });
  }
  if (isolation === "codex-sandbox") {
    // Codex enforces its own Seatbelt/bwrap sandbox on model commands using
    // codexProtectedRoots + agentNetwork=false passed in the runner job.
    return spawn(command, args, { cwd, env, stdio });
  }
  throw new Error(`Unsupported isolation backend: ${isolation}`);
}

/**
 * Build Codex `-c` permission profile overrides identical to PwrAgent's
 * Outpost read-only policy for verifying real `codex sandbox` isolation.
 */
export function buildCodexReadOnlyPermissionArgs(protectedRoots, readOnlyRoots = []) {
  const denied = protectedRoots.map((root) => `${JSON.stringify(canonicalPath(root))}="deny"`);
  const readOnly = readOnlyRoots.map((root) => `${JSON.stringify(canonicalPath(root))}="read"`);
  const filesystem = `{${[
    '":root"="read"',
    ...readOnly,
    ...denied,
  ].join(",")}}`;
  return [
    "-c", `permissions.pwragent-outpost-read-only.filesystem=${filesystem}`,
    "-c", "permissions.pwragent-outpost-read-only.network.enabled=false",
    "-c", 'default_permissions="pwragent-outpost-read-only"',
  ];
}

/**
 * Execute an active probe inside the reviewer sandbox environment to prove
 * synthetic canaries cannot be read, writes are blocked, Git remotes fail,
 * and forbidden tools/env vars are unavailable.
 */
export function runReviewerIsolationProbe({
  isolation,
  arm,
  cellRoot,
  workspacePath,
  deniedRoots,
  canaryFiles,
  canaryCommits,
  expectedPatchFile,
  expectedWorkspaceFile,
  env,
  codexCommand,
  allowReadSubpaths = [],
  allowReadLiterals = [],
}) {
  const probeScript = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { spawnSync } = require('node:child_process');",
    "const cfg = JSON.parse(process.argv[1]);",
    "const out = { canaryReads: {}, gitCommits: {}, hostHomeDirBlocked: false, remoteBlocked: false, workspaceReadOk: false, patchReadOk: false, writeBlocked: false, configWriteBlocked: false, ghBlocked: false, leakedEnv: [] };",
    "for (const [name, target] of Object.entries(cfg.canaryFiles)) {",
    "  try { const text = fs.readFileSync(target, 'utf8'); out.canaryReads[name] = { blocked: false, leaked: text.slice(0, 64) }; }",
    "  catch (err) { out.canaryReads[name] = { blocked: true, code: err.code || 'ERR' }; }",
    "}",
    "if (cfg.hostHome) {",
    "  try { fs.readdirSync(cfg.hostHome); out.hostHomeDirBlocked = false; }",
    "  catch { out.hostHomeDirBlocked = true; }",
    "} else { out.hostHomeDirBlocked = true; }",
    "for (const [name, sha] of Object.entries(cfg.canaryCommits)) {",
    "  const r = spawnSync('git', ['-C', cfg.workspacePath, 'cat-file', '-e', `${sha}^{commit}`], { encoding: 'utf8' });",
    "  out.gitCommits[name] = { absent: r.status !== 0 };",
    "}",
    "const lsRemote = spawnSync('git', ['-C', cfg.workspacePath, 'ls-remote', 'origin'], { encoding: 'utf8' });",
    "out.remoteBlocked = lsRemote.status !== 0;",
    "try { out.workspaceReadOk = fs.readFileSync(path.join(cfg.workspacePath, cfg.expectedWorkspaceFile), 'utf8').length > 0; } catch {}",
    "if (cfg.expectedPatchFile) { try { out.patchReadOk = fs.readFileSync(path.join(cfg.workspacePath, cfg.expectedPatchFile), 'utf8').length > 0; } catch {} } else { out.patchReadOk = true; }",
    "try { fs.writeFileSync(path.join(cfg.workspacePath, '.isolation-write-probe'), 'nope'); out.writeBlocked = false; } catch { out.writeBlocked = true; }",
    "try { fs.appendFileSync(path.join(cfg.workspacePath, '.git', 'config'), '\\n# probe\\n'); out.configWriteBlocked = false; } catch { out.configWriteBlocked = true; }",
    "const gh = spawnSync('gh', ['--version'], { encoding: 'utf8' });",
    "out.ghBlocked = gh.status !== 0;",
    "for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'PWRAGENT_HOLDOUT_CANARY', 'SSH_AUTH_SOCK', 'PWRAGENT_OPENAI_DECISIONS_API_KEY']) {",
    "  if (Object.hasOwn(process.env, key) && process.env[key]) out.leakedEnv.push(key);",
    "}",
    "process.stdout.write(JSON.stringify(out));",
  ].join("\n");

  const payload = JSON.stringify({
    workspacePath: canonicalPath(workspacePath),
    canaryFiles,
    canaryCommits,
    hostHome: canonicalPath(os.homedir()),
    expectedPatchFile,
    expectedWorkspaceFile,
  });

  if (isolation === "seatbelt") {
    const profile = buildSeatbeltProfile({
      cellRoot,
      workspacePath,
      deniedRoots,
      allowReadSubpaths,
      allowReadLiterals,
    });
    const profilePath = path.join(cellRoot, "probe-seatbelt.sb");
    fs.writeFileSync(profilePath, profile, { mode: 0o600 });
    const res = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-f", profilePath, process.execPath, "-e", probeScript, payload],
      { cwd: workspacePath, env, encoding: "utf8", timeout: 15_000 },
    );
    if (res.status !== 0) {
      throw new Error(`Seatbelt probe exited with ${res.status}: ${res.stderr.trim()}`);
    }
    return JSON.parse(res.stdout);
  }

  if (isolation === "bwrap") {
    const bwrapArgs = buildBwrapArgs({
      cellRoot,
      workspacePath,
      allowReadSubpaths,
      command: process.execPath,
      args: ["-e", probeScript, payload],
    });
    const res = spawnSync("bwrap", bwrapArgs, {
      cwd: workspacePath,
      env,
      encoding: "utf8",
      timeout: 15_000,
    });
    if (res.status !== 0) {
      throw new Error(`bwrap probe exited with ${res.status}: ${res.stderr.trim()}`);
    }
    return JSON.parse(res.stdout);
  }

  if (isolation === "codex-sandbox") {
    const codexBin = codexCommand || resolveExecutable("codex");
    if (!codexBin) {
      throw new Error("codex-sandbox probe requires the codex executable.");
    }
    const roRoots = env.CODEX_HOME ? [env.CODEX_HOME] : [];
    const nodeDir = path.dirname(canonicalPath(process.execPath));
    if (deniedRoots.some((root) => isWithin(nodeDir, root))) {
      roRoots.push(nodeDir);
    }
    const permArgs = buildCodexReadOnlyPermissionArgs(deniedRoots, roRoots);
    const res = spawnSync(
      codexBin,
      [
        "sandbox",
        "-C", canonicalPath(workspacePath),
        "-P", "pwragent-outpost-read-only",
        ...permArgs,
        "--",
        process.execPath,
        "-e", probeScript,
        payload,
      ],
      { cwd: workspacePath, env, encoding: "utf8", timeout: 20_000 },
    );
    if (res.status !== 0) {
      throw new Error(`codex sandbox probe exited with ${res.status}: ${res.stderr.trim()}`);
    }
    return JSON.parse(res.stdout);
  }

  throw new Error(`Unsupported probe isolation mode for arm ${arm}: ${isolation}`);
}

export function assertProbePassed(probe) {
  const failures = [];
  for (const [name, result] of Object.entries(probe.canaryReads)) {
    if (!result.blocked) failures.push(`canary readable: ${name}`);
  }
  for (const [name, result] of Object.entries(probe.gitCommits)) {
    if (!result.absent) failures.push(`forbidden git commit reachable: ${name}`);
  }
  if (!probe.hostHomeDirBlocked) failures.push("host home directory listing was not blocked");
  if (!probe.remoteBlocked) failures.push("git remote access was not blocked");
  if (!probe.workspaceReadOk) failures.push("staged workspace file was not readable");
  if (!probe.patchReadOk) failures.push("staged pinned patch file was not readable");
  if (!probe.writeBlocked) failures.push("workspace file write was not blocked");
  if (!probe.configWriteBlocked) failures.push(".git/config write was not blocked");
  if (!probe.ghBlocked) failures.push("gh executable was not blocked");
  if (probe.leakedEnv.length) failures.push(`leaked env vars: ${probe.leakedEnv.join(", ")}`);
  if (failures.length) {
    throw new Error(`Isolation probe failed: ${failures.join("; ")}`);
  }
  return { ok: true, checkedCanaries: Object.keys(probe.canaryReads).length, checkedCommits: Object.keys(probe.gitCommits).length };
}

export function ensureGitCleanPathCheck(workspacePath, forbiddenSubstrings = []) {
  const gitDir = path.join(workspacePath, ".git");
  const configText = fs.readFileSync(path.join(gitDir, "config"), "utf8");
  for (const needle of forbiddenSubstrings) {
    if (needle && configText.includes(needle)) {
      throw new Error("Staged workspace .git/config references a forbidden controller path.");
    }
  }
  if (fs.existsSync(path.join(gitDir, "objects", "info", "alternates"))) {
    throw new Error("Staged workspace must not contain Git alternates.");
  }
  if (fs.existsSync(path.join(gitDir, "logs"))) {
    throw new Error("Staged workspace must not contain Git reflogs.");
  }
  if (fs.existsSync(path.join(gitDir, "FETCH_HEAD"))) {
    throw new Error("Staged workspace must not contain FETCH_HEAD.");
  }
  const fsck = execFileSync("git", ["-C", workspacePath, "fsck", "--full"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (fsck) {
    throw new Error(`Staged workspace failed git fsck: ${fsck}`);
  }
}
