import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import fc from "fast-check";
import { list as listTar } from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeBoatSandboxPolicy } from "@pwragent/shared/contracts/mcp-connections";
import type { BoatApiRequest } from "../mcp-connections/boat-api";
import { BoatTools } from "../mcp-connections/boat-tools";
import {
  isEnvFilePath,
  listWorkspaceFiles,
  packWorkspace,
  type BoatWorkspaceGit,
} from "../mcp-connections/boat-workspace";
import { isolatedGitKeys, runIsolatedGit } from "./helpers/isolated-git";

/**
 * The rules for moving a thread's directory to a sandbox and back. Git and
 * tar are the real ones. The sandbox is a directory on this machine whose
 * `commands` endpoint runs the script it is sent, so a push and a pull go
 * the whole way round.
 */

const execFile = promisify(execFileCallback);
const POLICY = normalizeBoatSandboxPolicy({});
const git: BoatWorkspaceGit = async (cwd, args) => await runIsolatedGit(cwd, args);
const commit = ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-q", "-m", "base"];
const directories: string[] = [];
const posix = process.platform !== "win32";

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temp(name: string): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pwragent-boat-${name}-`)));
  directories.push(directory);
  return directory;
}

function write(root: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

/** Every file under a directory with its content, `.git` aside. */
function snapshot(root: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else found[path.relative(root, full).split(path.sep).join("/")] = fs.readFileSync(full, "utf8");
    }
  };
  walk(root);
  return found;
}

/** A sandbox that is a local directory, and one thread's tools for it. */
function world(roots: string[]) {
  const box = temp("box");
  fs.mkdirSync(path.join(box, "home/user"), { recursive: true });
  fs.mkdirSync(path.join(box, "tmp"), { recursive: true });
  const inBox = (remote: string): string => path.join(box, remote);
  const sent: BoatApiRequest[] = [];
  const transfers: string[] = [];
  // The box's own bin comes first, so a test can stand in for a program there.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: `${path.join(box, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  for (const key of Object.keys(env)) {
    if (isolatedGitKeys.test(key) && key !== "GIT_CONFIG_GLOBAL" && key !== "GIT_CONFIG_NOSYSTEM") delete env[key];
  }
  const api = {
    redact: (text: string): string => text,
    request: async (request: BoatApiRequest): Promise<Record<string, unknown>> => {
      sent.push(request);
      const [, id, action, detail] = request.path;
      if (!id) return { ok: true, sandbox: { id: "bx_0", state: "ready" } };
      if (action === "files" && detail) {
        return { ok: true, url: `https://transfer.example.test/${detail}?path=${encodeURIComponent(String(request.body?.path))}` };
      }
      if (action === "commands") {
        // The scripts quote every path; the box's root goes in front of each.
        const command = String(request.body?.command)
          .replaceAll("'/home/user", `'${box}/home/user`)
          .replaceAll("'/tmp/", `'${box}/tmp/`);
        try {
          const { stdout, stderr } = await execFile("bash", ["-c", command], { env });
          return { ok: true, exitCode: 0, stdout, stderr };
        } catch (error) {
          const failed = error as { code?: number; stdout?: string; stderr?: string };
          return { ok: true, exitCode: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
        }
      }
      return { ok: true, sandbox: { id, state: "ready" } };
    },
  };
  const remoteOf = (url: string): string => inBox(new URL(url).searchParams.get("path")!);
  const owned = new Set<string>();
  const tools = new BoatTools({
    api,
    policy: () => POLICY,
    role: "thread",
    ownedSandboxIds: () => owned,
    recordOwned: ({ sandboxId }) => void owned.add(sandboxId),
    forgetOwned: (sandboxId) => void owned.delete(sandboxId),
    workspace: {
      roots: async () => roots,
      git,
      transfer: {
        upload: async (url, file) => {
          transfers.push(url);
          fs.copyFileSync(file, remoteOf(url));
        },
        download: async (url, file) => {
          transfers.push(url);
          fs.copyFileSync(remoteOf(url), file);
        },
      },
    },
  });
  return { box, inBox, sent, tools, transfers };
}

async function repository(files: Record<string, string>): Promise<string> {
  const root = temp("repo");
  await git(root, ["init", "-q"]);
  for (const [file, content] of Object.entries(files)) write(root, file, content);
  await git(root, ["add", "-A"]);
  await git(root, [...commit, "--allow-empty"]);
  return root;
}

describe("Boat workspace push", () => {
  it("knows a .env file by name, at any depth and in any case", () => {
    for (const file of [".env", ".env.local", "apps/web/.env.production", ".ENV", "a\\.Env.test", ".env/inside.txt"]) {
      expect(isEnvFilePath(file), file).toBe(true);
    }
    for (const file of [".envrc", "env.txt", "x.env", "src/environment.ts", ".environment"]) {
      expect(isEnvFilePath(file), file).toBe(false);
    }
  });

  it("sends what Git tracks or does not ignore, and never a .env file", async () => {
    const spec = fc.record({
      directory: fc.constantFrom("", "src/", "src/deep/", "ignored-dir/", "build/"),
      name: fc.constantFrom(
        // No name differs from another only by case: whether `.env*` then
        // ignores it depends on the file system.
        "a.txt", "b.ts", ".env", ".env.local", ".env.production", "notes.log", ".envrc", "env.txt", "x.env",
      ),
      tracked: fc.boolean(),
    });
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(spec, { selector: (entry) => `${entry.directory}${entry.name}`.toLowerCase(), maxLength: 14 }),
      fc.boolean(),
      async (specs, ignoreEnv) => {
        const root = temp("push");
        await git(root, ["init", "-q"]);
        write(root, ".gitignore", `ignored-dir/\n*.log\n${ignoreEnv ? ".env*\n" : ""}`);
        for (const entry of specs) {
          const file = `${entry.directory}${entry.name}`;
          write(root, file, `content of ${file}\n`);
          // Forced in: a tracked file is sent even where a pattern would ignore it.
          if (entry.tracked) await git(root, ["add", "-f", "--", file]);
        }

        const { files, envFilesLeftOut } = await listWorkspaceFiles(root, git);
        const packed = await packWorkspace(root, files);
        directories.push(packed.directory);
        const archived: string[] = [];
        await listTar({ file: packed.archive, onReadEntry: (entry) => void archived.push(entry.path.replace(/^\.\//, "")) });

        // The model, from how each file was made and never from Git's answer.
        const env = (name: string) => name.toLowerCase() === ".env" || name.toLowerCase().startsWith(".env.");
        const ignored = (entry: (typeof specs)[number]) =>
          entry.directory === "ignored-dir/" || entry.name.endsWith(".log") || (ignoreEnv && entry.name.startsWith(".env"));
        const expected = [
          ".gitignore",
          ...specs.filter((entry) => !env(entry.name) && (entry.tracked || !ignored(entry)))
            .map((entry) => `${entry.directory}${entry.name}`),
        ];
        expect(archived.toSorted()).toEqual(expected.toSorted());
        expect(archived.filter(isEnvFilePath)).toEqual([]);
        expect(envFilesLeftOut).toBe(
          specs.filter((entry) => env(entry.name) && (entry.tracked || !ignored(entry))).length,
        );
      },
    ), { numRuns: 25 });
  }, 120_000);

  it("reads and writes only a directory of the thread, at a plain path in the sandbox", async () => {
    const root = await repository({ "a.txt": "a\n" });
    const elsewhere = await repository({ "secret.txt": "not this thread's\n" });
    const hostile = fc.oneof(
      fc.constantFrom(
        elsewhere, path.dirname(root), `${root}/..`, `${root}/sub`, "/", "", ".", "relative", `${root}x`,
        "/home/user/x'; rm -rf /; '", "/etc", "/home/user/../../etc", "/home/user", "/tmp/", "/home/user/a b",
        "/home/user/$(id)", "/home/user/ok", root,
      ),
      fc.string(),
    );
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("push_workspace", "pull_changes"),
      fc.record({ directory: fc.option(hostile, { nil: undefined }), remotePath: fc.option(hostile, { nil: undefined }) }),
      async (name, args) => {
        const { sent, tools } = world([root]);
        await tools.call("create_sandbox", {});
        const before = sent.length;
        const result = await tools.call(name, { sandboxId: "bx_0", ...args });
        const reached = sent.slice(before);
        // An empty argument is an omitted one.
        const safeDirectory = !args.directory || args.directory === root;
        const safeRemote = !args.remotePath
          || (/^\/(home\/user|tmp)(\/[A-Za-z0-9._-]+)+$/.test(args.remotePath)
            && !args.remotePath.split("/").some((part) => part === "." || part === ".."));
        if (!safeDirectory || !safeRemote) {
          // Refused before Boat hears of it or a file is read.
          expect(result.isError).toBe(true);
          expect(reached).toEqual([]);
        }
        for (const request of reached) {
          const text = JSON.stringify(request.body);
          expect(text).not.toContain(elsewhere);
          expect(text).not.toContain("rm -rf /;");
        }
      },
    ), { numRuns: 60 });
  }, 120_000);

  it.runIf(posix)("refuses a directory that already holds files, unless told to replace it", async () => {
    const root = await repository({ "a.txt": "one\n", ".env": "SECRET=1\n", "ignored.log": "x\n", ".gitignore": "*.log\n" });
    const { inBox, tools } = world([root]);
    await tools.call("create_sandbox", {});
    const first = await tools.call("push_workspace", { sandboxId: "bx_0", remotePath: "/home/user/app" });
    expect(first.structuredContent).toMatchObject({ files: 2, envFilesLeftOut: 1, remotePath: "/home/user/app" });
    expect(snapshot(inBox("/home/user/app"))).toEqual({ "a.txt": "one\n", ".gitignore": "*.log\n" });

    write(inBox("/home/user/app"), "work.txt", "in progress\n");
    const second = await tools.call("push_workspace", { sandboxId: "bx_0", remotePath: "/home/user/app" });
    expect(second.isError).toBe(true);
    expect(snapshot(inBox("/home/user/app"))["work.txt"]).toBe("in progress\n");

    await expect(tools.call("push_workspace", { sandboxId: "bx_0", remotePath: "/home/user/app", replace: true }))
      .resolves.not.toHaveProperty("isError");
    expect(snapshot(inBox("/home/user/app"))).toEqual({ "a.txt": "one\n", ".gitignore": "*.log\n" });
    // Nothing of the transfer is left in the sandbox's /tmp.
    expect(fs.readdirSync(inBox("/tmp"))).toEqual([]);
  }, 60_000);
});

describe.runIf(posix)("Boat workspace pull", () => {
  type Change = "keep" | "edit" | "delete";
  const change = fc.constantFrom<Change>("keep", "keep", "edit", "delete");
  const NAMES = ["f0.txt", "f1.txt", "src/f2.txt", "src/f3.txt"];

  it("lands every sandbox change or none, and never discards a local change", async () => {
    await fc.assert(fc.asyncProperty(
      fc.record({
        box: fc.tuple(change, change, change, change),
        local: fc.tuple(change, change, change, change),
        boxAdds: fc.boolean(),
        localAdds: fc.constantFrom("none", "other", "same"),
      }),
      async (plan) => {
        const root = await repository(Object.fromEntries(NAMES.map((name) => [name, `base ${name}\n`])));
        const { inBox, tools } = world([root]);
        await tools.call("create_sandbox", {});
        await tools.call("push_workspace", { sandboxId: "bx_0", remotePath: "/home/user/app" });
        const remote = inBox("/home/user/app");

        const apply = (where: string, who: string, changes: readonly Change[]): void => {
          changes.forEach((kind, index) => {
            const file = path.join(where, NAMES[index]!);
            if (kind === "edit") fs.writeFileSync(file, `${who} changed ${NAMES[index]}\n`);
            if (kind === "delete") fs.rmSync(file);
          });
        };
        apply(remote, "box", plan.box);
        if (plan.boxAdds) write(remote, "added.txt", "box added\n");
        apply(root, "local", plan.local);
        if (plan.localAdds === "other") write(root, "mine.txt", "local added\n");
        if (plan.localAdds === "same") write(root, "added.txt", "local added\n");

        const before = snapshot(root);
        const boxChanged = plan.box.some((kind) => kind !== "keep") || plan.boxAdds;
        const localChanged = plan.local.some((kind) => kind !== "keep") || plan.localAdds !== "none";
        const collides = plan.box.some((kind, index) => kind !== "keep" && plan.local[index] !== "keep")
          || (plan.boxAdds && plan.localAdds === "same");
        const result = await tools.call("pull_changes", { sandboxId: "bx_0", remotePath: "/home/user/app" });
        const after = snapshot(root);

        if (collides) {
          // Refused whole: the local files are exactly as they were.
          expect(result.isError).toBe(true);
          expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Nothing was changed") });
          expect(after).toEqual(before);
          return;
        }
        expect(result.isError).toBeUndefined();
        const expected = { ...before };
        plan.box.forEach((kind, index) => {
          if (kind === "edit") expected[NAMES[index]!] = `box changed ${NAMES[index]}\n`;
          if (kind === "delete") delete expected[NAMES[index]!];
        });
        if (plan.boxAdds) expected["added.txt"] = "box added\n";
        // Every sandbox change is here, and every local change still is.
        expect(after).toEqual(expected);
        if (boxChanged) {
          expect(result.structuredContent).toMatchObject({ localChangesKept: localChanged });
          // What was pulled is the new starting point: there is nothing more to pull.
          const again = await tools.call("pull_changes", { sandboxId: "bx_0", remotePath: "/home/user/app" });
          expect(again.structuredContent).toMatchObject({ files: [] });
          expect(snapshot(root)).toEqual(expected);
        } else {
          expect(result.structuredContent).toMatchObject({ files: [] });
        }
      },
    ), { numRuns: 30 });
  }, 300_000);

  it("refuses changes inside a Git directory or outside the thread's directory", async () => {
    const root = await repository({ "a.txt": "one\n" });
    const outside = path.join(path.dirname(root), `outside-${path.basename(root)}.txt`);
    directories.push(outside);
    const { box, tools } = world([root]);
    const realGit = (await execFile("bash", ["-c", "command -v git"])).stdout.trim();
    await tools.call("create_sandbox", {});
    await tools.call("push_workspace", { sandboxId: "bx_0", remotePath: "/home/user/app" });
    const cases = [
      [".git/hooks/pre-commit", "100755", "inside a Git directory"],
      [`../${path.basename(outside)}`, "100644", "Nothing was changed"],
    ] as const;
    for (const [file, mode, reason] of cases) {
      const before = snapshot(root);
      // The sandbox is the agent's: its `git diff` can print anything.
      const patch = [
        `diff --git a/${file} b/${file}`, `new file mode ${mode}`, "--- /dev/null", `+++ b/${file}`,
        "@@ -0,0 +1 @@", "+planted", "",
      ].join("\n");
      fs.mkdirSync(path.join(box, "bin"), { recursive: true });
      fs.writeFileSync(path.join(box, "planted.patch"), patch);
      fs.writeFileSync(
        path.join(box, "bin/git"),
        `#!/bin/sh\ncase "$1" in diff) cat '${path.join(box, "planted.patch")}';; *) exec '${realGit}' "$@";; esac\n`,
        { mode: 0o755 },
      );
      const result = await tools.call("pull_changes", { sandboxId: "bx_0", remotePath: "/home/user/app" });
      expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining(reason) }] });
      expect(snapshot(root)).toEqual(before);
      expect(fs.existsSync(path.join(root, ".git/hooks/pre-commit"))).toBe(false);
      expect(fs.existsSync(outside)).toBe(false);
    }
  }, 60_000);

  it("says so when the sandbox directory was not pushed by PwrAgent", async () => {
    const root = await repository({ "a.txt": "one\n" });
    const { inBox, tools } = world([root]);
    await tools.call("create_sandbox", {});
    fs.mkdirSync(inBox("/home/user/app"), { recursive: true });
    await execFile("git", ["-C", inBox("/home/user/app"), "init", "-q"]);
    const result = await tools.call("pull_changes", { sandboxId: "bx_0", remotePath: "/home/user/app" });
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("was not put there by push_workspace") }] });
  }, 60_000);
});
