"""Run owned-fixture browser measurements. Requires running demo.mts + agent-browser.
Raw data and credentials stay in the specified ignored output directory.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import urlparse

VIEWER_READY = "(() => { const s = window.pwrwin.snapshot(); return s.connected && s.refinementComplete && s.quietMs > 500; })()"

parser = argparse.ArgumentParser()
parser.add_argument("--ready", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
urls = json.loads(args.ready.read_text())
assert all(urlparse(urls[role]).hostname == "127.0.0.1" for role in ("source", "viewer"))
assert urlparse(urls["source"]).netloc == urlparse(urls["viewer"]).netloc
prefix = subprocess.check_output(["agent-browser", "session", "id", "--scope", "worktree", "--prefix", "pwrwin-measure"], text=True).strip()
sessions = {role: f"{prefix}-{os.getpid()}-{role}" for role in ("source", "viewer")}
(args.output / "sessions.json").write_text(json.dumps(sessions))

def browser(role, *commands, script=None):
    result = subprocess.run(["agent-browser", "--session", sessions[role], *commands],
                            input=script, text=True, capture_output=True, timeout=40)
    with (args.output / "browser.log").open("a") as log:
        log.write(result.stdout + result.stderr)
    if result.returncode:
        raise RuntimeError(f"Browser {role} command failed; see browser.log")
    return result.stdout

def evaluate(role, expression):
    result = browser(role, "eval", "--stdin", script=f"(async()=>JSON.stringify(await ({expression})))()")
    return json.loads(json.loads(result))

try:
    browser("source", "batch", "open " + urls["source"], 'wait --fn "window.pwrwin?.snapshot().nativeReady"')
    browser("viewer", "open", urls["viewer"])
    evaluate("viewer", "window.pwrwin.begin().then(()=>true)")
    browser("viewer", "wait", "--fn", "window.pwrwin.snapshot().connected && window.pwrwin.snapshot().refinementComplete")
    # Exclude initial capture-indicator/window activation damage from the idle phase.
    evaluate("viewer", "new Promise(r=>setTimeout(()=>r(true),2000))")
    browser("viewer", "wait", "--fn", VIEWER_READY)
    metadata = evaluate("viewer", "({userAgent:navigator.userAgent,devicePixelRatio,viewport:[innerWidth,innerHeight]})")
    (args.output / "browser-environment.json").write_text(json.dumps(metadata))
    code = Path(__file__).with_name("benchmark-browser.mjs").read_text()
    results = []
    for loss, delay, jitter in [(0, 0, 0), (0.03, 50, 20), (0.1, 100, 30)]:
        faults = {"loss": loss, "delayMs": delay, "jitterMs": jitter}
        row = evaluate("viewer", f"({code})({json.dumps(faults)})")
        browser("viewer", "wait", "--fn", VIEWER_READY)
        # Fetch versioned native checksums over Federation, then compare in the
        # same viewer operation. Switching automation to the source can activate
        # native windows and change the captured scene between reference/readback.
        row["pixelCheck"] = evaluate("viewer", "window.pwrwin.checkPixels()")
        matches = row["pixelCheck"]["matches"]
        row["opaqueRgbHashMatches"] = matches
        row["source"] = evaluate("source", "window.pwrwin.snapshot()")
        results.append(row)
        (args.output / "benchmark.json").write_text(json.dumps(results))
        # Read the owned canvas backing pixels; a viewport screenshot can clip its
        # lower half when the canvas is taller than the headless viewport.
        png = evaluate("viewer", 'document.querySelector("canvas").toDataURL("image/png")')
        (args.output / f"loss-{loss}-canvas.png").write_bytes(base64.b64decode(png.split(",", 1)[1]))
        print(json.dumps({"loss": loss, "delayMs": delay, "opaqueRgbHashMatches": matches,
                          "missing": row["state"]["missing"], "errors": row["state"]["errors"]}), flush=True)
        if matches != 117 or row["state"]["errors"] or row["source"]["errors"]:
            raise RuntimeError("Pixel verification or browser protocol failed")
    evaluate("source", "(window.pwrwin.save(), true)")
    evaluate("viewer", "(window.pwrwin.save(), true)")
    before = evaluate("viewer", "window.pwrwin.snapshot().epoch")
    evaluate("viewer", "(window.pwrwin.faults({loss:0,delayMs:0,jitterMs:0}),window.pwrwin.begin().then(()=>true))")
    browser("viewer", "wait", "--fn", VIEWER_READY)
    pixel_check = evaluate("viewer", "window.pwrwin.checkPixels()")
    reconnect = {"oldEpoch": before, "newEpoch": evaluate("viewer", "window.pwrwin.snapshot().epoch"),
                 "opaqueRgbHashMatches": pixel_check["matches"]}
    (args.output / "logical-reconnect.json").write_text(json.dumps(reconnect))
    if reconnect["newEpoch"] == before or reconnect["opaqueRgbHashMatches"] != 117:
        raise RuntimeError("Logical reconnect failed")
finally:
    cleanup_errors = []
    for role in ("viewer", "source"):
        try:
            browser(role, "close")
        except Exception as error:
            cleanup_errors.append(f"{role}: {error}")
    if cleanup_errors:
        raise RuntimeError("Browser cleanup failed; stop the owned harness with Ctrl-C: " + "; ".join(cleanup_errors))
