import type { AppServerSkillSummary } from "@pwragent/shared/contracts/normalized-app-server";

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

// Keep nested replacements as pieces until a draft actually uses them. A
// catalog can describe many levels of expansion even when a label is absent.
type Markdown = string | Markdown[];
type Match = { order: number; markdown: Markdown };
type NameNode = { children: Map<string, NameNode>; match?: Match };

function substituteLabels(text: string, root: NameNode): Markdown {
  const pieces: Markdown[] = [];
  let copied = 0;
  for (const opening of text.matchAll(/(?:^|\s)\$/g)) {
    const start = opening.index + opening[0].length - 1;
    if (start < copied) continue;
    let node: NameNode | undefined = root;
    let winner: Match | undefined;
    let end = start + 1;
    for (let i = end; node; i += 1) {
      const next = text.charAt(i);
      if (node.match && (!winner || node.match.order < winner.order)
        && (!next || /[\s.,!?;:]/.test(next))) {
        winner = node.match;
        end = i;
      }
      node = node.children.get(next);
    }
    if (winner) {
      pieces.push(text.slice(copied, start), winner.markdown);
      copied = end;
    }
  }
  if (!pieces.length) return text;
  pieces.push(text.slice(copied));
  return pieces;
}

function renderMarkdown(markdown: Markdown): string {
  if (typeof markdown === "string") return markdown;
  const pending = markdown.slice().reverse();
  const output: string[] = [];
  while (pending.length) {
    const part = pending.pop()!;
    if (typeof part === "string") {
      output.push(part);
    } else {
      for (let i = part.length - 1; i >= 0; i -= 1) pending.push(part[i]!);
    }
  }
  return output.join("");
}

function hydrateBatch(text: string, batch: AppServerSkillSummary[]): string {
  const root: NameNode = { children: new Map() };
  // Each replacement sees precisely the suffix of the catalog after it.
  // An earlier duplicate then takes its place for matches in the draft.
  for (let i = batch.length - 1; i >= 0; i -= 1) {
    const skill = batch[i]!;
    const link = buildSkillMentionMarkdown(skill);
    const markdown = i + 1 < batch.length && /\s\$/.test(skill.path!) ? substituteLabels(link, root) : link;
    let node = root;
    for (let j = 0; j < skill.name.length; j += 1) {
      const char = skill.name.charAt(j);
      let child = node.children.get(char);
      if (!child) {
        child = { children: new Map() };
        node.children.set(char, child);
      }
      node = child;
    }
    node.match = { order: i, markdown };
  }
  return renderMarkdown(substituteLabels(text, root));
}

export function hydrateSkillLabelsWithMarkdown(
  text: string,
  skills: AppServerSkillSummary[],
): string {
  if (!text || !skills.length) return text;
  let output = text;
  let hasExposedLabel = false;
  const batch: AppServerSkillSummary[] = [];
  const flush = () => {
    if (batch.length) output = hydrateBatch(output, batch);
    batch.length = 0;
    hasExposedLabel = false;
  };

  for (const skill of skills) {
    if (!skill.path) continue;
    // These names can reach across another bare label or its generated link.
    const crossesLabel = /\s\[?\$/.test(skill.name);
    // A label exposed in a path can also consume its closing ')' and continue
    // into the surrounding draft. Give that rule the combined text.
    if (crossesLabel || (hasExposedLabel && skill.name.includes(")"))) flush();
    batch.push(skill);
    hasExposedLabel ||= /\s\$/.test(skill.path);
    if (crossesLabel) flush();
  }
  flush();
  return output;
}
