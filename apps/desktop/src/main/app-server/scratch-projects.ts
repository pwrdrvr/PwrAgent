import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

function formatLocalDatePrefix(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function createScratchProjectDirectory(
  now = new Date()
): Promise<string> {
  const projectsRoot = path.join(os.homedir(), ".pwragnt", "projects");
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
