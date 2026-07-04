#!/usr/bin/env python3
"""Generate a synthetic Codex protocol-capture fixture (JSONL) that replicates
the real `thread/tokenUsage/updated` shape, with entirely fabricated
ids/tokens and NO PII.

Provenance: hand-authored from the observed shape of a real live capture
(see docs/plans/2026-07-04-001-feat-observed-context-replay-counting-plan.md).
The real capture could not be committed because it contained PII; this
generator produces an equivalent, fully synthetic stand-in.

Unlike the two trivial single-request turns in the real capture, this fixture
includes:
  - Turn A: a multi-request turn (6 model requests) = the true within-turn
    context-replay scenario, mixing cold (cache-miss) and hot (cache-hit)
    replays, including a mid-turn cache miss.
  - A DUPLICATE emission of one request's snapshot (identical `last`, identical
    `total`) so tests can assert the accumulator dedups on a non-increasing
    `total.inputTokens`.
  - Turn B: a single-request hot turn (like the real capture's second turn).

Run: `python3 generate-replay-capture.py` (writes the .jsonl next to this
script; the committed .jsonl is the output of this script and should be
regenerated here if the shape changes).

Expected classification at HOT_CACHE_FRACTION = 0.9:
  Turn A -> 2 cold + 4 hot replays (+1 duplicate that must be dedup'd)
  Turn B -> 1 hot replay
"""
import json
import os

THREAD = "0000fake-thread-7777-8888-999900001111"
TURN_A = "0000fake-turnA-aaaa-bbbb-ccccddddeeee"
TURN_B = "0000fake-turnB-1111-2222-333344445555"
MCW = 258400
CAPTURE_ID = "2026-07-04T00-00-00-000Z-codex-synthetic"
HOT_CACHE_FRACTION = 0.9

# Cumulative baseline representing unobserved forked-in history before Turn A.
base = dict(inputTokens=1_000_000, cachedInputTokens=900_000,
            outputTokens=20_000, reasoningOutputTokens=4_000)

# Per-request breakdowns for Turn A. (kind, input, cached, output, reasoning)
# cold = cache miss (cached << input); hot = cache hit (cached ~ input).
TURN_A_REQUESTS = [
    ("cold", 160_000, 6_400,   120, 40),   # req1: first request after fork -> cold
    ("hot",  163_200, 159_800, 90,  20),   # req2
    ("hot",  168_400, 164_900, 110, 30),   # req3  (emitted twice -> dedup test)
    ("hot",  172_900, 169_100, 95,  25),   # req4
    ("cold", 177_500, 8_200,   130, 35),   # req5: mid-turn cache miss -> cold
    ("hot",  182_300, 178_400, 140, 45),   # req6
]
# Turn B: one hot request (context now fully warm).
TURN_B_REQUESTS = [
    ("hot",  159_821, 159_104, 6,   0),
]

seq = 0
ts = 1_783_000_000_000
lines = []


def emit(direction, kind, method, raw_obj, thread_ids):
    global seq, ts
    seq += 1
    ts += 1200
    env = {
        "backend": "codex",
        "backendInstance": "default",
        "captureId": CAPTURE_ID,
        "direction": direction,
        "kind": kind,
        "method": method,
        "sequence": seq,
        "timestamp": ts,
        "threadIds": thread_ids,
        "raw": json.dumps(raw_obj, separators=(",", ":")),
    }
    lines.append(json.dumps(env))


def token_usage_notification(turn_id, last):
    """Add `last` onto the running cumulative `base` and emit the notification."""
    for k in ("inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"):
        base[k] += last[k]
    total = dict(base)
    total["totalTokens"] = (total["inputTokens"] + total["outputTokens"]
                            + total["reasoningOutputTokens"])
    last_full = dict(last)
    last_full["totalTokens"] = (last["inputTokens"] + last["outputTokens"]
                                + last["reasoningOutputTokens"])
    emit("inbound", "notification", "thread/tokenUsage/updated", {
        "method": "thread/tokenUsage/updated",
        "params": {
            "threadId": THREAD,
            "turnId": turn_id,
            "tokenUsage": {"total": total, "last": last_full,
                           "modelContextWindow": MCW},
        },
    }, [THREAD])


def token_usage_duplicate(turn_id):
    """Re-emit the CURRENT cumulative snapshot without advancing base -> dedup."""
    total = dict(base)
    total["totalTokens"] = (total["inputTokens"] + total["outputTokens"]
                            + total["reasoningOutputTokens"])
    prev = TURN_A_REQUESTS[2]  # repeat req3's `last` values
    last = {"inputTokens": prev[1], "cachedInputTokens": prev[2],
            "outputTokens": prev[3], "reasoningOutputTokens": prev[4]}
    last["totalTokens"] = last["inputTokens"] + last["outputTokens"] + last["reasoningOutputTokens"]
    emit("inbound", "notification", "thread/tokenUsage/updated", {
        "method": "thread/tokenUsage/updated",
        "params": {"threadId": THREAD, "turnId": turn_id,
                   "tokenUsage": {"total": total, "last": last,
                                  "modelContextWindow": MCW}},
    }, [THREAD])


def run_turn(turn_id, requests, dup_after_index=None):
    emit("inbound", "notification", "turn/started",
         {"method": "turn/started", "params": {"threadId": THREAD, "turnId": turn_id}}, [THREAD])
    for i, (_kind, inp, cached, out, reasoning) in enumerate(requests):
        token_usage_notification(turn_id, {
            "inputTokens": inp, "cachedInputTokens": cached,
            "outputTokens": out, "reasoningOutputTokens": reasoning})
        if dup_after_index == i:
            token_usage_duplicate(turn_id)   # identical re-emit
    emit("inbound", "notification", "turn/completed",
         {"method": "turn/completed",
          "params": {"threadId": THREAD, "turnId": turn_id,
                     "turn": {"id": turn_id, "status": "completed"}}}, [THREAD])


emit("inbound", "notification", "thread/started",
     {"method": "thread/started", "params": {"threadId": THREAD}}, [THREAD])
run_turn(TURN_A, TURN_A_REQUESTS, dup_after_index=2)   # duplicate after req3
run_turn(TURN_B, TURN_B_REQUESTS)

out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "synthetic-codex-replay-capture.jsonl")
with open(out_path, "w") as f:
    f.write("\n".join(lines) + "\n")

cold = sum(1 for _k, inp, cached, *_ in TURN_A_REQUESTS if cached < HOT_CACHE_FRACTION * inp)
hot = len(TURN_A_REQUESTS) - cold
print(f"wrote {len(lines)} envelope lines -> {out_path}")
print(f"Turn A expected replays @ {HOT_CACHE_FRACTION:.0%}: cold={cold}, hot={hot} "
      f"(+1 duplicate emission to dedup)")
print(f"Turn B: 1 hot request")
print(f"Final cumulative: input={base['inputTokens']:,} cached={base['cachedInputTokens']:,}")
