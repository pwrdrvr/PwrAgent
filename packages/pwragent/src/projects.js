import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { atomicJson } from "./store.js";

const execute = promisify(execFile);
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Git receives only destination-local, explicitly selected authentication. */
export class OutpostGit {
  constructor(directory, run = execute, workspace) {
    this.directory = directory;
    this.run = run;
    this.workspace = workspace;
    this.file = path.join(directory, "git-auth.json");
  }

  privateFile(file, executable = false) {
    if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("Git authentication paths must be absolute outpost paths");
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)
      || (executable && !(info.mode & 0o100))) throw new Error("Git authentication files must be private, owned regular files on the outpost");
    return file;
  }

  configure(config) {
    if (!config || Object.keys(config).some((key) => !["sshKeyPath", "knownHostsPath", "credentialHelperPath"].includes(key))) throw new Error("Unsupported Git authentication setting");
    if (Boolean(config.sshKeyPath) !== Boolean(config.knownHostsPath)) throw new Error("SSH requires both an outpost key and a pinned known-hosts file");
    for (const [key, value] of Object.entries(config)) this.privateFile(value, key === "credentialHelperPath");
    atomicJson(this.file, { version: 1, ...config });
    return { configured: true, ssh: Boolean(config.sshKeyPath), credentialHelper: Boolean(config.credentialHelperPath) };
  }

  settings() {
    try {
      this.privateFile(this.file);
      const { version, ...config } = JSON.parse(readFileSync(this.file, "utf8"));
      if (version !== 1) throw new Error("Unsupported Git authentication version");
      for (const [key, value] of Object.entries(config)) {
        if (!["sshKeyPath", "knownHostsPath", "credentialHelperPath"].includes(key)) throw new Error("Unsupported Git authentication setting");
        this.privateFile(value, key === "credentialHelperPath");
      }
      return config;
    } catch (error) { if (error.code === "ENOENT" && !this.hasSettings()) return {}; throw error; }
  }

  hasSettings() { try { lstatSync(this.file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }

  async git(cwd, args, options = {}) {
    const config = this.settings();
    const gitHome = path.join(this.directory, "git-home");
    mkdirSync(gitHome, { recursive: true, mode: 0o700 });
    const ssh = ["ssh", "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentityAgent=none", "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=yes", "-o", "GlobalKnownHostsFile=/dev/null", "-o", "UserKnownHostsFile=" + (config.knownHostsPath || "/dev/null"),
      "-i", config.sshKeyPath || "none"].map(quote).join(" ");
    const env = { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: gitHome, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never",
      GIT_CEILING_DIRECTORIES: path.dirname(this.workspace || cwd), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "https:http:ssh:file" };
    try {
      const work = this.run("git", ["-c", "credential.helper=", ...(config.credentialHelperPath ? ["-c", `credential.helper=!${quote(config.credentialHelperPath)}`] : []),
        "-c", `core.sshCommand=${ssh}`, "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", "-C", cwd, ...args],
      { ...options, env, timeout: options.timeout ?? 120000, maxBuffer: options.maxBuffer ?? 1024 * 1024 });
      if (options.input && work.child) work.child.stdin.end(options.input);
      return await work;
    } catch (error) {
      const failure = new Error("Git operation failed on the outpost. Check the repository, published ref and explicitly configured outpost authentication.");
      if (/not a git repository/i.test(error.stderr || "")) failure.stderr = "not a git repository";
      throw failure;
    }
  }
}

export class OutpostProjects {
  constructor(directory, workspace, git = new OutpostGit(directory, execute, workspace)) {
    this.file = path.join(directory, "projects.json");
    this.workspace = workspace;
    this.git = git;
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.projects)) throw new Error("Invalid outpost project registry");
      this.projects = new Map(data.projects.map((project) => [project.path, project]));
    } catch (error) { if (error.code !== "ENOENT") throw error; this.projects = new Map(); }
    if (!this.projects.has(workspace)) this.projects.set(workspace, { path: workspace, label: path.basename(workspace) });
  }

  save() { atomicJson(this.file, { version: 1, projects: [...this.projects.values()] }); }
  list() { return [...this.projects.values()]; }

  contained(value) {
    if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("Project path must be absolute on the outpost");
    const relative = path.relative(this.workspace, value);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Project path must be inside the outpost workspace");
    return value;
  }

  resolve(value = this.workspace) {
    const project = this.projects.get(value);
    if (!project) throw new Error("Project is not owned by this outpost; register its directory first");
    const cwd = this.contained(realpathSync(project.path));
    if (cwd !== project.path || !statSync(cwd).isDirectory()) throw new Error("Outpost project directory changed or is unavailable");
    return cwd;
  }

  async add({ path: directory, label }) {
    const cwd = this.contained(realpathSync(directory));
    if (!statSync(cwd).isDirectory()) throw new Error("Project must be an existing outpost directory");
    if (label !== undefined && (typeof label !== "string" || !label.trim() || label.length > 200)) throw new Error("Invalid project label");
    this.projects.set(cwd, { path: cwd, label: label?.trim() || path.basename(cwd) });
    this.save();
    return this.projects.get(cwd);
  }

  async create({ name, remote, label }) {
    if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) throw new Error("Project name must be a simple directory name");
    if (remote !== undefined) {
      if (typeof remote !== "string" || !remote || remote.length > 4096 || /[\x00-\x20]/.test(remote) || remote.startsWith("-")) throw new Error("Invalid repository URL");
      if (!path.isAbsolute(remote)) {
        try {
          const url = new URL(remote);
          if (!["https:", "http:", "ssh:"].includes(url.protocol) || url.password || (url.protocol !== "ssh:" && url.username) || url.search || url.hash) throw new Error();
        } catch { if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9/._-]+$/.test(remote)) throw new Error("Use a credential-free HTTPS/SSH URL or an absolute local repository path"); }
      }
    }
    const target = path.join(this.resolve(), name);
    await mkdir(target, { mode: 0o700 });
    try {
      if (remote) await this.git.git(this.workspace, ["clone", "--", remote, target]);
      return await this.add({ path: target, label });
    } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
  }

  remove(directory, threads = []) {
    if (directory === this.workspace) throw new Error("The default workspace cannot be unregistered");
    if (threads.some((thread) => thread.cwd === directory)) throw new Error("The project still owns outpost threads");
    this.projects.delete(directory);
    this.save();
    return { removed: directory };
  }
}
