import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import * as gitBoundary from "../app-server/git-executable";
import { MissingArchiveRepositoryError, WorktreeArchiveService } from "../app-server/worktree-archive-service";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import { ArchiveWorktreeTransport } from "./fixtures/archive-worktree-transport";

vi.mock("../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock("../codex-app-server/stdio-transport", async () => ({
  StdioJsonRpcTransport: (await import("./fixtures/archive-worktree-transport")).ArchiveWorktreeTransport,
}));

const execute = promisify(execFile);

async function cleanupScenario(options: {
  additionalExists: boolean; activeOwner: boolean; external: boolean; disappearsDuringArchive?: boolean;
  missingGitMarker?: "removed-with-checkout" | "marker-only" | "during-probe"; residualFile?: string; nested?: boolean;
}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-cleanup-presence-")));
  const repositoryPath = path.join(root, "repository");
  const primary = path.join(root, "primary");
  const additional = path.join(options.nested ? repositoryPath : root, "additional");
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  const service = new WorktreeArchiveService();
  const directories = [primary, additional].map((worktreePath) => ({
    id: worktreePath, kind: "worktree" as const, label: path.basename(worktreePath), path: repositoryPath, worktreePath,
  }));
  const client = new CodexAppServerClient({ directoryResolver: async (cwd) =>
    cwd === primary ? directories : [directories[0]!] });
  const registry = createDesktopBackendRegistry({ codexClient: client, overlayStore: store, worktreeArchiveService: service,
    messagingStore: null, threadTitleGenerationService: null });
  let gitProbe: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await mkdir(repositoryPath);
    const git = async (args: string[]) => await execute("git", ["-C", repositoryPath, ...args]);
    await git(["init", "-b", "main"]);
    await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"]);
    for (const worktree of [primary, additional]) await git(["worktree", "add", "--detach", worktree]);
    const contents = options.residualFile ?? "unsaved work\n";
    await writeFile(path.join(additional, "keep.txt"), contents);
    // Git created both checkouts. Their folders and repository can disappear
    // independently; the filesystem, not the thread's primary link, is the oracle.
    await rm(primary, { recursive: true });
    if (options.missingGitMarker === "removed-with-checkout") {
      await git(["worktree", "remove", "--force", additional]);
      await mkdir(additional);
      await writeFile(path.join(additional, "keep.txt"), contents);
    } else if (options.missingGitMarker === "marker-only") {
      await rm(path.join(additional, ".git"));
    } else if (options.missingGitMarker === "during-probe") {
      const runGit = gitBoundary.runGitCommand;
      gitProbe = vi.spyOn(gitBoundary, "runGitCommand").mockImplementation(async (cwd, args, settings) => {
        if (cwd === additional && args[0] === "rev-parse" && args[1] === "--absolute-git-dir") {
          await rm(path.join(additional, ".git"));
        }
        return await runGit(cwd, args, settings);
      });
    } else {
      await rm(repositoryPath, { recursive: true });
    }
    if (!options.additionalExists) await rm(additional, { recursive: true });
    ArchiveWorktreeTransport.threads = [{ id: "owner", cwd: primary, source: "cli" },
      ...(options.activeOwner ? [{ id: "active-sibling", cwd: path.join(primary, "nested"), source: "cli" }] : [])];
    if (options.external) await store.addLinkedDirectory({ backend: "codex", threadId: "owner",
      directory: { ...directories[0]!, worktreeOwnership: "external" } });
    if (options.disappearsDuringArchive) vi.spyOn(service, "archive").mockImplementation(async (params) => {
      await rm(params.worktreePath, { recursive: true, force: true });
      throw new MissingArchiveRepositoryError(params.worktreePath, repositoryPath);
    });
    const response = await registry.archiveThread({ backend: "codex", threadId: "owner" });
    for (const item of response.cleanup) {
      const exists = await stat(item.worktreePath!).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      expect(item.error).toBeUndefined();
      expect(item.removedWorktree).toBe(false);
      if (!exists) {
        expect(item.skippedReason).toBe("Worktree directory no longer exists.");
        expect(item.blockingThreads).toBeUndefined();
      } else if (options.missingGitMarker) {
        expect(item).toMatchObject({ worktreeState: "present",
          skippedReason: "The worktree folder still exists, but its .git entry is missing. The folder was kept." });
        expect(await readFile(path.join(additional, "keep.txt"), "utf8")).toBe(contents);
        expect(await git(["for-each-ref", "--format=%(refname)", "refs/codex/snapshots/"])).toMatchObject({ stdout: "" });
      } else {
        expect(item.skippedReason).toBe("The worktree folder still exists, but its repository is gone. The folder was kept without a snapshot.");
        expect(item).toMatchObject({ worktreeState: "present", repositoryPath });
        expect(await readFile(path.join(additional, "keep.txt"), "utf8")).toBe("unsaved work\n");
      }
    }
    expect(new Set(response.cleanup.map((item) => item.worktreePath))).toEqual(new Set([primary, additional]));
  } finally {
    gitProbe?.mockRestore();
    await registry.close();
    db.close();
    ArchiveWorktreeTransport.threads = [];
    ArchiveWorktreeTransport.requests = [];
    await rm(root, { recursive: true, force: true });
  }
}

// Cover all eight inputs, including the missing primary with a retained
// additional checkout and the absent checkouts with stale ownership. Each
// input is its own test: every one runs real Git, and together they exceed
// one test's time budget on a slow CI runner.
const presenceInputs = [false, true].flatMap((additionalExists) => [false, true].flatMap((activeOwner) =>
  [false, true].map((external) => ({ additionalExists, activeOwner, external }))));

it.each(presenceInputs)(
  "never reports an absent checkout as kept, regardless of ownership or another checkout's presence (additional exists $additionalExists, active owner $activeOwner, external $external)",
  async (input) => {
    await cleanupScenario(input);
  },
);

it("rechecks the folder before claiming a missing-repository checkout was kept", async () => {
  await cleanupScenario({ additionalExists: true, activeOwner: false, external: false, disappearsDuringArchive: true });
});

it("keeps files in a residual folder after Git removed its checkout", async () => {
  await cleanupScenario({ additionalExists: true, activeOwner: false, external: false, missingGitMarker: "removed-with-checkout" });
});

it("keeps a Git-less folder inside the repository where Git discovers the primary checkout", async () => {
  await cleanupScenario({ additionalExists: true, activeOwner: false, external: false, missingGitMarker: "marker-only", nested: true });
});

it("reports and preserves Git-less worktree folders regardless of remaining registration", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("removed-with-checkout" as const, "marker-only" as const, "during-probe" as const),
    fc.string({ minLength: 1, maxLength: 40 }), fc.boolean(), async (missingGitMarker, residualFile, nested) => {
      await cleanupScenario({ additionalExists: true, activeOwner: false, external: false, missingGitMarker, residualFile, nested });
    }), { numRuns: 5, examples: [
    ["removed-with-checkout", "remaining data", true], ["marker-only", "unsaved work", true], ["during-probe", "remaining data", false],
  ] });
});
