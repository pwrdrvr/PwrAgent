import type { SDKControlGetContextUsageResponse, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { stat } from "node:fs/promises";
import path from "node:path";
import type {
  AppServerAvailableCommandSummary,
  AppServerSkillSummary,
  AppServerTurnInputItem,
} from "@pwragent/shared/contracts/normalized-app-server";
import { claudeCommandSummary, selectClaudeCommandRows } from "./claude-commands";

/** One skill Claude reports in `getContextUsage().skills.skillFrontmatter`. */
export type ClaudeSkillEvidence =
  NonNullable<SDKControlGetContextUsageResponse["skills"]>["skillFrontmatter"][number];

/** Claude's command list split for the composer: `/` commands and `$` skills. */
export type ClaudeCommandCatalog = {
  commands: AppServerAvailableCommandSummary[];
  skills: AppServerSkillSummary[];
};

/** A skill file Claude's context listing omitted, found on disk by its folder name. */
export type ClaudeSkillFile = { path: string; scope: "repo" | "claude-user" };

const SKILL_FILE = /[\\/]SKILL\.md$/i;
/** Names that are safe as one folder name: no separators, dots, or plugin prefix. */
const SKILL_FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** Claude appends where a command came from; the origin chip says that instead. */
const SOURCE_SUFFIX = /\s+\((?:user|project|local|claude\.ai sync)\)$/;

/**
 * Split Claude's command rows into `/` commands and `$` skills.
 *
 * `supportedCommands()` lists skills, custom commands, plugin commands, and
 * Claude Code's own commands together, and marks only the last. A row is a
 * skill when Claude's context listing gives it a `SKILL.md` file, or when the
 * folder lookup in `skillFiles` found one: Claude leaves skills the model may
 * not invoke out of its context listing. A row `/name` would not run, because
 * a built-in row shares its name, stays a command: the skill could not be
 * started by name.
 */
export function claudeCommandCatalog(params: {
  commands: readonly SlashCommand[];
  terminalCommands: ReadonlySet<string>;
  skillEvidence: readonly ClaudeSkillEvidence[];
  skillFiles?: ReadonlyMap<string, ClaudeSkillFile>;
}): ClaudeCommandCatalog {
  const evidence = new Map(params.skillEvidence.map((skill) => [skill.name, skill]));
  const catalog: ClaudeCommandCatalog = { commands: [], skills: [] };
  for (const row of selectClaudeCommandRows(params.commands, params.terminalCommands)) {
    const listed = row.builtin ? undefined : evidence.get(row.name);
    const found = row.builtin || listed ? undefined : params.skillFiles?.get(row.name);
    const path = listed?.path && SKILL_FILE.test(listed.path) ? listed.path : found?.path;
    if (!path) {
      catalog.commands.push(claudeCommandSummary(row));
      continue;
    }
    const description = row.description?.replace(SOURCE_SUFFIX, "").trim();
    const scope = listed ? claudeSkillScope(listed.source) : found?.scope;
    catalog.skills.push({
      name: row.name,
      ...(description ? { description } : {}),
      path,
      enabled: true,
      ...(scope ? { scope } : {}),
      ...(listed?.pluginId ? { pluginId: listed.pluginId } : {}),
    });
  }
  return catalog;
}

/**
 * Rows that may be skills Claude's context listing omitted. Only a row with
 * no listing at all qualifies: a listed row without a `SKILL.md` is a custom
 * command. The name becomes one path segment, so it must be a plain name.
 */
export function claudeSkillFileCandidates(
  commands: readonly SlashCommand[],
  terminalCommands: ReadonlySet<string>,
  skillEvidence: readonly ClaudeSkillEvidence[],
): string[] {
  const listed = new Set(skillEvidence.map((skill) => skill.name));
  return selectClaudeCommandRows(commands, terminalCommands)
    .filter((row) => !row.builtin && !listed.has(row.name) && SKILL_FOLDER_NAME.test(row.name))
    .map((row) => row.name);
}

/**
 * Look for each candidate's `SKILL.md` in Claude's config folder and the
 * project's `.claude/skills`. The config folder's copy wins a shared name,
 * as it does in Claude Code.
 */
export async function findClaudeSkillFiles(params: {
  cwd: string;
  configDir: string;
  names: readonly string[];
}): Promise<Map<string, ClaudeSkillFile>> {
  const roots = [
    { root: path.join(params.configDir, "skills"), scope: "claude-user" },
    { root: path.join(params.cwd, ".claude", "skills"), scope: "repo" },
  ] as const;
  const found = new Map<string, ClaudeSkillFile>();
  await Promise.all(params.names.filter((name) => SKILL_FOLDER_NAME.test(name)).map(async (name) => {
    for (const { root, scope } of roots) {
      const file = path.join(root, name, "SKILL.md");
      if (await stat(file).then((entry) => entry.isFile(), () => false)) {
        found.set(name, { path: file, scope });
        return;
      }
    }
  }));
  return found;
}

/** The `scope` the shared skill-origin rules read for a Claude source. */
function claudeSkillScope(source: string): string | undefined {
  switch (source) {
    case "userSettings":
      return "claude-user";
    case "projectSettings":
    case "localSettings":
      return "repo";
    case "syncedSkills":
      return "claude-synced";
    case "policySettings":
      return "claude-managed";
    default:
      return undefined;
  }
}

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

/** A `[$name](target)` link in a prompt: `end` is just past its `)`. */
export type ClaudeSkillLink = { start: number; end: number; name: string; target: string };

/** The first of `stop` or a line break at or after `from`, or the text's length. */
function scanTo(text: string, from: number, stop: string, work?: { chars: number }): number {
  let index = from;
  while (index < text.length && text[index] !== stop && text[index] !== "\n" && text[index] !== "\r") index += 1;
  if (work) work.chars += index - from;
  return index;
}

/**
 * The prompt's `[$name](target)` links: the matches of
 * `/\[\$([^\]\r\n]+)\]\(([^)\r\n]+)\)/g`, found in one pass.
 *
 * That pattern scans from every `[$` to the end of its line before failing,
 * so a pasted line of unclosed `[$` took time quadratic in its length. A
 * failed link here moves past every later `[$` that would fail the same way:
 * one whose name runs into the same line break, or into the same `]` without
 * a `(` after it, or whose target would cross the same `)`-less stretch.
 * `work` counts the characters scanned, for tests.
 */
export function claudeSkillLinks(text: string, work?: { chars: number }): ClaudeSkillLink[] {
  const links: ClaudeSkillLink[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf("[$", from);
    if (start < 0) return links;
    const close = scanTo(text, start + 2, "]", work);
    if (close === start + 2) {
      from = start + 1;
      continue;
    }
    if (text[close] !== "]") {
      from = close;
      continue;
    }
    if (text[close + 1] !== "(") {
      from = close + 1;
      continue;
    }
    const end = scanTo(text, close + 2, ")", work);
    if (end === close + 2) {
      from = close + 1;
      continue;
    }
    if (text[end] !== ")") {
      from = end;
      continue;
    }
    links.push({ start, end: end + 1, name: text.slice(start + 2, close), target: text.slice(close + 2, end) });
    from = end + 1;
  }
}

function replaceSkillLinks(text: string, replace: (link: ClaudeSkillLink) => string): string {
  let output = "";
  let cursor = 0;
  for (const link of claudeSkillLinks(text)) {
    output += text.slice(cursor, link.start) + replace(link);
    cursor = link.end;
  }
  return cursor === 0 ? text : output + text.slice(cursor);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrite the composer's `$skill` mentions into the `/skill` form Claude
 * Code acts on.
 *
 * Claude ignores `$name` and the composer's `[$name](path)` link: neither
 * starts a skill, and its Skill tool refuses one marked
 * `disable-model-invocation`. Observed with Claude Code 2.1.305:
 *
 * - A prompt, or its last text block, that starts with `/name` runs that
 *   skill directly, and the rest of the text becomes its arguments, other
 *   `/skill` mentions included.
 * - `/name` elsewhere in the prompt leads the model to start the skill with
 *   its Skill tool, which then accepts even a skill only the user may start,
 *   because the user's own text names it. That holds for several skills in
 *   one prompt, but not once a prompt has started a skill directly.
 *
 * So a prompt whose only skill opens it keeps `/name` first. When the prompt
 * names more than one skill, a text block that opens with one starts with a
 * space instead, so every named skill goes through the Skill tool rather than
 * the first taking the rest as its arguments.
 *
 * A link from the picker is rewritten whenever it points at a `SKILL.md` or
 * names a known skill; a bare `$name` only when `name` is a known skill, so
 * `$HOME` and `$5` stay as typed.
 */
export function claudeSkillPrompt(
  input: readonly AppServerTurnInputItem[],
  skillNames: ReadonlySet<string>,
): AppServerTurnInputItem[] {
  const names = [...skillNames].filter((name) => SKILL_NAME.test(name))
    // Longest first, so `$release-notes` is not read as `$release`.
    .sort((left, right) => right.length - left.length);
  const bare = names.length > 0
    ? new RegExp(`(^|\\s)\\$(${names.map(escapeRegExp).join("|")})(?=$|\\s|[.,!?;:])`, "g")
    : undefined;
  const mentioned = new Set<string>();
  // Text blocks that now open with a rewritten skill. Claude starts a skill
  // directly from the prompt's only or last text block, so any of them can.
  const opensWithSkill = new Set<number>();
  const output = input.map((item, index): AppServerTurnInputItem => {
    if (item.type !== "text") return item;
    let text = replaceSkillLinks(item.text, ({ start, end, name, target }) => {
      if (!SKILL_NAME.test(name) || (!skillNames.has(name) && !SKILL_FILE.test(target.trim()))) {
        return item.text.slice(start, end);
      }
      mentioned.add(name);
      if (start === 0) opensWithSkill.add(index);
      return `/${name}`;
    });
    if (bare) {
      text = text.replace(bare, (_token, lead: string, name: string, offset: number) => {
        mentioned.add(name);
        if (offset === 0 && !lead) opensWithSkill.add(index);
        return `${lead}/${name}`;
      });
    }
    return text === item.text ? item : { ...item, text };
  });
  if (mentioned.size > 1) {
    for (const index of opensWithSkill) {
      const item = output[index];
      if (item?.type === "text") output[index] = { ...item, text: ` ${item.text}` };
    }
  }
  return output;
}
