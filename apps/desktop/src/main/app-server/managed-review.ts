import type {
  AppServerReviewOutput,
  AppServerReviewTarget,
} from "@pwragent/shared";

const REVIEW_OUTPUT_INSTRUCTIONS = [
  "Return only one JSON object with this exact top-level shape:",
  '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"...","overall_confidence_score":0.0}',
  "Each finding must contain title, body, confidence_score, optional priority (0-3), and code_location with absolute_file_path plus line_range.start/end.",
  "Do not wrap the JSON in Markdown fences and do not include prose outside it.",
].join("\n");

export function buildManagedReviewPrompt(
  target: AppServerReviewTarget,
): string {
  return [
    "Perform a code review. Focus on concrete correctness regressions introduced by the requested changes. Do not modify files.",
    reviewTargetInstructions(target),
    REVIEW_OUTPUT_INSTRUCTIONS,
  ].join("\n\n");
}

export function buildManagedReviewContextInput(outputs: string[]): string {
  return [
    "[PwrAgent review sub-agent results — context for this turn]",
    ...outputs.map((output, index) => [
      outputs.length > 1 ? `Review ${index + 1}:` : undefined,
      output.trim(),
    ].filter((line): line is string => Boolean(line)).join("\n")),
    "[End PwrAgent review sub-agent results]",
  ].join("\n\n");
}

function reviewTargetInstructions(target: AppServerReviewTarget): string {
  switch (target.type) {
    case "baseBranch":
      return `Review the current checkout against base branch '${target.branch}'. Find the merge base and inspect the resulting diff.`;
    case "commit":
      return `Review commit ${target.sha}${target.title ? ` (${target.title})` : ""}.`;
    case "custom":
      return target.instructions.trim() || "Review the current code changes.";
    case "uncommittedChanges":
      return "Review all staged, unstaged, and untracked changes in the current checkout.";
  }
}

export function parseManagedReviewOutput(
  text: string | undefined,
): AppServerReviewOutput | undefined {
  if (!text?.trim()) {
    return undefined;
  }
  const source = unwrapJsonFence(text.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (
    !Array.isArray(record.findings)
    || (
      record.overall_correctness !== "patch is correct"
      && record.overall_correctness !== "patch is incorrect"
    )
    || typeof record.overall_explanation !== "string"
    || typeof record.overall_confidence_score !== "number"
  ) {
    return undefined;
  }

  const findings = record.findings.flatMap(
    (value): AppServerReviewOutput["findings"] => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return [];
      }
      const finding = value as Record<string, unknown>;
      const location = asRecord(finding.code_location);
      const lineRange = asRecord(location?.line_range);
      if (
        typeof finding.title !== "string"
        || typeof finding.body !== "string"
        || typeof finding.confidence_score !== "number"
        || typeof location?.absolute_file_path !== "string"
        || typeof lineRange?.start !== "number"
        || typeof lineRange?.end !== "number"
      ) {
        return [];
      }
      return [{
        title: finding.title,
        body: finding.body,
        confidence_score: finding.confidence_score,
        ...(typeof finding.priority === "number"
          ? { priority: finding.priority }
          : {}),
        code_location: {
          absolute_file_path: location.absolute_file_path,
          line_range: {
            start: lineRange.start,
            end: lineRange.end,
          },
        },
      }];
    },
  );

  return {
    findings,
    overall_correctness: record.overall_correctness,
    overall_explanation: record.overall_explanation,
    overall_confidence_score: record.overall_confidence_score,
  };
}

export function formatManagedReviewOutput(
  output: AppServerReviewOutput,
): string {
  const lines = [
    output.overall_explanation.trim() || output.overall_correctness,
  ];
  if (output.findings.length === 0) {
    return [...lines, "", "No findings."].join("\n");
  }
  lines.push("");
  for (const finding of output.findings) {
    const priority = finding.priority === undefined
      ? "P?"
      : `P${finding.priority}`;
    const range = finding.code_location.line_range;
    lines.push(
      `- [${priority}] ${finding.title} (${finding.code_location.absolute_file_path}:${range.start}-${range.end})`,
      `  ${finding.body}`,
    );
  }
  return lines.join("\n");
}

function unwrapJsonFence(value: string): string {
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
