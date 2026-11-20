"""Recompute cross-host numeric results from saved source and viewer artifacts."""
import json
import math
import sys
from pathlib import Path

def dist(values):
    values = sorted(values)
    if not values:
        return None
    return {"count": len(values), "p50": values[math.ceil(len(values)*.5)-1],
            "p95": values[math.ceil(len(values)*.95)-1], "max": values[-1]}

source = json.loads(Path(sys.argv[1]).read_text())
viewer = json.loads(Path(sys.argv[2]).read_text())
browser = viewer.get("browser", viewer)
phases = []
for phase in browser.get("phases", []):
    frames = browser["frames"][phase["first"]:phase["endIndex"]]
    duration = (phase["end"] - phase["start"]) / 1000
    video = [f for f in frames if f["format"] == "h264"]
    phases.append({"name": phase["name"], "durationSeconds": duration,
        "frames": len(frames), "videoFrames": len(video),
        "pngFrames": sum(f["format"] == "png" for f in frames),
        "videoFramesPerSecond": len(video) / duration,
        "mediaPayloadBytes": sum(f["bytes"] for f in frames),
        "videoPayloadBytes": sum(f["bytes"] for f in video),
        "pngPayloadBytes": sum(f["bytes"] for f in frames if f["format"] == "png"),
        "mediaPayloadBytesPerSecond": sum(f["bytes"] for f in frames) / duration,
        "sourceEncodeMs": dist([f["encodeMs"] for f in video]),
        "viewerDecodeAndPresentMs": dist([f["decodeAndPresentMs"] for f in video]),
        "viewerTransferAndPresentMs": dist([f["transferAndPresentMs"] for f in frames])})
summary = {"schema": 1, "crossHost": True,
    "percentileMethod": "nearest rank",
    "path": "M2/dev owned AppKit fixture -> ScreenCaptureKit -> VideoToolbox H264/PNG -> enrolled authenticated Federation RPC -> Windows Edge WebCodecs canvas",
    "decoderConfig": browser.get("decoderConfig"), "phases": phases,
    "inputToCanvasMs": dist([i["inputToCanvasMs"] for i in browser.get("inputs", [])]),
    "rpcPingMs": dist(browser.get("pings", [])),
    "sourceEncodeMsVideo": dist([f["encodeMs"] for f in browser.get("frames", []) if f["format"] == "h264"]),
    "viewerDecodeAndPresentMs": dist([f["decodeAndPresentMs"] for f in browser.get("frames", [])]),
    "viewerTransferAndPresentMs": dist([f["transferAndPresentMs"] for f in browser.get("frames", [])]),
    "decodedFrames": len(browser.get("frames", [])),
    "mediaPayloadBytes": sum(f["bytes"] for f in browser.get("frames", [])),
    "acceptedInputs": len(browser.get("acceptedInputs", [])),
    "visuallyAcknowledgedInputs": len(browser.get("inputs", [])),
    "pngFrames": sum(f["format"] == "png" for f in browser.get("frames", [])),
    "pngPayloadBytes": sum(f["bytes"] for f in browser.get("frames", []) if f["format"] == "png"),
    "videoPayloadBytes": sum(f["bytes"] for f in browser.get("frames", []) if f["format"] == "h264"),
    "viewerTransferAndPresentDefinition": "Starts after first pull response; includes remaining chunk pulls, reconstruction, decode, draw and RAF. Excludes initial request/wait/pull and final ACK. Not total delivery time or pure network latency.",
    "errors": browser.get("errors", []), "sourceSessionWholeRun": source.get("session"),
    "sourceNativeLog": source.get("nativeLog"),
    "sourceHelperElapsedMsWholeRun": source.get("elapsedMs"),
    "sourceHelperCpu": source.get("helperCpu"),
    "sourceHelperMaxRssKiB": source.get("helperMaxRssKiB"),
    "viewerHelperCpu": viewer.get("helperCpu"),
    "viewerHelperMaxRssKiB": viewer.get("helperMaxRssKiB"),
    "limits": ["callbackToCanvasSameHostMs invalid across unsynchronized hosts and excluded",
        "Browser-monotonic input completion ends at canvas draw plus RAF, not photons",
        "Media payload bytes exclude base64, RPC/encryption, gateway/WebSocket/TCP overhead; network-wire bytes unmeasured",
        "Hardware encode requires native encoder log; WebCodecs configuration does not prove hardware decode",
        "Source/helper CPU and session counters include operator wait and later resync, not only first benchmark phases",
        "Synthetic fixture input only; arbitrary app/OS control unimplemented",
        "Logical Stop/Start does not prove physical network reconnect",
        "Ping samples include operator wait and are not isolated to benchmark phases"]}
Path(sys.argv[3]).write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps({key: summary[key] for key in ["decodedFrames", "acceptedInputs", "visuallyAcknowledgedInputs", "inputToCanvasMs", "rpcPingMs", "errors"]}, indent=2))
