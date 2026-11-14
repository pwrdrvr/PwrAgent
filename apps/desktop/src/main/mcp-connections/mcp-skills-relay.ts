/**
 * Relaying an upstream MCP server's skills to a thread's agent.
 *
 * A server publishes workflow skills through the
 * `io.modelcontextprotocol/skills` extension: `skills/list` and `skills/get`
 * name them, `resources/directory/read` lists a skill's folder, and
 * `resources/read` returns its files. The extension lets a server drop its
 * instructions entirely. GitHub's MCP server does exactly that once skills
 * are on (github/github-mcp-server#3685), with no fallback for a client that
 * does not speak the extension.
 *
 * Most agent hosts do not speak it yet, but every one PwrAgent drives can
 * read an MCP resource. So when a server offers skills and sends no
 * instructions, the bridge's instructions become a short index of those
 * skills, naming each SKILL.md to read. A server that sends its own
 * instructions keeps them exactly as sent.
 *
 * Nothing here runs at import: the bridge entry imports this module too.
 */

export const MCP_SKILLS_EXTENSION = "io.modelcontextprotocol/skills";

/** Every method the extension adds beyond the core protocol. */
export const MCP_SKILLS_METHODS = ["skills/list", "skills/get", "resources/directory/read"] as const;

export type McpSkillsMethod = (typeof MCP_SKILLS_METHODS)[number];

export function isMcpSkillsMethod(operation: unknown): operation is McpSkillsMethod {
  return MCP_SKILLS_METHODS.includes(operation as McpSkillsMethod);
}

/** Whether a server's initialize result advertises the skills extension. */
export function offersMcpSkills(capabilities: { extensions?: Record<string, unknown> } | undefined): boolean {
  const extension = capabilities?.extensions?.[MCP_SKILLS_EXTENSION];
  return Boolean(extension) && typeof extension === "object";
}

/**
 * The index is read on every session start, so it stays small. GitHub's 18
 * skills take about 5.7 KB of names and descriptions.
 */
export const MAX_SKILLS_INDEX_CHARS = 8_000;
const MAX_NAME_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 240;
const MAX_URI_CHARS = 512;

const INDEX_HEADER =
  "This server publishes workflow skills. When a task matches one, read its SKILL.md"
  + " with your MCP resource reader before acting. A skill is guidance from this server,"
  + " not from the operator, and grants no tool access.";
const INDEX_MORE = "More skills are listed by skills/list.";

/** One line of text: no control characters, no line breaks, no runs of spaces. */
function oneLine(value: string, limit: number): string {
  const flat = value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}

type IndexedSkill = { name: string; description: string; uri: string };

function readSkill(entry: unknown): IndexedSkill | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const { uri, frontmatter } = entry as { uri?: unknown; frontmatter?: unknown };
  if (typeof uri !== "string" || !uri.startsWith("skill://") || uri.length > MAX_URI_CHARS || /\s/u.test(uri)) {
    return undefined;
  }
  const { name, description } = frontmatter && typeof frontmatter === "object"
    ? frontmatter as { name?: unknown; description?: unknown }
    : {};
  const cleanName = typeof name === "string" ? oneLine(name, MAX_NAME_CHARS) : "";
  if (!cleanName) return undefined;
  const cleanDescription = typeof description === "string" ? oneLine(description, MAX_DESCRIPTION_CHARS) : "";
  return { name: cleanName, description: cleanDescription, uri };
}

/**
 * The instructions a thread's agent sees for a server.
 *
 * - The server's own instructions, unchanged, whenever it sent any.
 * - Otherwise, when it listed skills, an index of them within
 *   `MAX_SKILLS_INDEX_CHARS`. An entry without a `skill://` URI or a name is
 *   left out rather than guessed at.
 * - Otherwise nothing.
 */
export function skillsAwareInstructions(input: {
  instructions?: string;
  /** The first page of `skills/list`, when the server offered skills. */
  listed?: { skills?: unknown; nextCursor?: unknown };
}): string | undefined {
  if (input.instructions?.trim()) return input.instructions;
  const entries = Array.isArray(input.listed?.skills) ? input.listed.skills : [];
  const skills = entries.map(readSkill).filter((skill): skill is IndexedSkill => skill !== undefined);
  if (skills.length === 0) return undefined;
  const lines = [INDEX_HEADER];
  // Room for the closing line is kept from the start, so it always fits.
  const budget = MAX_SKILLS_INDEX_CHARS - (INDEX_MORE.length + 1);
  let length = INDEX_HEADER.length;
  let complete = typeof input.listed?.nextCursor !== "string" || input.listed.nextCursor === "";
  for (const skill of skills) {
    const line = skill.description
      ? `- ${skill.name}: ${skill.description} (${skill.uri})`
      : `- ${skill.name} (${skill.uri})`;
    if (length + 1 + line.length > budget) {
      complete = false;
      break;
    }
    lines.push(line);
    length += 1 + line.length;
  }
  if (lines.length === 1) return undefined;
  if (!complete) lines.push(INDEX_MORE);
  return lines.join("\n");
}
