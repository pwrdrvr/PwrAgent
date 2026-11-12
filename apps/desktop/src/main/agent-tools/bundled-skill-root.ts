import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePwragentRoot } from "../profile";
import { PWRAGENT_CODEX_SKILLS, type BundledSkill } from "./pwragent-workflow-skills";

/** The folder Codex scans for the skills PwrAgent ships. PwrAgent owns it. */
export function bundledSkillRoot(pwragentRoot = resolvePwragentRoot()): string {
  return path.join(pwragentRoot, "skills", "bundled");
}

async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeIfChanged(file: string, text: string, mode: number): Promise<void> {
  if (await readIfPresent(file) !== text) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Codex may read the folder while another PwrAgent process writes it.
    const staged = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(staged, text, { mode });
    await fs.rename(staged, file);
  }
  await fs.chmod(file, mode);
}

/**
 * Writes the bundled skills into `root`, one folder per skill, and returns
 * `root`. A file is rewritten only when its content differs. Anything else
 * inside `root` is a skill or file an earlier PwrAgent shipped and is removed.
 */
export async function materializeBundledSkills(
  root: string,
  skills: readonly BundledSkill[] = PWRAGENT_CODEX_SKILLS,
): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  const expected = new Map<string, { text: string; mode: number }>();
  for (const skill of skills) {
    for (const file of skill.files) {
      expected.set(path.join(root, skill.name, ...file.path.split("/")), {
        text: file.text,
        mode: file.executable ? 0o755 : 0o644,
      });
    }
  }
  const skillNames = new Set(skills.map((skill) => skill.name));
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!skillNames.has(entry.name)) {
      await fs.rm(path.join(root, entry.name), { recursive: true, force: true });
    }
  }
  for (const name of skillNames) {
    const folder = path.join(root, name);
    const present = await fs.readdir(folder, { recursive: true, withFileTypes: true }).catch(() => []);
    for (const entry of present) {
      const file = path.join(entry.parentPath, entry.name);
      if (!entry.isDirectory() && !expected.has(file)) await fs.rm(file, { force: true });
    }
  }
  for (const [file, { text, mode }] of expected) {
    await writeIfChanged(file, text, mode);
  }
  return root;
}
