import type { AppServerReviewTarget } from "@pwragnt/shared";

export type ParsedReviewCommand = {
  target: AppServerReviewTarget;
  displayText: string;
};

export function parseReviewCommand(input: string): ParsedReviewCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  const match = /^\/review(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) {
    return undefined;
  }

  const argument = match[1]?.trim() ?? "";
  if (!argument) {
    return {
      target: { type: "uncommittedChanges" },
      displayText: "Review current changes",
    };
  }

  const customPrefix = "--custom";
  if (argument === customPrefix || argument.startsWith(`${customPrefix} `)) {
    const instructions = argument.slice(customPrefix.length).trim();
    if (!instructions) {
      return undefined;
    }
    return {
      target: { type: "custom", instructions },
      displayText: "Review custom instructions",
    };
  }

  const commitPrefix = "--commit";
  if (argument === commitPrefix || argument.startsWith(`${commitPrefix} `)) {
    const rest = argument.slice(commitPrefix.length).trim();
    const [sha, ...titleParts] = rest.split(/\s+/);
    if (!sha) {
      return undefined;
    }
    const title = titleParts.join(" ").trim();
    return {
      target: {
        type: "commit",
        sha,
        title: title || null,
      },
      displayText: `Review commit ${sha}`,
    };
  }

  return {
    target: { type: "baseBranch", branch: argument },
    displayText: `Review changes against ${argument}`,
  };
}
