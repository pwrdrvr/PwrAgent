"""Exercise workflow caching without calling a model or PwrAgent."""
import ast
import asyncio
import hashlib
import json
import pathlib
import sys
import tempfile

scripts = pathlib.Path(__file__).resolve().parents[1]
workflow = scripts / "run-decision-scoring.py"
source = sys.stdin.read() if "--stdin" in sys.argv else workflow.read_text()
code = compile(source, str(workflow), "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
definition_source = (scripts / "scoring-definitions.json").read_bytes()


def digest(data):
    return hashlib.sha256(data).hexdigest()


async def exercise(root):
    chunk_file = root / "chunk.json"
    archive_dir = root / "decision-batches"
    archive_dir.mkdir()
    calls = 0

    def prepare(inputs, definitions):
        chunk_file.write_bytes(inputs)
        (root / "scoring-definitions.json").write_bytes(definitions)
        manifest = {
            "definitionSha256": digest(definitions),
            "recall": [{"file": str(chunk_file), "count": 1, "start": 0, "inputsSha256": digest(inputs)}],
            "precision": [],
            "holistic": [],
        }
        (root / "chunks-manifest.json").write_text(json.dumps(manifest))

    async def agent(*args, **kwargs):
        nonlocal calls
        calls += 1
        batch_id = f"batch_fixture-{calls}"
        result = archive_dir / f"{batch_id}.jsonl"
        rows = [
            {"type": "batch", "batchId": batch_id, "count": 1},
            {"type": "item", "index": 0, "ok": True, "response": {"answers": [
                {"type": "predicate", "name": "same_root_cause", "probability": 0.9},
                {"type": "choice", "name": "match_grade", "choice": "exact_match"},
            ]}},
        ]
        result.write_text("".join(json.dumps(row) + "\n" for row in rows))
        return {
            "batchType": "recall", "start": 0, "count": 1, "chunkIndex": 0,
            "batchId": batch_id, "resultsFile": str(result), "succeeded": 1, "failed": 0, "estimatedCostUsd": 0,
        }

    async def parallel(wave, run):
        return await asyncio.gather(*(run(item) for item in wave))

    async def run():
        def discard(*args, **kwargs):
            pass

        scope = {"args": {"scoringDir": str(root)}, "agent": agent, "parallel": parallel,
                 "log": discard, "phase": discard, "print": discard}
        await eval(code, scope)

    first = b'[{"finding":"first"}]'
    second = b'[{"finding":"second"}]'
    prepare(first, definition_source)
    await run()
    await run()
    assert calls == 1, "unchanged complete batch should be cached"
    prepare(second, definition_source)
    await run()
    assert calls == 2, "changed chunk inputs must invalidate the cached judgment"
    changed = json.loads(definition_source)
    changed["recall"]["prefix"] += " Additional context."
    prepare(second, json.dumps(changed).encode())
    await run()
    assert calls == 3, "changed judging instructions must invalidate the cached judgment"
    summary = json.loads((root / "decision-batches-summary.json").read_text())
    pathlib.Path(summary["recall"][0]["resultsFile"]).write_text("")
    await run()
    assert calls == 4, "damaged archived judgments must be replaced"


with tempfile.TemporaryDirectory(prefix="review-scoring-cache-") as directory:
    asyncio.run(exercise(pathlib.Path(directory)))
print("Scoring cache checks passed.")
