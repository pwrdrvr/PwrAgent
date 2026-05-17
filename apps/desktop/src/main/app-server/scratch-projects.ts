import { randomBytes } from "node:crypto";
import os from "node:os";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  resolveActiveProfileName,
  resolveActiveProfilePath,
  resolvePwragentRoot,
} from "../profile";

function formatLocalDatePrefix(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function resolveScratchProjectsRoot(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): string {
  return resolveActiveProfilePath("projects", options);
}

export function resolveScratchProjectsRoots(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): string[] {
  const roots = [resolveScratchProjectsRoot(options)];
  if (resolveActiveProfileName(options) === "default") {
    roots.push(path.join(resolvePwragentRoot(options), "projects"));
    roots.push(path.join(options?.homeDir ?? os.homedir(), ".pwragnt", "projects"));
  }
  return roots;
}

export async function createScratchProjectDirectory(
  now = new Date()
): Promise<string> {
  const projectsRoot = resolveScratchProjectsRoot();
  await fs.mkdir(projectsRoot, { recursive: true });

  const prefix = formatLocalDatePrefix(now);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = randomBytes(3).toString("hex");
    const scratchProjectPath = path.join(projectsRoot, `${prefix}-${suffix}`);

    try {
      await fs.mkdir(scratchProjectPath);
      return scratchProjectPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }

  throw new Error("Unable to create a unique scratch project directory.");
}
