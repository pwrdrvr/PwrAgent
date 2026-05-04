import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type CodexSessionMetadataServiceOptions = {
  codexHome?: string;
  homeDir?: string;
};

type UpdateCodexSessionCwdResult = {
  path?: string;
  reason?: "missing-session" | "missing-session-meta" | "unchanged";
  updated: boolean;
};

type SessionFileCandidate = {
  mtimeMs: number;
  path: string;
};

export class CodexSessionMetadataService {
  private readonly codexHome?: string;
  private readonly homeDir?: string;

  constructor(options: CodexSessionMetadataServiceOptions = {}) {
    this.codexHome = options.codexHome;
    this.homeDir = options.homeDir;
  }

  async updateThreadCwd(params: {
    cwd: string;
    threadId: string;
  }): Promise<UpdateCodexSessionCwdResult> {
    const threadId = params.threadId.trim();
    const cwd = params.cwd.trim();
    if (!threadId || !cwd) {
      return { updated: false, reason: "missing-session" };
    }

    const sessionPath = await this.findSessionFile(threadId);
    if (!sessionPath) {
      return { updated: false, reason: "missing-session" };
    }

    const contents = await readFile(sessionPath, "utf8");
    const hadTrailingNewline = contents.endsWith("\n");
    const lines = contents.split("\n");
    let changed = false;
    let foundSessionMeta = false;

    const nextLines = lines.map((line) => {
      if (!line.trim() || foundSessionMeta) {
        return line;
      }

      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        return line;
      }

      if (!isSessionMetaRecord(record, threadId)) {
        return line;
      }

      foundSessionMeta = true;
      if (record.payload.cwd === cwd) {
        return line;
      }

      changed = true;
      return JSON.stringify({
        ...record,
        payload: {
          ...record.payload,
          cwd,
        },
      });
    });

    if (!foundSessionMeta) {
      return { updated: false, path: sessionPath, reason: "missing-session-meta" };
    }
    if (!changed) {
      return { updated: false, path: sessionPath, reason: "unchanged" };
    }

    const nextContents = normalizeTrailingNewline(nextLines.join("\n"), hadTrailingNewline);
    const tempPath = `${sessionPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, nextContents, "utf8");
    await rename(tempPath, sessionPath);

    return { updated: true, path: sessionPath };
  }

  private async findSessionFile(threadId: string): Promise<string | undefined> {
    const sessionsRoot = path.join(this.resolveCodexHome(), "sessions");
    const candidates = await collectSessionFileCandidates(sessionsRoot, threadId);
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0]?.path;
  }

  private resolveCodexHome(): string {
    if (this.codexHome?.trim()) {
      return this.codexHome.trim();
    }

    if (this.homeDir === undefined) {
      const envCodexHome = process.env.CODEX_HOME?.trim();
      if (envCodexHome) {
        return envCodexHome;
      }
    }

    return path.join(this.homeDir ?? os.homedir(), ".codex");
  }
}

async function collectSessionFileCandidates(
  root: string,
  threadId: string,
): Promise<SessionFileCandidate[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates: SessionFileCandidate[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        candidates.push(...(await collectSessionFileCandidates(entryPath, threadId)));
        return;
      }

      if (!entry.isFile() || !entry.name.endsWith(`${threadId}.jsonl`)) {
        return;
      }

      const fileStat = await stat(entryPath);
      candidates.push({ path: entryPath, mtimeMs: fileStat.mtimeMs });
    }),
  );

  return candidates;
}

function isSessionMetaRecord(
  record: unknown,
  threadId: string,
): record is {
  payload: { cwd?: string; id?: string };
  type: "session_meta";
} {
  if (!record || typeof record !== "object") {
    return false;
  }
  const candidate = record as { payload?: unknown; type?: unknown };
  if (candidate.type !== "session_meta") {
    return false;
  }
  if (!candidate.payload || typeof candidate.payload !== "object") {
    return false;
  }
  const payload = candidate.payload as { id?: unknown };
  return payload.id === undefined || payload.id === threadId;
}

function normalizeTrailingNewline(contents: string, hadTrailingNewline: boolean): string {
  if (hadTrailingNewline) {
    return contents.endsWith("\n") ? contents : `${contents}\n`;
  }

  return contents.endsWith("\n") ? contents.slice(0, -1) : contents;
}
