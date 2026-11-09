import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { hasWorktreeRegistration, inspectRegisterableWorktree } from "../app-server/worktree-maintenance-registration";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function git(cwd: string, args: string[]) {
  return (await execute("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "-c", "commit.gpgsign=false", ...args])).stdout;
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-registration-oracle-")));
  roots.push(root);
  const repo = path.join(root, "repo");
  const checkout = path.join(root, "outside");
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await writeFile(path.join(repo, "file"), "fixture\n");
  await git(repo, ["add", "file"]);
  await git(repo, ["commit", "-m", "fixture"]);
  await git(repo, ["worktree", "add", "--detach", checkout]);
  const registration = { ...await inspectRegisterableWorktree(checkout), authorizedAt: 1,
    requestedBy: { backend: "codex" as const, threadId: "operator-agent" } };
  return { root, repo, checkout, registration };
}

describe("explicit checkout registration identity (real Git oracle)", () => {
  it("authorizes only the original linked checkout after arbitrary filesystem transitions", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom("observe", "move", "replace", "alias", "main", "forget"), { minLength: 1, maxLength: 4 }),
      async (operations) => {
        const { root, repo, checkout, registration } = await fixture();
        let present = true;
        let original = true;
        let moved = false;
        let alias = false;
        let revoked = false;
        for (const [index, operation] of operations.entries()) {
          if (operation === "forget") revoked = true;
          if ((operation === "move" || operation === "alias") && present && !alias) {
            const destination = path.join(root, `moved-${index}`);
            await git(repo, ["worktree", "move", checkout, destination]);
            present = false;
            moved = true;
            if (operation === "alias") {
              await symlink(destination, checkout, process.platform === "win32" ? "junction" : "dir");
              alias = true;
            }
          }
          if (operation === "replace" && present && !alias) {
            await git(repo, ["worktree", "remove", checkout]);
            await git(repo, ["worktree", "add", "--detach", checkout]);
            original = false;
          }
          const target = operation === "main" ? repo : checkout;
          // Git owns membership; the authorization additionally belongs to the
          // original directory identity and can never follow an alias or move.
          const expected = operation !== "main" && present && original && !moved && !alias && !revoked;
          expect(await hasWorktreeRegistration(target, revoked ? [] : [registration])).toBe(expected);
        }
      },
    ), { numRuns: 10 });
  });

  it("refuses a copied .git file that points at another worktree's administration", async () => {
    const { root, registration } = await fixture();
    const impostor = path.join(root, "impostor");
    await mkdir(impostor);
    await writeFile(path.join(impostor, ".git"), `gitdir: ${registration.gitDirectory}\n`);
    await expect(inspectRegisterableWorktree(impostor)).rejects.toThrow();
  });
});
