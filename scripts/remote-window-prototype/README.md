# Remote-window experiment

Read the [decision and measured limitations](../../docs/remote-window-prototype/README.md) before interpreting these scripts as a product feature. The source is hardwired to its own fake-data AppKit window. No arbitrary window IDs, display capture, audio, clipboard or OS-wide input are accepted. The [live prototype](LIVE.md) now adds an explicit development-only runtime adapter; no installed peer has been enabled or restarted.

## Continuous live capture and interaction

Use [LIVE.md](LIVE.md) for the runnable native capture → real Noise-encrypted Federation → WebCodecs viewer, separate source/viewer helper processes, fixture input, lossless settled-text repair, benchmark commands and the opt-in adapter for existing enrolled peers. The measured live path includes Mac-to-Windows Federation; see the report for its poor responsiveness and remaining limits. The older file-transfer and offline measurements below retain their original limits.

## macOS capture

Requirements: macOS 14+ for the used SCK options, installed Swift/Xcode SDK, and OS capture permission. Tested on macOS 26.6.2, Swift 6.2.3. Launch creates only an owned synthetic window and automatically obscures, moves, minimizes, restores and resizes that window over 36 seconds. It does not lock the desktop or change Spaces. Run one fixture process at a time. Close the fixture to stop.

```sh
mkdir -p .local/remote-window
swiftc -O scripts/remote-window-prototype/CaptureFixture.swift -o .local/remote-window/capture-fixture
/usr/bin/time -l .local/remote-window/capture-fixture .local/remote-window/capture-1x > .local/remote-window/capture-1x.jsonl 2> .local/remote-window/resources-1x.txt
FIXTURE_SCALE=2 /usr/bin/time -l .local/remote-window/capture-fixture .local/remote-window/capture-2x > .local/remote-window/capture-2x.jsonl 2> .local/remote-window/resources-2x.txt
```

Screen capture may require the operator to approve the OS prompt or the launching app in Privacy & Security. No prompt is dismissed or bypassed. The program logs preflight status and errors; it selects only the window whose ID **and owning PID** match itself. `SCContentFilter(desktopIndependentWindow:)` is used, without audio or cursor. Each phase saves at most 90 PNGs, while callback status continues to be logged. At 2×, synchronous PNG writes can delay timers and callbacks. Read actual phase timestamps rather than assuming all observations last exactly four seconds.

Native hardware encode mode writes numeric frame/encode results instead of PNGs. It explicitly requires a hardware H.264 encoder. It measures capture-callback-to-encode callback, not app-render-to-photon latency. Run these sequentially:

```sh
FIXTURE_ENCODER=vt /usr/bin/time -l .local/remote-window/capture-fixture .local/remote-window/native-final-1x > .local/remote-window/native-final-1x.jsonl 2> .local/remote-window/native-final-resources-1x.txt
FIXTURE_ENCODER=vt FIXTURE_SCALE=2 /usr/bin/time -l .local/remote-window/capture-fixture .local/remote-window/native-final-2x > .local/remote-window/native-final-2x.jsonl 2> .local/remote-window/native-final-resources-2x.txt
python3 scripts/remote-window-prototype/summarize-capture.py .local/remote-window .local/remote-window/capture-native.json
```

Check exit status, `stop`/`error`/`encodeError` records, and final `done`; phase timers alone are not proof of a functioning stream. Per-frame PNG instrumentation uses Core Image while native encode uses the original SCK pixel buffer. Core Image color conversion, output scaling and dithering are part of the PNG reference; lossless comparisons are to those captured RGB pixels, not to the app's ideal vector text.

## Offline codec and damage comparison

Use a local virtual environment; no project dependency or system package change is required. FFmpeg must already provide the encoders selected in `benchmark.py`. Missing encoders are recorded as failures, never silently substituted. The experiment used Pillow 12.3.0 and the installed Homebrew FFmpeg.

```sh
python3 -m venv .local/remote-window/venv
.local/remote-window/venv/bin/pip install Pillow==12.3.0
.local/remote-window/venv/bin/python scripts/remote-window-prototype/benchmark.py .local/remote-window/capture-1x --out .local/remote-window/bench-1x --video > .local/remote-window/benchmark-1x.log 2>&1
.local/remote-window/venv/bin/python scripts/remote-window-prototype/benchmark.py .local/remote-window/capture-2x --out .local/remote-window/bench-2x > .local/remote-window/benchmark-2x.log 2>&1
.local/remote-window/venv/bin/python scripts/remote-window-prototype/verify-tiles.py .local/remote-window/capture-1x .local/remote-window/bench-1x .local/remote-window/lossless-verification.json
.local/remote-window/venv/bin/python scripts/remote-window-prototype/quality.py .local/remote-window/bench-1x .local/remote-window/quality.json
```

`benchmark.json` records commands, bytes, timing and failures. Image rates assume a 30-fps replay of saved frames; they are not observed capture rates. PNG and lossy WebP baselines are included alongside lossless WebP. Video throughput is offline wall time including process startup/PNG decode/container writing, not live encode latency. Full-frame and tile work are intentionally reported separately by newer runs; the original local runs retain the combined timing field.

## Real Federation round trip

Use existing enrolled peers with `file_push` permission and capability; obtain current readiness first. Do not enroll, change firewall rules, or configure a service tunnel for this test. Transfer only the authored fixture artifacts using PwrAgent's `push_instance_file`:

1. Send this `viewer.html` as `pwrwin-viewer.html` and one generated `pwrwin-*.json` batch to the selected peer.
2. Open the viewer in an isolated browser, explicitly select the transferred file, wait for import, then Play. Save measurements. The browser CSP forbids network access; the local file content is not trusted for peer authentication.
3. The [Windows harness](windows/README.md) automates exactly that explicit import and saves canvas-only screenshots. It does not scan Downloads or capture private windows. Inspect those screenshots before publishing them.
4. Record tool wall time, payload size/hash, remote decode/draw and capture timing separately. This is store-and-forward through real Federation, not live video or input-to-photon.

For the helper interaction experiment, choose an unused exact input filename and a fresh session string on both peers. The source explicitly launches:

```sh
FIXTURE_INPUT_FILE=/absolute/path/to/pwrwin-input-unique.json FIXTURE_INPUT_SESSION=unique-session .local/remote-window/capture-fixture .local/remote-window/capture-input > .local/remote-window/capture-input.jsonl
```

It waits at most 180 seconds for that file and consumes it once. Transfer this **fixed-action** JSON from the selected viewer through Federation with the agreed filename:

```json
{"version":1,"sessionId":"unique-session","sceneId":"synthetic-app-window","epoch":1,"inputSeq":0,"action":"fixture-toggle","issuedTimeMs":0}
```

This changes only the footer of the source's own fixture. It is not an OS input API, keyboard injection, arbitrary text channel or production control grant. The local file is operator-selected and the receipt is one-shot; it is not connected to the separate session state machine and should not be exposed as a live product API. `issuedTimeMs` is diagnostic, not a synchronized latency clock or freshness authority. Use a fresh filename because file transfer does not overwrite existing files.

Select a **visually confirmed changed** captured PNG, not merely the first callback after acceptance. Package and transfer it back:

```sh
.local/remote-window/venv/bin/python scripts/remote-window-prototype/package-frame.py /path/to/changed-fixture.png .local/remote-window/pwrwin-visible.json CAPTURE_CALLBACK_TIMESTAMP_MS
```

The optional timestamp comes from the source JSONL. If omitted it is `null`; packaging time is not capture time. The first experiment caught a stale callback; the later returned canvas was inspected and showed `REMOTE FIXTURE COMMAND ACCEPTED`.

## Protocol and congestion experiments

```sh
pnpm install --frozen-lockfile
pnpm test scripts/remote-window-prototype/session.test.mjs scripts/remote-window-prototype/federation.test.mjs scripts/remote-window-prototype/viewer.test.mjs scripts/remote-window-prototype/link-transmission.test.mjs
node scripts/remote-window-prototype/link-benchmark.mjs .local/remote-window/pwrwin-visible.json .local/remote-window/link-benchmark.json
```

`session.mjs` tests identity/epoch/revocation/input freshness and bounded newest-only snapshots. Its local fixture-control grant is not remotely callable. The integration test uses the repository's actual `FederationRouter` and `FederationRpcEndpoint`; it is an in-process test and does not imply deployment to live peers. `link-benchmark.mjs` uses actual loopback TCP with application-level delays/stalls and fixed captured packet bytes. Serialization and retransmission-like stalls occur before a packet is written; the receiver then adds propagation delay. It does not simulate true network packet loss, codec dependencies or decode. No port is bound beyond `127.0.0.1`, and the listener is closed afterward.

## Current gaps

No enabled production capability, validated live cross-machine video, real WAN loss experiment, general remote OS input, clipboard, app-modal scene management, Linux execution, macOS lock/Space validation, or measured photons. Windows active-desktop WGC is blocked until the operator reconnects the authorized session and the readiness guard passes. Pixel-exact saved-frame verification and headless canvas timing do not establish accessibility, actual monitor fidelity or a seamless remote-app experience.
