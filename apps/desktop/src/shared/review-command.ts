import type { AppServerReviewTarget } from "@pwragent/shared";

/**
 * Reviewer override typed on the command line. Provider stays a raw token
 * (`grok`, `codex`, `acp:grok`) because resolving it to a backend id needs the
 * owning instance's catalog, which this parser has no access to.
 */
export type ParsedReviewCommandReviewer = {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
};

export type ParsedReviewCommand = {
  target: AppServerReviewTarget;
  displayText: string;
  reviewer?: ParsedReviewCommandReviewer;
};

export function formatReviewCommand(target: AppServerReviewTarget): string {
  if (target.type === "uncommittedChanges") {
    return "/review";
  }
  if (target.type === "baseBranch") {
    return `/review ${target.branch}`;
  }
  if (target.type === "commit") {
    return `/review --commit ${[target.sha, target.title].filter(Boolean).join(" ")}`;
  }
  return `/review --custom ${target.instructions}`;
}

export function normalizeReviewDisplayText(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }

  if (/^current changes$/i.test(normalized)) {
    return "Review current changes";
  }

  const branchMatch = /^(?:review\s+)?changes\s+against\s+(.+)$/i.exec(normalized);
  if (branchMatch) {
    return `Review changes against ${stripWrappingQuotes(branchMatch[1])}`;
  }

  const commitMatch = /^(?:review\s+)?commit\s+(.+)$/i.exec(normalized);
  if (commitMatch) {
    return `Review commit ${stripWrappingQuotes(commitMatch[1])}`;
  }

  if (/^custom instructions$/i.test(normalized)) {
    return "Review custom instructions";
  }

  if (/^(review|code review)\b/i.test(normalized)) {
    return normalized;
  }

  return `Review ${normalized}`;
}

export function parseReviewCommand(input: string): ParsedReviewCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  const match = /^\/review(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) {
    return undefined;
  }

  const extracted = extractLeadingReviewerFlags(match[1]?.trim() ?? "");
  const reviewer = extracted.reviewer ? { reviewer: extracted.reviewer } : {};
  const argument = extracted.argument;
  if (!argument) {
    return {
      target: { type: "uncommittedChanges" },
      displayText: "Review current changes",
      ...reviewer,
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
      ...reviewer,
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
      ...reviewer,
    };
  }

  return {
    target: { type: "baseBranch", branch: argument },
    displayText: `Review changes against ${argument}`,
    ...reviewer,
  };
}

/**
 * Pull reviewer flags off the FRONT of the argument only.
 *
 * `--custom` and `--commit` both take the rest of the line, so scanning the
 * whole argument would let `/review --custom check the --model wiring` silently
 * eat part of the instructions. Requiring the flags up front
 * (`/review --provider grok --custom ...`) keeps every target's free text
 * verbatim and leaves the grammar unambiguous.
 */
function extractLeadingReviewerFlags(argument: string): {
  argument: string;
  reviewer?: ParsedReviewCommandReviewer;
} {
  const reviewer: ParsedReviewCommandReviewer = {};
  let rest = argument;
  let matched = false;
  for (;;) {
    const match = /^(--provider|--model|--reasoning)\s+(\S+)\s*([\s\S]*)$/.exec(
      rest,
    );
    if (!match) {
      break;
    }
    const [, flag, value, remainder] = match;
    if (flag === "--provider") {
      reviewer.provider = value;
    } else if (flag === "--model") {
      reviewer.model = value;
    } else {
      reviewer.reasoningEffort = value;
    }
    matched = true;
    rest = remainder.trim();
  }
  return {
    argument: rest,
    ...(matched ? { reviewer } : {}),
  };
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/^(['"])(.*)\1$/, "$2").trim();
}
