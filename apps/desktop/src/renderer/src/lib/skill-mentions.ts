import type { AppServerSkillSummary } from "@pwragent/shared";

export type SkillMentionPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "skill";
      label: string;
      name: string;
      path: string;
    };

const SKILL_MENTION_PATTERN = /\[(\$[^\]\r\n]+)\]\(([^)\r\n]+)\)/g;
const SKILL_TOKEN_BOUNDARY = "(?=$|\\s|[.,!?;:])";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildSkillLabelToken(
  skill: Pick<AppServerSkillSummary, "name">
): string {
  return `$${skill.name}`;
}

export function buildSkillMentionMarkdown(
  skill: Pick<AppServerSkillSummary, "name" | "path">
): string {
  if (!skill.path) {
    return buildSkillLabelToken(skill);
  }

  return `[$${skill.name}](${skill.path})`;
}

export function parseSkillMentionParts(text: string): SkillMentionPart[] {
  const output: SkillMentionPart[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(SKILL_MENTION_PATTERN)) {
    const fullMatch = match[0];
    const label = match[1];
    const path = match[2];
    const start = match.index ?? -1;

    if (start < 0) {
      continue;
    }

    if (start > lastIndex) {
      output.push({
        type: "text",
        text: text.slice(lastIndex, start),
      });
    }

    output.push({
      type: "skill",
      label,
      name: label.slice(1),
      path,
    });

    lastIndex = start + fullMatch.length;
  }

  if (lastIndex < text.length) {
    output.push({
      type: "text",
      text: text.slice(lastIndex),
    });
  }

  if (output.length === 0) {
    output.push({ type: "text", text });
  }

  return output;
}

export function listMentionedSkills(
  text: string,
  skills: AppServerSkillSummary[]
): AppServerSkillSummary[] {
  const mentioned = new Map<string, AppServerSkillSummary>();
  for (const part of parseSkillMentionParts(text)) {
    if (part.type !== "skill") {
      continue;
    }

    const existing = skills.find((skill) => skill.path === part.path);
    const key = part.path || part.name;
    mentioned.set(
      key,
      existing ?? {
        name: part.name,
        path: part.path,
      }
    );
  }

  for (const skill of skills) {
    const token = buildSkillLabelToken(skill);
    const pattern = new RegExp(`(^|\\s)${escapeRegExp(token)}${SKILL_TOKEN_BOUNDARY}`);
    if (!pattern.test(text)) {
      continue;
    }

    mentioned.set(skill.path ?? skill.name, skill);
  }

  return [...mentioned.values()];
}

export function findSkillTrigger(text: string, caret: number): {
  end: number;
  query: string;
  start: number;
} | undefined {
  const prefix = text.slice(0, caret);
  const match = /(?:^|\s)\$([A-Za-z0-9:_-]*)$/.exec(prefix);
  if (!match) {
    return undefined;
  }

  const start = prefix.length - match[0].length + match[0].lastIndexOf("$");
  return {
    start,
    end: caret,
    query: match[1] ?? "",
  };
}

export function insertSkillLabel(params: {
  draft: string;
  skill: Pick<AppServerSkillSummary, "name">;
  selectionEnd: number;
  selectionStart: number;
}): {
  nextDraft: string;
  nextSelection: number;
} | undefined {
  const trigger = findSkillTrigger(params.draft, params.selectionStart);
  if (!trigger) {
    return undefined;
  }

  const mention = buildSkillLabelToken(params.skill);
  const before = params.draft.slice(0, trigger.start);
  const after = params.draft.slice(Math.max(trigger.end, params.selectionEnd));
  const needsTrailingSpace = after.length === 0 || !/^\s/.test(after);
  const nextDraft = `${before}${mention}${needsTrailingSpace ? " " : ""}${after}`;

  return {
    nextDraft,
    nextSelection: before.length + mention.length + (needsTrailingSpace ? 1 : 0),
  };
}

export function hydrateSkillLabelsWithMarkdown(
  text: string,
  skills: AppServerSkillSummary[]
): string {
  let output = text;

  for (const skill of skills) {
    if (!skill.path) {
      continue;
    }

    const token = buildSkillLabelToken(skill);
    const pattern = new RegExp(
      `(^|\\s)${escapeRegExp(token)}${SKILL_TOKEN_BOUNDARY}`,
      "g"
    );
    output = output.replace(pattern, (_match, prefix: string) => {
      return `${prefix}${buildSkillMentionMarkdown(skill)}`;
    });
  }

  return output;
}

export function buildSkillTooltip(skill: AppServerSkillSummary): string {
  const lines = [
    skill.shortDescription?.trim() || skill.description?.trim(),
    skill.path?.trim(),
  ].filter((value): value is string => Boolean(value));

  return lines.join("\n");
}
