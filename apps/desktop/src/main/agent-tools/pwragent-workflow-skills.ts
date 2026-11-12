import { createHash } from "node:crypto";
import waitingOnWork from "./skills/waiting-on-work/SKILL.md?raw";
import toolGuide from "./skills/tool-guide/SKILL.md?raw";
import outpostSecurityResearch from "./skills/outpost-security-research/SKILL.md?raw";
import outpostDockerfile from "./skills/outpost-security-research/Dockerfile?raw";
import outpostTcpRelay from "./skills/outpost-security-research/scripts/tcp-relay.mjs?raw";
import outpostModelKeyProxy from "./skills/outpost-security-research/scripts/model-key-proxy.mjs?raw";
import outpostStartModelKeyProxy from "./skills/outpost-security-research/scripts/start-model-key-proxy.sh?raw";
import outpostRunModelKeyProxy from "./skills/outpost-security-research/scripts/run-model-key-proxy.sh?raw";
import outpostInstallLaunchAgents from "./skills/outpost-security-research/scripts/install-launch-agents.sh?raw";
import outpostSetupNetwork from "./skills/outpost-security-research/scripts/setup-network.sh?raw";
import outpostPushRepo from "./skills/outpost-security-research/scripts/push-repo.sh?raw";
import outpostPullBranch from "./skills/outpost-security-research/scripts/pull-branch.sh?raw";
import outpostDepsHelper from "./skills/outpost-security-research/scripts/deps-helper.sh?raw";

export const PWRAGENT_SKILLS_EXTENSION = "io.modelcontextprotocol/skills";

type BundledSkillFile = {
  /** Path inside the skill folder, with forward slashes. */
  path: string;
  text: string;
  mimeType: string;
  executable: boolean;
};

export type BundledSkill = ReturnType<typeof bundledSkill>;

function canonicalText(source: string): string {
  // Git may check files out with CRLF on Windows. Serve canonical LF on
  // every platform so frontmatter, sizes, and digests stay consistent.
  return source.replace(/\r\n/gu, "\n");
}

function supportingFile(path: string, source: string): BundledSkillFile {
  const executable = path.endsWith(".sh");
  const mimeType = executable
    ? "text/x-shellscript"
    : path.endsWith(".mjs") ? "text/javascript" : "text/plain";
  return { path, text: canonicalText(source), mimeType, executable };
}

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

// Explicit app-bundled content, never a URI-to-filesystem mapping. Parse only
// our authored name/description frontmatter rather than arbitrary YAML.
function bundledSkill(source: string, supportingFiles: readonly BundledSkillFile[] = []) {
  const text = canonicalText(source);
  const match = /^---\nname: ([a-z-]+)\ndescription: ([^\n]+)\n---\n/u.exec(text);
  if (!match) {
    throw new Error("Invalid bundled PwrAgent skill frontmatter.");
  }
  const [, name, description] = match;
  const files: BundledSkillFile[] = [
    { path: "SKILL.md", text, mimeType: "text/markdown", executable: false },
    ...supportingFiles,
  ];
  const withUris = files.map((file) => ({
    ...file,
    uri: `skill://${name}/${file.path}`,
    size: Buffer.byteLength(file.text, "utf8"),
  }));
  const [skillFile] = withUris;
  return {
    name,
    entry: {
      uri: skillFile.uri,
      frontmatter: { name, description },
      resources: withUris.map((file) => ({
        uri: file.uri,
        digest: digestOf(file.text),
        size: file.size,
      })),
    },
    resources: withUris.map((file) => ({
      uri: file.uri,
      name: file.path === "SKILL.md" ? name : `${name}/${file.path}`,
      ...(file.path === "SKILL.md" ? { description } : {}),
      mimeType: file.mimeType,
      size: file.size,
    })),
    contents: withUris.map((file) => ({ uri: file.uri, mimeType: file.mimeType, text: file.text })),
    files: files.map(({ path, text: fileText, executable }) => ({ path, text: fileText, executable })),
    body: text.slice(match[0].length).trim(),
  };
}

const WORKFLOW_SKILLS = [
  bundledSkill(waitingOnWork),
  bundledSkill(toolGuide),
];

const OUTPOST_SECURITY_RESEARCH_SKILL = bundledSkill(outpostSecurityResearch, [
  supportingFile("Dockerfile", outpostDockerfile),
  supportingFile("scripts/tcp-relay.mjs", outpostTcpRelay),
  supportingFile("scripts/model-key-proxy.mjs", outpostModelKeyProxy),
  supportingFile("scripts/start-model-key-proxy.sh", outpostStartModelKeyProxy),
  supportingFile("scripts/run-model-key-proxy.sh", outpostRunModelKeyProxy),
  supportingFile("scripts/install-launch-agents.sh", outpostInstallLaunchAgents),
  supportingFile("scripts/setup-network.sh", outpostSetupNetwork),
  supportingFile("scripts/push-repo.sh", outpostPushRepo),
  supportingFile("scripts/pull-branch.sh", outpostPullBranch),
  supportingFile("scripts/deps-helper.sh", outpostDepsHelper),
]);

/** Every skill the PwrAgent MCP server serves to clients that have its tools. */
export const PWRAGENT_WORKFLOW_SKILLS = [
  ...WORKFLOW_SKILLS,
  OUTPOST_SECURITY_RESEARCH_SKILL,
];

/**
 * Skills Codex loads from disk. Codex reaches PwrAgent through dynamic tools,
 * not this MCP server, so it gets these as files under an extra skill root.
 * The workflow skills already reach it through `read_tool_guide`.
 */
export const PWRAGENT_CODEX_SKILLS = [OUTPOST_SECURITY_RESEARCH_SKILL];

// Tools-only clients can still load the same authored guidance. Keep the
// read_tool_guide response envelope and both its text and structured surfaces.
// The guide holds tool guidance only, never the operator setup skills.
export const PWRAGENT_COMPATIBILITY_TOOL_GUIDE = WORKFLOW_SKILLS
  .map((skill) => skill.body)
  .join("\n\n");
