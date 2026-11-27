"""Aggregate one local benchmark capture without returning transcripts or raw output."""
import argparse
from itertools import chain
import json
from pathlib import Path
import re
import sqlite3


def texts(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from texts(item)
    elif isinstance(value, dict):
        yield from texts(value.get("text", value.get("content")))


def varint(blob, pos):
    value = 0
    for shift in range(0, 70, 7):
        byte = blob[pos]
        pos += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, pos
    raise ValueError("Invalid generation counter")


def field(blob, path):
    """Read only the specified protobuf field in an agy 1.5.18 generation record."""
    pos = 0
    while pos < len(blob):
        tag, pos = varint(blob, pos)
        number, wire = divmod(tag, 8)
        if wire == 0:
            value, pos = varint(blob, pos)
        else:
            if wire == 2:
                size, pos = varint(blob, pos)
            else:
                size = {1: 8, 5: 4}[wire]
            value = memoryview(blob)[pos:pos + size]
            pos += size
        if number == path[0]:
            return field(value, path[1:]) if len(path) > 1 else value
    return 0


def summarize(directory, agy_directory=None):
    run = json.loads((directory / "result.json").read_text())
    provider = run["provider"]
    first = peak = calls = cached = uncached = None
    inputs = []
    usage_by_id = {}
    final_tools = {}
    cell_sizes = []
    cell_progress = 0
    owner_bytes = 0
    largest_owner_result = 0
    answer = []
    model = session = None
    fill = []
    with (directory / "frames.jsonl").open() as frames:
        for line in frames:
            entry = json.loads(line)
            m = entry["data"]
            if entry["type"] == "owner_tool_output":
                owner_bytes += m["bytes"]
                largest_owner_result = max(largest_owner_result, m["bytes"])
                continue
            method = m.get("method")
            params = m.get("params", {})
            r = m.get("result")
            if not isinstance(r, dict):
                r = {}
            if provider == "agy":
                if "sessionId" in r:
                    session = r["sessionId"]
                    model = r["models"]["currentModelId"]
                if "usage" in r:
                    cached = r["usage"].get("cachedReadTokens", 0)
                    uncached = r["usage"]["inputTokens"] + r["usage"].get("cachedWriteTokens", 0)
                u = params.get("update", {})
                kind = u.get("sessionUpdate")
                if kind == "usage_update":
                    fill.append(u["used"])
                if kind == "tool_call_update" and u.get("status") in ("completed", "failed"):
                    final_tools[u["toolCallId"]] = list(texts(u.get("content")))
                if kind == "agent_message_chunk":
                    answer.extend(texts(u.get("content")))
            elif provider == "codex":
                if r.get("thread"):
                    model = r["model"]
                if method == "thread/tokenUsage/updated":
                    t = params["tokenUsage"]
                    total = t["total"]["inputTokens"]
                    if not inputs or total != cached + uncached:
                        inputs.append(t["last"]["inputTokens"])
                    cached = t["total"]["cachedInputTokens"]
                    uncached = total - cached
                if method == "rawResponseItem/completed" and params["item"]["type"] == "custom_tool_call_output":
                    blocks = list(texts(params["item"]["output"]))
                    cell_sizes.append(sum(len(t.encode()) for t in blocks))
                    cell_progress += sum(t.count("Rendering table preview frame") for t in blocks)
                if method == "item/completed":
                    item = params["item"]
                    if item["type"] == "agentMessage":
                        answer = [item["text"]]
                    if item["type"] in ("commandExecution", "dynamicToolCall"):
                        final_tools[item["id"]] = list(texts(item.get("aggregatedOutput") or item.get("contentItems")))
            else:
                msg = m.get("message", {})
                if entry["type"] == "assistant":
                    model = msg["model"]
                    usage_by_id[msg["id"]] = msg["usage"]
                if entry["type"] == "user":
                    for block in msg["content"]:
                        if block.get("type") == "tool_result":
                            final_tools[block["tool_use_id"]] = list(texts(block["content"]))
                if entry["type"] == "result":
                    answer = [m["result"]]
                    usage = m["usage"]
                    cached = usage["cache_read_input_tokens"]
                    uncached = usage["input_tokens"] + usage["cache_creation_input_tokens"]
    if provider == "agy":
        peak = max(fill)
        if agy_directory:
            filename = agy_directory / (session + ".db")
            with sqlite3.connect(filename.resolve().as_uri() + "?mode=ro", uri=True) as db:
                input_rows = [(field(row, (1, 4, 2)), field(row, (1, 4, 5))) for (row,) in
                              db.execute("SELECT data FROM gen_metadata ORDER BY idx")]
            inputs = [a + b for a, b in input_rows]
            if (sum(a for a, _ in input_rows), sum(b for _, b in input_rows)) != (uncached, cached):
                raise ValueError("ACP counts disagree with generation records")
    elif provider == "claude":
        inputs = [u["input_tokens"] + u["cache_read_input_tokens"] + u["cache_creation_input_tokens"]
                  for u in usage_by_id.values()]
    if inputs:
        first, calls = inputs[0], len(inputs)
        if peak is None:
            peak = max(inputs)
    answer = "".join(answer).lower()
    useful = all(term in answer for term in ("headers.css", "7px", "passing table header", "sticky table header", "static", "expect"))
    useful = useful and bool(re.search(r"exit[^\n]{0,45}\b1\b", answer))
    tool_bytes = sum(len(t.encode()) for t in chain.from_iterable(final_tools.values()))
    # agy 1.5.18 omits the PwrAgent MCP content from its ACP tool-call updates.
    # Count those MCP text blocks at their source. Both other transports include them.
    if provider == "agy":
        tool_bytes += owner_bytes
    largest_result = max([largest_owner_result] + [sum(len(s.encode()) for s in blocks) for blocks in final_tools.values()])
    progress_lines = sum(t.count("Rendering table preview frame") for t in chain.from_iterable(final_tools.values()))
    captured = run["variant"] == "capture" or (provider == "codex" and run["variant"] in
            ("code-mode", "code-mode-batch", "code-mode-reducer", "code-mode-helper", "code-mode-discovery"))
    if captured and not useful:
        raise ValueError("The captured fixture answer did not contain all required diagnosis fields")
    if run["variant"] in ("code-mode-batch", "code-mode-raw-batch") and len(cell_sizes) != 1:
        raise ValueError("Expected one native cell in the matched batch comparison")
    if captured and (largest_result > 4096 or progress_lines > 16 or cell_progress > 16):
        raise ValueError("A parent-facing result exceeded the noisy fixture's bounded envelope")
    cell_stats = dict(cells=len(cell_sizes), cell_bytes=sum(cell_sizes), largest_cell=max(cell_sizes),
                      cell_progress_occurrences=cell_progress) if cell_sizes else {}
    return dict(**cell_stats, run=directory.name, model=model, first=first, peak=peak, cached=cached,
                uncached=uncached, total=cached + uncached, calls=calls, tool_bytes=tool_bytes,
                largest_tool_result=largest_result, progress_occurrences=progress_lines, answer_fields=useful)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directories", type=Path, nargs="+")
    parser.add_argument("--agy-conversations", type=Path, help="Optional local generation counters for the captured session")
    args = parser.parse_args()
    for directory in args.directories:
        print(json.dumps(summarize(directory, args.agy_conversations)))
