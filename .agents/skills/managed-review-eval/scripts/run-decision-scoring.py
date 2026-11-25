"""
Dynamic workflow script (for Antigravity `run_workflow`) that scores all chunks
produced by `prepare-scoring-batches.mjs` via PwrAgent's built-in Decision
model (`decisions_invoke` / `gpt-6-luna`).

Pass Args={"scoringDir": "/abs/path/to/scoring"} when invoking `run_workflow`.
"""
import json
import os

SCORING_DIR = args["scoringDir"]

with open(os.path.join(SCORING_DIR, "chunks-manifest.json")) as f:
    manifest = json.load(f)

DEFINITIONS = {
    "recall": {
        "provider": "openai",
        "prefix": (
            "You are an expert code-review evaluator comparing a baseline review finding against a candidate code review's findings on the same pull request. "
            "Focus on semantic equivalence of the underlying software defect (root cause, broken invariant, or behavioral regression), NOT exact wording or exact line number."
        ),
        "questions": [
            {
                "name": "same_root_cause",
                "type": "predicate",
                "instructions": (
                    "Does at least one finding in candidate_findings identify the SAME underlying defect or root cause described in baseline "
                    "(even if phrased differently, assigned a different priority, or pointing to an adjacent line/caller in the same bug)?"
                ),
            },
            {
                "name": "match_grade",
                "type": "choice",
                "instructions": "Grade how well candidate_findings covers baseline.",
                "choices": [
                    {"value": "exact_match", "description": "Clearly identifies the same underlying defect and root cause."},
                    {"value": "partial_match", "description": "Touches the same mechanism/area or symptom, or catches only part of the issue, while missing the core defect."},
                    {"value": "missed", "description": "Does not identify this defect (including when 0 findings were reported)."},
                ],
            },
        ],
    },
    "precision": {
        "provider": "openai",
        "prefix": (
            "You are a strict senior software engineer auditing an automated code-review finding against the actual PR git diff excerpt and baseline findings. "
            "Distinguish genuine, code-grounded bugs/regressions/missing tests from false positives, code misreads, speculative edge cases, or pure style nitpicks."
        ),
        "questions": [
            {
                "name": "matches_baseline",
                "type": "predicate",
                "instructions": "Does finding describe the same underlying defect as one of the items in baseline_findings?",
            },
            {
                "name": "concrete_defect",
                "type": "predicate",
                "instructions": (
                    "Grounded in diff and the explanation in finding, does this finding identify a REAL, concrete bug, behavioral/performance regression, "
                    "contract violation, or meaningful missing test/property (as opposed to a false positive, misread of the diff, trivial style nitpick, or ungrounded speculation)?"
                ),
            },
            {
                "name": "defect_value",
                "type": "score",
                "instructions": "Rate the engineering value and validity of finding for the author of this PR.",
                "levels": [
                    {"label": "noise", "description": "False positive, misreads code, or trivial style nitpick with no real defect."},
                    {"label": "weak", "description": "Speculative, marginal, or overly pedantic suggestion unlikely to merit a change."},
                    {"label": "valid_p3", "description": "Real low-impact P3 issue, minor edge case, or worthwhile small test/clarity improvement."},
                    {"label": "solid_p2", "description": "Concrete P2 bug, behavioral/performance regression, contract break, or important missing test/property."},
                    {"label": "critical_p1", "description": "High-impact P0/P1 bug, crash, security vulnerability, or data-loss defect."},
                ],
            },
        ],
    },
    "holistic": {
        "provider": "openai",
        "prefix": (
            "You are a principal engineer evaluating the overall quality of an anonymized code review for a pull request. "
            "Note that a clean 0-finding review can be high-signal if the PR is clean, while noisy or bloated reviews hurt signal-to-noise."
        ),
        "questions": [
            {
                "name": "signal_to_noise",
                "type": "score",
                "instructions": "Rate the signal-to-noise ratio of this review.",
                "levels": [
                    {"label": "1_very_low", "description": "Mostly noise, false positives, or unhelpful commentary."},
                    {"label": "2_low", "description": "Noticeable fluff, redundancy, or questionable nitpicks mixed in."},
                    {"label": "3_mixed", "description": "Reasonable mix of useful points and some weaker/verbose items."},
                    {"label": "4_high", "description": "Focused, high-signal findings with minimal noise."},
                    {"label": "5_excellent", "description": "Exceptionally crisp, high-signal, zero-fluff review."},
                ],
            },
            {
                "name": "actionability",
                "type": "score",
                "instructions": "Rate how concrete, code-grounded, and actionable the findings and suggested fixes are.",
                "levels": [
                    {"label": "1_very_low", "description": "Vague, ungrounded, or not actionable."},
                    {"label": "2_low", "description": "Points at areas of concern without clear failure mechanism or fix."},
                    {"label": "3_moderate", "description": "Understandable issues with adequate fix direction."},
                    {"label": "4_high", "description": "Clear failure mechanisms, exact code locations, and concrete fixes."},
                    {"label": "5_excellent", "description": "Pinpoint root causes, exact reproduction/failure mechanics, and minimal precise fixes."},
                ],
            },
            {
                "name": "overall_quality",
                "type": "score",
                "instructions": "Rate the overall usefulness of this code review to a senior engineer about to merge the PR.",
                "levels": [
                    {"label": "1_poor", "description": "Not helpful or actively misleading."},
                    {"label": "2_below_avg", "description": "Limited value; weak coverage or poor precision."},
                    {"label": "3_good", "description": "Solid, useful review."},
                    {"label": "4_very_good", "description": "Strong review catching meaningful issues cleanly."},
                    {"label": "5_outstanding", "description": "Top-tier senior engineering review."},
                ],
            },
        ],
    },
}

RESULT_SCHEMA = {
    "type": "object",
    "required": [
        "batchType",
        "chunkIndex",
        "start",
        "count",
        "batchId",
        "resultsFile",
        "succeeded",
        "failed",
        "estimatedCostUsd",
    ],
    "properties": {
        "batchType": {"type": "string"},
        "chunkIndex": {"type": "integer"},
        "start": {"type": "integer"},
        "count": {"type": "integer"},
        "batchId": {"type": "string"},
        "resultsFile": {"type": "string"},
        "succeeded": {"type": "integer"},
        "failed": {"type": "integer"},
        "estimatedCostUsd": {"type": "number"},
    },
}


def make_agent(batch_type, idx, chunk):
    defn_json = json.dumps(DEFINITIONS[batch_type])
    prompt = f"""Score chunk {idx} of {batch_type} ({chunk['count']} items, offset {chunk['start']}).

Steps:
1. Read `{chunk['file']}` using `read_file` to get the JSON array of {chunk['count']} input objects.
2. Call `mcp_pwragent_call_pwragent_tool` with:
   - `toolName`: `"decisions_invoke"`
   - `toolSummary`: `"Score {batch_type} chunk {idx}"`
   - `arguments`:
     - `definition`: {defn_json}
     - `inputs`: the exact JSON array you read from `{chunk['file']}` (preserve exact array order and all {chunk['count']} items)
     - `concurrency`: 8
     - `detail`: `"compact"`
3. Do NOT set `background: true`. Wait for the synchronous batch result.
4. Immediately call `finish` with:
   - `batchType`: `"{batch_type}"`
   - `chunkIndex`: {idx}
   - `start`: {chunk['start']}
   - `count`: {chunk['count']}
   - `batchId`: the returned `batchId` string
   - `resultsFile`: the returned `resultsFile` path string
   - `succeeded`: `totals.succeeded` (integer)
   - `failed`: `totals.failed` (integer)
   - `estimatedCostUsd`: `totals.estimatedCostUsd` (number, 0 if omitted)
"""
    return agent(
        prompt,
        schema=RESULT_SCHEMA,
        role=f"Score {batch_type} #{idx}",
        type_name="self",
        model="flash",
    )


all_results = {}
for batch_type in ["recall", "precision", "holistic"]:
    phase(f"Score {batch_type}")
    chunks = manifest.get(batch_type, [])
    batch_out = []
    for i in range(0, len(chunks), 4):
        wave = [(idx, chunks[idx]) for idx in range(i, min(i + 4, len(chunks)))]
        res = await parallel(wave, lambda pair: make_agent(batch_type, pair[0], pair[1]))
        batch_out.extend(res)
        for r in res:
            log(
                f"{batch_type}#{r['chunkIndex']}: ok={r['succeeded']}/{r['count']} "
                f"cost=${r['estimatedCostUsd']:.5f} file={r['resultsFile']}"
            )
    all_results[batch_type] = batch_out

out_path = os.path.join(SCORING_DIR, "decision-batches-summary.json")
with open(out_path, "w") as f:
    json.dump(all_results, f, indent=2)
print(json.dumps(all_results, indent=2))
