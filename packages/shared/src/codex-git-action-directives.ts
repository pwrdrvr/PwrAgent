const CODEX_GIT_ACTION_DIRECTIVE_PREFIXES = [
  "::git-stage{",
  "::git-commit{",
  "::git-create-branch{",
  "::git-push{",
  "::git-create-pr{",
] as const;

const COMPLETE_CODEX_GIT_ACTION_DIRECTIVE = new RegExp(
  `^ {0,3}(?:${CODEX_GIT_ACTION_DIRECTIVE_PREFIXES
    .map((prefix) => prefix.slice(0, -1))
    .join("|")})\\{.*\\}\\s*$`,
);

type ClassifiedLine = {
  kind: "blank" | "content" | "directive";
  text: string;
};

/**
 * Removes Codex Desktop's assistant-authored git action directives while
 * preserving ordinary Markdown, including literal examples inside code
 * fences. The raw App Server message remains untouched so callers can parse
 * the directives into structured actions in the future.
 */
export function stripCodexGitActionDirectives(text: string): string {
  if (
    !text.includes("::")
    && !CODEX_GIT_ACTION_DIRECTIVE_PREFIXES.some(
      (prefix) => prefix.startsWith(text.trimStart()),
    )
  ) {
    return text;
  }

  const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const classified = classifyLines(lines);
  if (!classified.some((line) => line.kind === "directive")) {
    return text;
  }

  const output: string[] = [];
  let index = 0;
  while (index < classified.length) {
    const line = classified[index];
    if (line.kind === "content") {
      output.push(line.text);
      index += 1;
      continue;
    }

    const gap: ClassifiedLine[] = [];
    while (index < classified.length && classified[index]?.kind !== "content") {
      gap.push(classified[index]);
      index += 1;
    }
    if (!gap.some((entry) => entry.kind === "directive")) {
      output.push(...gap.map((entry) => entry.text));
      continue;
    }

    if (output.length > 0 && index < classified.length) {
      output.push("");
    }
  }

  return output.join(lineEnding);
}

function classifyLines(lines: string[]): ClassifiedLine[] {
  const classified: ClassifiedLine[] = [];
  let fenceCharacter: "`" | "~" | undefined;
  let fenceLength = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1] ?? "";
      const suffix = fence[2] ?? "";
      const markerCharacter = marker[0] as "`" | "~";
      if (!fenceCharacter) {
        fenceCharacter = markerCharacter;
        fenceLength = marker.length;
      } else if (
        markerCharacter === fenceCharacter
        && marker.length >= fenceLength
        && /^[ \t]*$/.test(suffix)
      ) {
        fenceCharacter = undefined;
        fenceLength = 0;
      }
      classified.push({ kind: "content", text: line });
      continue;
    }

    if (
      !fenceCharacter
      && isCodexGitActionDirectiveLine(line, index === lines.length - 1)
    ) {
      classified.push({ kind: "directive", text: line });
      continue;
    }

    classified.push({
      kind: !fenceCharacter && line.trim() === "" ? "blank" : "content",
      text: line,
    });
  }

  return classified;
}

function isCodexGitActionDirectiveLine(
  line: string,
  isLastLine: boolean,
): boolean {
  if (COMPLETE_CODEX_GIT_ACTION_DIRECTIVE.test(line)) {
    return true;
  }
  if (!isLastLine) {
    return false;
  }

  const candidate = line.replace(/^ {0,3}/, "");
  if (!candidate.startsWith("::git")) {
    return false;
  }
  return CODEX_GIT_ACTION_DIRECTIVE_PREFIXES.some(
    (prefix) => prefix.startsWith(candidate) || candidate.startsWith(prefix),
  );
}
