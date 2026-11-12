import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeBundledSkills } from "../bundled-skill-root";
import { PWRAGENT_CODEX_SKILLS, PWRAGENT_WORKFLOW_SKILLS } from "../pwragent-workflow-skills";

const REPO_ROOT = path.resolve(__dirname, "../../../../../..");
const OUTPOST_SKILL = PWRAGENT_WORKFLOW_SKILLS.find((skill) => skill.name === "outpost-security-research");

function bundledText(file: string): string {
  const entry = OUTPOST_SKILL?.files.find((candidate) => candidate.path === file);
  if (!entry) throw new Error(`The outpost skill ships no ${file}.`);
  return entry.text;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "bundled-skill-root-"));
  roots.push(root);
  return root;
}

describe("bundled skill root", () => {
  it("writes every file of every Codex skill, with scripts executable", async () => {
    const root = path.join(tempRoot(), "skills", "bundled");
    await expect(materializeBundledSkills(root)).resolves.toBe(root);
    for (const skill of PWRAGENT_CODEX_SKILLS) {
      for (const file of skill.files) {
        const target = path.join(root, skill.name, ...file.path.split("/"));
        expect(readFileSync(target, "utf8")).toBe(file.text);
        const mode = (await fs.stat(target)).mode & 0o777;
        if (process.platform !== "win32") expect(mode).toBe(file.executable ? 0o755 : 0o644);
      }
    }
    expect(PWRAGENT_CODEX_SKILLS.flatMap((skill) => skill.files).some((file) => file.executable)).toBe(true);
  });

  it("removes what an earlier release shipped, keeps unchanged files, and touches nothing outside the root", async () => {
    const base = tempRoot();
    const root = path.join(base, "bundled");
    const [skill] = PWRAGENT_CODEX_SKILLS;
    await fs.mkdir(path.join(root, "retired-skill"), { recursive: true });
    await fs.writeFile(path.join(root, "retired-skill", "SKILL.md"), "old");
    await fs.mkdir(path.join(root, skill.name, "scripts"), { recursive: true });
    await fs.writeFile(path.join(root, skill.name, "scripts", "retired.sh"), "old");
    await fs.writeFile(path.join(root, skill.name, "SKILL.md"), "edited by hand");
    await fs.writeFile(path.join(base, "neighbour.txt"), "keep");

    await materializeBundledSkills(root);
    await expect(fs.readdir(root)).resolves.toEqual(PWRAGENT_CODEX_SKILLS.map((entry) => entry.name).sort());
    await expect(fs.stat(path.join(root, skill.name, "scripts", "retired.sh"))).rejects.toThrow();
    expect(readFileSync(path.join(root, skill.name, "SKILL.md"), "utf8")).toBe(skill.files[0].text);
    expect(readFileSync(path.join(base, "neighbour.txt"), "utf8")).toBe("keep");

    const skillFile = path.join(root, skill.name, "SKILL.md");
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(skillFile, past, past);
    await materializeBundledSkills(root);
    expect((await fs.stat(skillFile)).mtimeMs).toBe(past.getTime());
  });

  it("ships the same relay and Dockerfile the repository uses", () => {
    expect(bundledText("scripts/tcp-relay.mjs")).toBe(readFileSync(
      path.join(REPO_ROOT, ".agents/skills/outpost-docker-lab/scripts/tcp-relay.mjs"), "utf8",
    ).replace(/\r\n/gu, "\n"));
    expect(bundledText("Dockerfile")).toBe(readFileSync(
      path.join(REPO_ROOT, "packages/pwragent/Dockerfile"), "utf8",
    ).replace(/\r\n/gu, "\n"));
  });

  it("names every script the skill ships, and ships every script it names", () => {
    const body = bundledText("SKILL.md");
    const shipped = OUTPOST_SKILL?.files.map((file) => file.path).filter((file) => file.startsWith("scripts/")) ?? [];
    const named = [...new Set([...body.matchAll(/scripts\/([a-z-]+\.(?:sh|mjs))/gu)].map((match) => `scripts/${match[1]}`))];
    expect(shipped).toEqual(expect.arrayContaining(named));
    for (const file of shipped) {
      expect(body).toContain(`\`${path.basename(file)}\``);
    }
  });
});
