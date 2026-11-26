"""
Dynamic workflow script (for Antigravity `run_workflow`) that scores all chunks
produced by `prepare-scoring-batches.mjs` via PwrAgent's built-in Decision
model (`decisions_invoke` / `gpt-6-luna`).

Pass Args={"scoringDir": "/abs/path/to/scoring"} when invoking `run_workflow`.
Resumable per chunk and preserves each batch JSONL under `<scoringDir>/jsonl/`
so PwrAgent's 20-file `decision-batches/` rotation never drops results.
"""
import hashlib
import json
import os
import re
import shutil
import tempfile

SCORING_DIR = args["scoringDir"]
DONE_DIR = os.path.join(SCORING_DIR, "chunks-done")
JSONL_DIR = os.path.join(SCORING_DIR, "jsonl")
os.makedirs(DONE_DIR, exist_ok=True)
os.makedirs(JSONL_DIR, exist_ok=True)

with open(os.path.join(SCORING_DIR, "chunks-manifest.json")) as f:
    manifest = json.load(f)

with open(os.path.join(SCORING_DIR, "scoring-definitions.json"), "rb") as f:
    definition_bytes = f.read()
definition_sha = hashlib.sha256(definition_bytes).hexdigest()
if definition_sha != manifest["definitionSha256"]:
    raise ValueError("Scoring definitions changed after preparation.")
DEFINITIONS = json.loads(definition_bytes)


def write_json(path, value):
    with tempfile.NamedTemporaryFile(mode="w", dir=os.path.dirname(path), delete=False) as f:
        temp_path = f.name
        json.dump(value, f, indent=2)
    os.replace(temp_path, path)


def complete_archive(path, batch_id, count, questions):
    try:
        with open(path) as f:
            header = json.loads(next(f))
            if (header.get("type"), header.get("batchId"), header.get("count")) != ("batch", batch_id, count):
                return False
            expected = {(q["name"], q["type"]) for q in questions}
            seen = set()
            for line in f:
                row = json.loads(line)
                if row.get("type") != "item":
                    continue
                index = row["index"]
                answers = row.get("response", {}).get("answers", [])
                if (type(index) is not int or not 0 <= index < count or index in seen
                        or row.get("ok") is not True or len(answers) != len(expected)
                        or {(a.get("name"), a.get("type")) for a in answers} != expected):
                    return False
                seen.add(index)
            return len(seen) == count
    except (OSError, ValueError, StopIteration, KeyError, TypeError, AttributeError):
        return False


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


async def score_chunk(batch_type, idx, chunk):
    with open(chunk["file"], "rb") as f:
        inputs_sha = hashlib.sha256(f.read()).hexdigest()
    if inputs_sha != chunk["inputsSha256"]:
        raise ValueError("Decision inputs changed after preparation.")
    identity = {
        "batchType": batch_type,
        "chunkIndex": idx,
        "start": chunk["start"],
        "count": chunk["count"],
        "inputsSha256": inputs_sha,
        "definitionSha256": definition_sha,
    }
    definition = DEFINITIONS[batch_type]
    done_path = os.path.join(DONE_DIR, f"{batch_type}-{idx}.json")
    if os.path.exists(done_path):
        with open(done_path) as f:
            cached = json.load(f)
        if (all(cached.get(key) == value for key, value in identity.items())
                and cached.get("succeeded") == chunk["count"] and cached.get("failed") == 0
                and cached.get("resultsFile")
                and complete_archive(cached["resultsFile"], cached.get("batchId"), chunk["count"], definition["questions"])):
            return cached

    defn_json = json.dumps(definition)
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
4. Call `finish` with the chunk metadata and batch response. Use `usage.estimatedCostUsd` for `estimatedCostUsd` when present, otherwise use 0.
"""
    last_err = None
    for attempt in range(2):
        try:
            res = await agent(
                prompt,
                schema=RESULT_SCHEMA,
                role=f"Score {batch_type} #{idx}" + ("" if attempt == 0 else " (retry)"),
                type_name="self",
                model="flash",
            )
            src_jsonl = res.get("resultsFile")
            batch_id = res.get("batchId", "")
            if (res.get("succeeded") != chunk["count"] or res.get("failed") != 0
                    or not re.fullmatch(r"batch_[A-Za-z0-9-]{1,80}", batch_id) or not src_jsonl
                    or os.path.basename(src_jsonl) != f"{batch_id}.jsonl"
                    or os.path.basename(os.path.dirname(src_jsonl)) != "decision-batches"
                    or not complete_archive(src_jsonl, batch_id, chunk["count"], definition["questions"])):
                raise ValueError("Decision did not return a complete archived batch.")
            local_jsonl = os.path.join(JSONL_DIR, f"{batch_type}-{idx}-{batch_id}.jsonl")
            shutil.copyfile(src_jsonl, local_jsonl)
            res.update(identity, resultsFile=local_jsonl)
            write_json(done_path, res)
            return res
        except Exception as exc:
            last_err = exc
            log(f"Retry {batch_type}#{idx} after attempt {attempt + 1} error: {exc}")
    raise last_err


all_results = {}
for batch_type in ["recall", "precision", "holistic"]:
    phase(f"Score {batch_type}")
    chunks = manifest.get(batch_type, [])
    batch_out = []
    for i in range(0, len(chunks), 4):
        wave = [(idx, chunks[idx]) for idx in range(i, min(i + 4, len(chunks)))]
        res = await parallel(wave, lambda pair: score_chunk(batch_type, pair[0], pair[1]))
        batch_out.extend(res)
        for r in res:
            log(
                f"{batch_type}#{r['chunkIndex']}: ok={r['succeeded']}/{r['count']} "
                f"cost=${r['estimatedCostUsd']:.5f} file={r['resultsFile']}"
            )
    all_results[batch_type] = batch_out

out_path = os.path.join(SCORING_DIR, "decision-batches-summary.json")
write_json(out_path, all_results)
print(json.dumps(all_results, indent=2))
