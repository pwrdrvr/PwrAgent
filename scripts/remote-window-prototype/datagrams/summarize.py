"""Generate the compact checked-in report from ignored benchmark output."""
import hashlib
import json
import math
from pathlib import Path
import sys

root = Path(sys.argv[1])
rows = json.loads((root / "benchmark.json").read_text())
run = json.loads((root / "result.json").read_text())

def percentile(values, fraction):
    return sorted(values)[math.ceil(len(values) * fraction) - 1] if values else None

print("# Push WebP measurements\n")
print(f"Measured {run['measuredAt']}. Single M2 Max, 32 GiB RAM, macOS 27.0.1; two isolated headless Chrome 152 instances; libwebp 1.6.0. Capture 800×548, viewer DPR 1. No physical network impairment.\n")
print("Faults below are seeded drops and delay of **complete WebRTC application messages after delivery**, with bounded random reordering. They do not emulate SCTP congestion or network packet loss. Selected ICE transport was UDP in every run.\n")
print("| Message loss / delay | Phase | Duration ms | Media bytes | Previews drawn | Tiles drawn | Decode+draw p95 ms |")
print("|---|---|---:|---:|---:|---:|---:|")
for row in rows:
    f = row["faults"]
    label = f"{f['loss']*100:.0f}% / {f['delayMs']}–{f['delayMs']+f['jitterMs']} ms"
    for phase in row["phases"]:
        p95 = percentile(phase["decodeMs"], 0.95)
        timing = f"{p95:.2f}" if p95 is not None else "—"
        print(f"| {label} | {phase['name']} | {phase['durationMs']:.0f} | {phase['mediaBytes']:,} | {phase['previews']} | {phase['tiles']} | {timing} |")
print("\nMedia bytes include the 28-byte experimental fragment header and WebP/preview-version payload. They exclude SCTP/DTLS/UDP/IP, reliable feedback, local bridges, and Federation signaling. Counts are received before injected loss. Decode+draw starts immediately before createImageBitmap and ends after synchronous canvas drawing; no rAF, display scanout, or photon claim. A preview is one coarse image with at least one region drawn; a tile is one independent refinement, not a whole frame.\n")
print("| Loss | Motion previews/s | Motion media bytes/s | Stop-to-full-refinement ms | Opaque pixel checks | Cancelled preview/refinement work (cumulative) |")
print("|---|---:|---:|---:|---:|---:|")
for row in rows:
    motion = next(p for p in row["phases"] if p["name"] == "motion")
    settled = next(p for p in row["phases"] if p["name"] == "motion-settle")
    sent = row["source"]["send"]
    print(f"| {row['faults']['loss']*100:.0f}% | {motion['previews']*1000/motion['durationMs']:.2f} | {motion['mediaBytes']*1000/motion['durationMs']:.0f} | {settled['durationMs']:.0f} | {row['opaqueRgbHashMatches']}/117 | {sent['cancelledPreviews']}/{sent['cancelledRefinements']} |")
print("\nSettling begins after the local synthetic fixture acknowledges stopping motion. It ends when that revision is visible in actual canvas beacon pixels and every currently announced tile has its lossless version. This is a browser-monotonic fixture-to-canvas completion measurement, not remote OS input or input-to-photon latency. Pixel checks compare independent native pre-encode and browser post-draw FNV-1a checksums of opaque RGB pixels, plus tile versions; alpha-edge rounding and display color management are excluded.\n")
for name in ["previewEncodeMs", "tileEncodeMs"]:
    values = run["native"][name]
    print(f"- Native {name}: n={len(values)}, p50 {percentile(values,0.5):.3f} ms, p95 {percentile(values,0.95):.3f} ms.")
n = run["native"]["resources"]
print(f"- Native whole-run resources: {n['wallSeconds']:.2f} s wall, {n['userSeconds']:.3f} s user CPU, {n['systemSeconds']:.3f} s system CPU, {n['maxRssBytes']/1048576:.2f} MiB peak RSS.")
h = run["helper"]
print(f"- Node helper whole-run resources: {h['wallMs']/1000:.2f} s wall, {(h['cpuMicroseconds']['user']+h['cpuMicroseconds']['system'])/1e6:.3f} s CPU, {h['maxRssKiB']/1024:.2f} MiB peak RSS.")
last = rows[-1]["state"]
print(f"- Observed receive-assembly peak: {last['receive']['peakBytes']:,} bytes; queued encoded-image peak awaiting decode: {last['peakDecodeQueueBytes']:,} bytes. Neither includes browser internals.")
print("- Nominal idle intervals: " + "; ".join(f"{r['faults']['loss']*100:.0f}%: {r['phases'][0]['mediaBytes']} media bytes / {r['phases'][0]['feedbackSentBytes']+r['phases'][0]['feedbackReceivedBytes']} feedback bytes" for r in rows) + ". ICE/DTLS keepalive traffic is excluded.")
print("- The baseline idle interval was unchanged and sent zero application bytes. The later nominal idle intervals received fresh native versions covering all 117 tiles despite no fixture command. Their traffic is retained above; they are NOT evidence of zero-byte idle. The trigger of these whole-window invalidations was not isolated (window activation/capture-indicator changes are hypotheses). Investigate before production; do not attribute the bytes to injected loss alone.")
reconnect = json.loads((root / "logical-reconnect.json").read_text())
print(f"- Logical Stop/Start: new epoch {reconnect['oldEpoch'] != reconnect['newEpoch']}; {reconnect['opaqueRgbHashMatches']}/117 opaque pixel checks match. No physical link outage/reconnect was tested.")
print("- Native/helper resources include setup, idle, screenshots, and logical reconnect. Chromium CPU/RSS, GPU utilization, energy, physical wire bytes, cross-host latency, and 2× capture were not measured in this experiment.\n")
print("These are single sequential trials with accumulating fixture state, not repeated statistical comparisons. In particular, the stop-to-refinement values are individual observations, not latency percentiles.\n")
print("Raw generated JSON stays in the ignored run directory. Use the [reproduction instructions](../../scripts/remote-window-prototype/datagrams/README.md); this report contains no frame-by-frame dump. SHA-256 provenance:\n")
for name in ["benchmark.json", "result.json", "logical-reconnect.json", "loss-0.1-canvas.png"]:
    path = root / name
    print(f"- `{name}` ({path.stat().st_size:,} bytes): `{hashlib.sha256(path.read_bytes()).hexdigest()}`")
