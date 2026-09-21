import type { AppServerReviewOutput } from "@pwragent/shared";

/**
 * The structured review contract a PwrAgent Sub Agent child answers in. Main
 * parses the child's reply into the review card's output and its text form.
 */
export const REVIEW_OUTPUT_INSTRUCTIONS = [
  "Return only one JSON object with this exact top-level shape:",
  '{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"...","overall_confidence_score":0.85}',
  'overall_correctness must be exactly "patch is correct" or "patch is incorrect" — no other wording.',
  // The field had no stated meaning for most of its life, so the number the
  // card printed was whatever each model decided it meant. The example value
  // is part of the definition: a schema showing 0.0 is a value weaker models
  // copy through, and a literal zero renders as "0% confidence" beside a
  // correct verdict.
  "overall_confidence_score is how confident you are, from 0 to 1, that overall_correctness is the right verdict. It is not a quality score for the patch and not a merge recommendation. Omit the field entirely if you cannot distinguish.",
  "Each finding must contain title, body, confidence_score, optional priority (0-3), and code_location with absolute_file_path plus line_range.start/end.",
  "Do not wrap the JSON in Markdown fences and do not include prose outside it.",
].join("\n");

/**
 * Keeps a reviewer-reported confidence only when it can mean something.
 *
 * The score is the reviewer's own confidence that its `overall_correctness`
 * verdict is right. Three values look like numbers and are not judgements:
 *
 * - Exactly `0`. The output schema in the review prompt has to show the field,
 *   and whatever value it shows is the one a weaker model copies through. A
 *   literal zero next to "patch is correct" is a transcription, not a reviewer
 *   with no confidence at all.
 * - Anything above 1. A model answering `95` may mean 95%, or may mean nothing.
 *   Rescaling it guesses at intent; dropping it does not.
 * - Anything below 0, or non-finite.
 *
 * Dropping the value is safe because the verdict stands on its own — readers
 * render the correctness without a number. Substituting zero would not.
 */
export function normalizeReviewConfidenceScore(
  value: unknown,
): number | undefined {
  return typeof value === "number"
    && Number.isFinite(value)
    && value > 0
    && value <= 1
    ? value
    : undefined;
}

export function parseReviewOutputText(
  text: string | undefined,
): AppServerReviewOutput | undefined {
  if (!text?.trim()) {
    return undefined;
  }
  const record = readReviewArtifactObject(text.trim());
  if (!record) {
    return undefined;
  }
  if (
    !Array.isArray(record.findings)
    || typeof record.overall_correctness !== "string"
    || !record.overall_correctness.trim()
    || typeof record.overall_explanation !== "string"
  ) {
    return undefined;
  }

  const confidenceScore = normalizeReviewConfidenceScore(
    record.overall_confidence_score,
  );
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
    overall_correctness: normalizeOverallCorrectness(
      record.overall_correctness,
      findings,
    ),
    overall_explanation: record.overall_explanation,
    ...(confidenceScore === undefined
      ? {}
      : { overall_confidence_score: confidenceScore }),
  };
}

/**
 * The prompt asks for a bare JSON object and nothing else. Grok Build streams
 * two or three narration sentences first ("I'll review this branch against
 * `main`…") and only then the object, so the artifact has to be recovered from
 * the surrounding prose. Failing that recovery is not cosmetic: the unparsed
 * blob becomes the review text and is replayed verbatim into the parent thread
 * as the next turn's context.
 */
function readReviewArtifactObject(
  text: string,
): Record<string, unknown> | undefined {
  for (const candidate of [unwrapJsonFence(text), extractJsonObject(text)]) {
    if (!candidate) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return undefined;
}

/**
 * Codex review/start answers with exactly the two documented phrases. Other
 * agents paraphrase — Grok Build reports "patch has issues" — and an artifact
 * with real findings is worth more than the exact wording.
 *
 * Both directions have to be read, not just the negative one: the renderer
 * paints anything that is not "patch is correct" as a red "Patch needs work"
 * badge, so mapping an unrecognized-but-clean verdict to incorrect puts that
 * badge next to a "0 findings" badge. When the wording says nothing either
 * way, the findings list is the more trustworthy signal.
 */
function normalizeOverallCorrectness(
  value: string,
  findings: AppServerReviewOutput["findings"],
): AppServerReviewOutput["overall_correctness"] {
  const normalized = value.trim().toLowerCase();
  const negation = String.raw`\b(no|not|without|zero|free of)\b[^.]{0,20}?`;
  const fault = String.raw`\b(incorrect|issues?|problems?|bugs?|defects?)\b`;
  const clean = String.raw`\b(correct|fine|good|ok|okay)\b`;
  // "no issues found" names the fault word to deny it; "not correct" does the
  // same to the clean word. Check both denials before either bare match.
  if (new RegExp(negation + fault).test(normalized)) {
    return "patch is correct";
  }
  if (new RegExp(negation + clean).test(normalized)) {
    return "patch is incorrect";
  }
  if (new RegExp(fault).test(normalized)) {
    return "patch is incorrect";
  }
  if (new RegExp(clean).test(normalized)) {
    return "patch is correct";
  }
  return findings.length > 0 ? "patch is incorrect" : "patch is correct";
}

type ReviewFinding = AppServerReviewOutput["findings"][number];

const LEADING_PRIORITY_TAG = /^\s*\[P([0-3])\]\s*/i;

/**
 * Reviewers that learned Codex's own review format lead a finding's title
 * with its tag — "[P2] Persist review provenance" — although the
 * contract gives priority a field of its own. Every surface that draws the
 * priority separately (the card's badge, the copied heading, the text form)
 * then prints it twice.
 *
 * The stored finding keeps the reviewer's words; those surfaces read this
 * view of it. A tag that contradicts the field stays in the title, so the
 * disagreement shows rather than being settled either way, and a finding
 * with no priority takes its tag as the priority.
 */
export function withoutRedundantPriorityTag<T extends ReviewFinding>(
  finding: T,
): T {
  const tag = LEADING_PRIORITY_TAG.exec(finding.title);
  const title = tag ? finding.title.slice(tag[0].length) : "";
  if (!tag || !title.trim()) {
    return finding;
  }
  const tagged = Number(tag[1]);
  if (finding.priority === undefined) {
    return { ...finding, priority: tagged, title };
  }
  return finding.priority === tagged ? { ...finding, title } : finding;
}

export function formatReviewOutputText(
  output: AppServerReviewOutput,
): string {
  const lines = [
    output.overall_explanation.trim() || output.overall_correctness,
  ];
  if (output.findings.length === 0) {
    return [...lines, "", "No findings."].join("\n");
  }
  lines.push("");
  for (const finding of output.findings.map(withoutRedundantPriorityTag)) {
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

function extractJsonObject(value: string): string {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  return start === -1 || end <= start ? "" : value.slice(start, end + 1);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
