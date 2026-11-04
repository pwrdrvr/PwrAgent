import { createHash } from "node:crypto";
import waitingOnWork from "./skills/waiting-on-work/SKILL.md?raw";
import toolGuide from "./skills/tool-guide/SKILL.md?raw";

export const PWRAGENT_SKILLS_EXTENSION = "io.modelcontextprotocol/skills";

// Explicit app-bundled content, never a URI-to-filesystem mapping. Parse only
// our authored name/description frontmatter rather than arbitrary YAML.
function bundledSkill(source: string) {
  // Git may check Markdown out with CRLF on Windows. Serve canonical LF on
  // every platform so frontmatter, sizes, and digests stay consistent.
  const text = source.replace(/\r\n/gu, "\n");
  const match = /^---\nname: ([a-z-]+)\ndescription: ([^\n]+)\n---\n/u.exec(text);
  if (!match) {
    throw new Error("Invalid bundled PwrAgent skill frontmatter.");
  }
  const [, name, description] = match;
  const uri = `skill://${name}/SKILL.md`;
  const size = Buffer.byteLength(text, "utf8");
  return {
    entry: {
      uri,
      frontmatter: { name, description },
      resources: [{
        uri,
        digest: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
        size,
      }],
    },
    resource: { uri, name, description, mimeType: "text/markdown", size },
    content: { uri, mimeType: "text/markdown", text },
    body: text.slice(match[0].length).trim(),
  };
}

export const PWRAGENT_WORKFLOW_SKILLS = [
  bundledSkill(waitingOnWork),
  bundledSkill(toolGuide),
];

// Tools-only clients can still load the same authored guidance. Keep the
// read_tool_guide response envelope and both its text and structured surfaces.
export const PWRAGENT_COMPATIBILITY_TOOL_GUIDE = PWRAGENT_WORKFLOW_SKILLS
  .map((skill) => skill.body)
  .join("\n\n");
