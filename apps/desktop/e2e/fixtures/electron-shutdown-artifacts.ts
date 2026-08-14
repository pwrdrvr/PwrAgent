import type { Dirent } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { ElectronShutdownSummary } from "./electron-shutdown-policy";

export const E2E_SHUTDOWN_FIRST_FAILURE_ARTIFACT_DIR_ENV =
  "PWRAGENT_E2E_SHUTDOWN_FIRST_FAILURE_ARTIFACT_DIR";

const CAPTURE_CLAIM_FILE = "capture-claimed.json";
const MAX_MAIN_LOG_FILES = 4;
const MAX_LOG_SEARCH_DEPTH = 6;

export type ElectronProcessTreeSnapshot = {
  capturedAt: string;
  descendantPids: number[];
  exitCode: number | null;
  killed: boolean;
  platform: NodeJS.Platform;
  rootPid: number | null;
  signalCode: NodeJS.Signals | null;
};

type MainLogCandidate = {
  absolutePath: string;
  relativePath: string;
};

/**
 * Preserve only the first abnormal fixture from a shard. The temporary E2E
 * home is removed during ordinary teardown, so its Electron main log must be
 * copied before that cleanup runs. The exclusive claim keeps retries and
 * replacement workers from overwriting the original failure evidence.
 */
export async function captureFirstElectronShutdownFailure(params: {
  artifactDir: string;
  homeRoot: string;
  processTree?: ElectronProcessTreeSnapshot;
  summary: ElectronShutdownSummary;
}): Promise<boolean> {
  if (params.summary.classification === "healthy") {
    return false;
  }

  await mkdir(params.artifactDir, { recursive: true });
  const claimPath = path.join(params.artifactDir, CAPTURE_CLAIM_FILE);
  let claim: Awaited<ReturnType<typeof open>>;
  try {
    claim = await open(claimPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }

  try {
    await claim.writeFile(
      `${JSON.stringify({
        capturedAt: new Date().toISOString(),
        launchId: params.summary.launchId,
      }, null, 2)}\n`,
      "utf8",
    );
  } finally {
    await claim.close();
  }

  const candidates = await findMainLogs(params.homeRoot);
  const copiedLogs: Array<{
    artifactName: string;
    sourceRelativePath: string;
  }> = [];
  const copyErrors: Array<{
    error: string;
    sourceRelativePath: string;
  }> = [];
  for (const [index, candidate] of candidates.entries()) {
    const artifactName = `${index + 1}-${path.basename(candidate.absolutePath)}`;
    try {
      await copyFile(
        candidate.absolutePath,
        path.join(params.artifactDir, artifactName),
      );
      copiedLogs.push({
        artifactName,
        sourceRelativePath: candidate.relativePath,
      });
    } catch (error) {
      copyErrors.push({
        error: error instanceof Error ? error.message : String(error),
        sourceRelativePath: candidate.relativePath,
      });
    }
  }

  await writeFile(
    path.join(params.artifactDir, "shutdown-failure.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      summary: params.summary,
      processTree: params.processTree ?? null,
      mainLogs: copiedLogs,
      copyErrors,
    }, null, 2)}\n`,
    "utf8",
  );
  return true;
}

async function findMainLogs(homeRoot: string): Promise<MainLogCandidate[]> {
  const candidates: MainLogCandidate[] = [];
  await visit(homeRoot, "", 0);
  return candidates.slice(0, MAX_MAIN_LOG_FILES);

  async function visit(
    directory: string,
    relativeDirectory: string,
    depth: number,
  ): Promise<void> {
    if (depth > MAX_LOG_SEARCH_DEPTH || candidates.length >= MAX_MAIN_LOG_FILES) {
      return;
    }
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (candidates.length >= MAX_MAIN_LOG_FILES) {
        return;
      }
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath, depth + 1);
      } else if (
        entry.isFile()
        && /^profile-[A-Za-z0-9._-]+\.main\.log$/.test(entry.name)
      ) {
        candidates.push({ absolutePath, relativePath });
      }
    }
  }
}
