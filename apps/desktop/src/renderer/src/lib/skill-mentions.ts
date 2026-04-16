import type { AppServerSkillSummary } from "@pwragnt/shared";

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

export function buildSkillMentionMarkdown(
  skill: Pick<AppServerSkillSummary, "name" | "path">
): string {
  if (!skill.path) {
    return `$${skill.name}`;
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
  const skillsByPath = new Map(
    skills
      .filter((skill): skill is AppServerSkillSummary & { path: string } => Boolean(skill.path))
      .map((skill) => [skill.path, skill])
  );

  const mentioned = new Map<string, AppServerSkillSummary>();
  for (const part of parseSkillMentionParts(text)) {
    if (part.type !== "skill") {
      continue;
    }

    const existing = skillsByPath.get(part.path);
    const key = part.path || part.name;
    mentioned.set(
      key,
      existing ?? {
        name: part.name,
        path: part.path,
      }
    );
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

export function insertSkillMention(params: {
  draft: string;
  skill: Pick<AppServerSkillSummary, "name" | "path">;
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

  const mention = buildSkillMentionMarkdown(params.skill);
  const before = params.draft.slice(0, trigger.start);
  const after = params.draft.slice(Math.max(trigger.end, params.selectionEnd));
  const needsTrailingSpace = after.length > 0 && !/^\s/.test(after);
  const nextDraft = `${before}${mention}${needsTrailingSpace ? " " : ""}${after}`;

  return {
    nextDraft,
    nextSelection: before.length + mention.length + (needsTrailingSpace ? 1 : 0),
  };
}

export function buildSkillTooltip(skill: AppServerSkillSummary): string {
  const lines = [
    skill.shortDescription?.trim() || skill.description?.trim(),
    skill.path?.trim(),
  ].filter((value): value is string => Boolean(value));

  return lines.join("\n");
}
