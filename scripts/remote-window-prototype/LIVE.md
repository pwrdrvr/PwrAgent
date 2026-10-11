# Live owned-window prototype

This is running code, not saved-frame playback: a native AppKit fixture is captured with ScreenCaptureKit, hardware-encoded as H.264, sent through two real signed/Noise-encrypted Federation clients and a gateway, decoded with WebCodecs, and drawn live. Typing, scrolling and clicking travel back to the fixture. A PNG repairs settled text. The measured development-adapter run uses separate native/source-helper/viewer-helper/browser processes on **one Mac**. A cross-machine live run is still outstanding.

No VNC/RFB, service forwarding, remote PTY, arbitrary window capture, audio, clipboard, OS input injection, new production enrollment, or production credential export is involved. `LiveFixture.swift` can select only its own PID/window. Its screen-recording permission preflight fails explicitly. It never clicks an OS permission prompt.

## Run the complete live path locally

From this isolated checkout (macOS 14+, Swift SDK and existing Screen Recording permission):

```sh
mkdir -p .local/remote-window
swiftc -O scripts/remote-window-prototype/LiveFixture.swift -o .local/remote-window/live-fixture
PWRWIN_OUTPUT="$PWD/.local/remote-window/live-run" pnpm --filter @pwragent/desktop exec tsx ../../scripts/remote-window-prototype/live-demo.ts --allow-fixture-input
```

Open the URL from `.local/remote-window/live-run/viewer/ready.json` in an isolated Chromium browser and click **Start viewing**. The fragment is an ephemeral **local fixture** token, removed from history after load. Select the canvas and type ordinary characters; Backspace edits, arrow keys and the wheel scroll, clicking changes the fixture's text, and Toggle motion animates it. IME, shortcuts and general app accessibility are not implemented. Omitting `--allow-fixture-input` makes the session view-only. Stop/Start creates a fresh epoch and **does not restore control permission**. Close the native window or Ctrl-C the harness to stop capture and dispose the listeners.

This command runs the actual opt-in runtime adapter on both ends, with a private in-memory fixture trust store and `reconnect` authentication. It neither reads nor modifies enrolled identity stores. Loopback listeners only; no firewall changes. The main runtime's registration call remains disabled unless explicitly configured, and packaged applications ignore the flag.

`live-benchmark.mjs` is browser-side automation for the already-started live viewer. Run through `agent-browser eval --stdin` or an equivalent isolated browser harness. It refuses to benchmark before the first decoded live frame. It sends authored fixture text/scroll/motion commands through the same return path; it does not paint substitute frames. **Save measurements** transfers numeric results to the harness; shutting it down writes `result.json` including real gateway envelope-byte counters. Summarize with:

```sh
python3 scripts/remote-window-prototype/live-summary.py .local/remote-window/live-run/result.json .local/remote-window/live-run/summary.json
```

Repeat with a fresh output directory and `PWRWIN_REQUEST_DELAY_MS=40` for a deterministic 40 ms delay **before each viewer RPC request is transmitted**. This is application-level request delay, not a claim of 40 ms physical RTT, bandwidth shaping or packet loss. The earlier `link-benchmark.mjs` separately tests serialization/stalls.

## Run across already-enrolled peers

The implementation for this path exists, but installed peers do not have it yet. Both participating Electron **main processes** must run this reviewed development build, retaining their existing profiles and identities. Do not run a second app with a cloned identity or create a new enrollment. A renderer reload cannot install the adapter. The existing gateway can relay these ordinary, bounded request envelopes without a new frame kind or capability. Its `gateway_relay` negotiation and the existing peer identities remain required. No service-forwarding permission is repurposed.

Only after choosing an appropriate existing-profile deployment/restart window, create explicit config files in each owned checkout's `.local` directory:

Source:
```json
{"role":"source","peerId":"EXISTING_VIEWER_INSTANCE_ID"}
```

Viewer:
```json
{"role":"viewer","peerId":"EXISTING_SOURCE_INSTANCE_ID"}
```

Start the development application using its normal repository-managed profile workflow, adding `PWRAGENT_DEV_WINDOW_PROTOTYPE=/absolute/path/to/config.json`. A packaged app logs that it ignored this flag. Do not change profiles to evade the no-enrollment requirement. The adapter prints an exact `pwrwin-runtime-*.json` path. It contains a localhost token and is created with mode 0600 (Windows relies on the directory's user ACL); do not publish that file.

Launch the source helper on macOS, selecting that exact ready file and this checkout's compiled fixture:

```sh
node scripts/remote-window-prototype/live-enrolled.mjs --runtime-ready /exact/pwrwin-runtime-file.json --source-executable "$PWD/.local/remote-window/live-fixture" --output "$PWD/.local/remote-window/enrolled-source" --allow-fixture-input
```

Launch the viewer helper on Windows or macOS:

```sh
node scripts/remote-window-prototype/live-enrolled.mjs --runtime-ready /exact/pwrwin-runtime-file.json --output /absolute/owned/output-directory
```

Open the viewer URL from its output `ready.json`. Headless Windows Edge can run this viewer even while its Windows desktop session is disconnected; that does not enable WGC or OS input. This path has **not yet been run across hosts**. The selected Windows Federation instance is connected again; its installed main process still needs the reviewed adapter. No installed app has been restarted or upgraded for this experiment.

## Protocol and limits

`window.prototype.v1.open/pull/ack/input/close/ping` is an independent fixture protocol. Local config pins one peer and one role; a live local helper is additionally required for inbound calls. The router authenticates direct or trusted-relay origins before the bridge checks the configured peer. The negotiated response declares the prototype version, scene, source/viewer IDs, random session, epoch, resolution and chunk budget. This is not a general product capability or permission model.

The source retains one newest captured buffer, one encode credit and one immutable outgoing frame, at most 2 MiB. Changed native buffers replace capture state, never an already-encoded dependency. A reconnect forces a codec keyframe; request IDs fence old encoder completions. Each RPC carries at most 16 KiB of media as base64. This is deliberately compatible with the unchanged RPC transport, at the cost of base64/envelope overhead and stop-and-wait RTT sensitivity. **It is not the intended final binary media transport.** No SQLite writes occur per frame/input; the demo's fixture identities use a private RAM-only database.

The bridge bounds HTTP bodies, outstanding calls, helper queues and timeouts; denies browser origins, arbitrary methods and arbitrary peers; removes its local token file on disposal. Native close revokes capture. Disconnects clear session state; new sessions drop control. Input requires the granted session/epoch, a recently issued owner-clock challenge, an acknowledged frame and strictly sequential input IDs. The fixture only accepts bounded text, Backspace, normalized point coordinates, bounded scroll lines and a motion toggle. No remote command can choose an executable, filesystem path or target OS window.

PNG repair waits 500 ms after change, then uses the same frame/chunk/ACK path. It restores captured image fidelity but incurs a large full-frame burst. Native pixel equality suppresses repeated idle images. PNG repair and video are ordered; the browser never keeps more than one frame's compressed chunks and one decoded image/frame. PNG dimensions are checked before decode. H.264 comes exclusively from the trusted owned helper; arbitrary peer-supplied codec bitstreams and codec sandbox hardening remain a productization task.

The captured 12-bit luminance beacon changes inside the actual native drawing on each input. Timing is recorded only when the decoded canvas contains the requested revision, avoiding the earlier stale-ACK mistake. Measurements end at canvas drawing plus `requestAnimationFrame`, **not physical photons**. `callbackToCanvasSameHostMs` uses wall time only for this same-host experiment; it cannot be applied across unsynchronized machines. Decode support queries do not prove hardware decode: hardware preference timed out on the tested headless Mac; the measured path uses software WebCodecs decode and hardware VideoToolbox encode.

Static accessibility is limited to named buttons/status and a keyboard-focusable canvas. The canvas is not a remote accessibility tree. HiDPI capture, app modals, dynamic resolution, proper cursor semantics, true network loss, general OS input, input-method composition, clipboard, Linux capture and reliable arbitrary-app control remain unfinished.
