# Windows single-window experiment

The operator subsequently restored the desktop. See [active-desktop.md](active-desktop.md) for successful guarded WGC and separate local input measurements. The disconnected-session results below are retained as measured.

This standalone fixture experiment changes no PwrAgent product code, lab configuration, session ownership, network, or enrollment. It uses no VNC/RFB. All authored files and build outputs belong to this worktree. The remote source and common browser viewer are owned by the parent experiment.

## Observed result, 2026-10-11

**Federation store-and-forward and Windows browser decode/draw succeeded. Windows interactive WGC capture was blocked by desktop readiness.**

The PwrAgent process was in session 1, which `query session` reported as disconnected. Console session 2 was connected. `Environment.UserInteractive=true`, DWM composition enabled, and `GraphicsCaptureSession.IsSupported()=true` were insufficient readiness checks. `OpenInputDesktop` failed with error 5. The final probe also checks `WTSConnectState`; it records `session_active=false` and exits 3 before creating windows or sending input.

The lab's `interactive-e2e/owner.json` did not exist and `PwrLab-Interactive-E2E` was Ready. This was read-only inspection; no lock, task, desktop session, or lab setting was changed. The parent read the attached lab skill and relayed its applicable ownership constraints. No lab checkout/skill was present under this peer's `C:/PwrLab/repos` inventory.

### Native exploratory observation

Before the disconnected state was identified, the initial own-HWND probe obtained these results. The state names describe requested window operations in a disconnected session, **not proven on-screen visibility or occlusion**. Each WGC observation lasted about 2.2 seconds.

| Requested state | WGC frames | PrintWindow call | PNG bytes | Client pixels |
|---|---:|---:|---:|---|
| Visible | 0 | 85.0387 ms | 3,643 | 694 × 349 |
| Obscured by another owned fixture | 0 | 11.7806 ms | 3,638 | 694 × 349 |
| Resized | 0 | 4.4802 ms | 4,672 | 934 × 469 |
| Minimized | 0 | Not captured: empty client | — | — |

The initial probe stopped at the zero-sized minimized client before its restored/input stages. The local exploratory JSON explicitly identifies its reconstructed JSON closure; all observed numbers are unchanged. The final source handles an empty client and refuses disconnected sessions up front. These are single observations, not performance distributions. The visible PrintWindow image was visually inspected and contains only invented fixture text and a rectangle.

Per-monitor v2 awareness was enabled and the fixture reported 192 DPI. Resize changed the fallback bitmap dimensions. No cross-monitor DPI transition, valid WGC resize, active-desktop occlusion, or live minimized behavior was verified. No Windows `SendInput` was executed: capture readiness blocked that test. The future active-desktop test closes capture before testing a focused fixture F8 key; a separate posted click is labeled `PostMessage`, not OS input.

### Remote browser playback

The source was an actual macOS ScreenCaptureKit fixture capture, encoded by the parent as lossless WebP tiles. Its self-contained JSON and common viewer arrived through the existing enrolled Federation `file_push`. The viewer's CSP forbids network access. Windows ran the unchanged received viewer in Edge 155, headless, with its own profile and Chromium sandbox enabled. A headless canvas is not an interactive desktop or photon measurement.

| Batch | Bytes | Frames | Import | Playback | Decode + draw p50 / p95 |
|---|---:|---:|---:|---:|---|
| Scroll, 800 × 548 | 4,191,302 | 90 | 454.184 ms | 2,996.7 ms | 12.0 / 14.9 ms |
| Initial input acknowledgement | 169,249 | 1 | 195.783 ms | 74.0 ms | 63.5 / 63.5 ms |
| Later visible acknowledgement | 225,112 | 1 | 170.889 ms | 75.5 ms | 66.0 / 66.0 ms |

Raw per-frame measurements are in `benchmarks/windows-viewer-*.json`. Import includes Playwright/file-input handling and first-frame decode. Decode/draw values use the viewer's local `performance.now`; presentation opportunities use rAF. They exclude capture, encoding, Federation transfer, and any real display scanout. No cross-machine clock subtraction or input-to-photon claim is made. The parent separately records forward file transfer wall time.

The scroll canvas first/last images were inspected: synthetic-only source chrome and code, first visible line 38 versus line 10, with no unrelated desktop pixels. Artifacts are canvas-element PNGs (800 × 548 image plus the viewer's one-pixel border), not whole-desktop screenshots.

The 159-byte reverse `fixture-toggle` command used the exact parent-provided session, epoch, sequence, scene, and action. Federation reported successful storage in 188 ms tool wall time. The parent confirmed its own app accepted the command. This is an application helper action, not OS input injection or a production authenticated input protocol. The first returned capture was stale: the Windows canvas still said `Type in this fixture only`. That stale visual result was reported immediately rather than accepted as acknowledgement.

The later `pwrwin-input-visible.json` was decoded and visually inspected on Windows: its footer says **REMOTE FIXTURE COMMAND ACCEPTED**. This completes the real capture/file-transfer/viewer/reverse-helper-input/recapture loop. The parent independently measured the first stale callback at 26.7 ms and the later visibly updated capture callback at 173.6 ms after local helper acceptance. Those source-local values are not cross-machine latency or photons, and scheduling/PNG instrumentation perturbs them. Earlier source packages used packaging time in `captureTimeMs`; this experiment never used that field for latency. The parent corrected the later visible package to use the actual capture callback timestamp.

## Reproduce

Requirements: Windows, Visual Studio 2022 C++ Build Tools with a C++/WinRT-capable Windows SDK, and the already installed Edge browser. No package or machine installation is performed by these scripts.

From this worktree, compile and run the native fixture:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/remote-window-prototype/windows/run.ps1
```

`ExecutionPolicy Bypass` is process-local for the authored script; it changes no persistent policy and is unrelated to capture consent. The run script checks the lab owner/task read-only when `C:/PwrLab` exists. It fails closed if ownership cannot be checked. The executable then requires an active session and the Default input desktop. It accepts no external HWND and verifies the capture target belongs to its own process. It uses `CreateForWindow`, keeps OS capture indicators enabled, and does not suppress or act on a permission prompt. If one appears, the operator must handle it.

The operator action needed for interactive testing is to reconnect and unlock the existing authorized Windows test account/session, leave that desktop active, ensure no other run owns the display, and rerun from that session. Do not reconnect, move a session, or alter lab ownership automatically. A connection alone may not resolve desktop ACL or tool-runtime failures; the readiness guard must pass.

To measure the received common viewer:

```powershell
$env:PLAYWRIGHT_MODULE = "<absolute installed playwright module directory>"
node scripts/remote-window-prototype/windows/measure-viewer.mjs `
  "$env:USERPROFILE/Downloads/pwrwin-viewer.html" `
  "$env:USERPROFILE/Downloads/pwrwin-scroll-800.json" `
  .local/remote-window-windows/viewer-scroll-800
```

Only the explicit `pwrwin-*.json` input is imported. No Downloads scan or autonomous discovery occurs in the harness. This run used the existing Playwright 1.63 module read-only; no other checkout was edited or built. Browser/tool kernels initially failed sandbox setup, so the authorized standalone harness was executed outside the command sandbox. The browser's own sandbox remained enabled.

Builds, browser profiles, full transferred batches, and PNG artifacts stay under `.local/remote-window-windows/`. Raw numeric benchmarks remain local and are not committed. Artifact locations from this run:

- `viewer-scroll-800/canvas-first.png` and `canvas-last.png` — reviewed scroll playback.
- `viewer-input-ack/canvas-last.png` — reviewed stale acknowledgement.
- `viewer-input-visible/canvas-last.png` — reviewed visible accepted-command footer.
- `run-2/printwindow-visible.png`, `printwindow-obscured.png`, `printwindow-resized.png` — fallback fixture images.

Reviewed scroll results were pushed back to the parent as `pwrwin-windows-scroll-800-benchmark.json`, `pwrwin-windows-scroll-800-first.png`, and `pwrwin-windows-scroll-800-last.png` in its Downloads folder.
The verified acknowledgement was also pushed as `pwrwin-windows-visible-ack-benchmark.json` and `pwrwin-windows-visible-ack.png`.

## API distinctions and primary sources

- [WGC window interop](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow) creates a capture item for one HWND. This fixture never targets another process.
- [Microsoft's screen capture guide](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture) describes support checks, user selection, frame pools, content dimensions, and pool recreation on resize. The probe copies only valid content dimensions before PNG encoding.
- [DWM thumbnails](https://learn.microsoft.com/en-us/windows/win32/dwm/thumbnail-ovw) relate source and destination windows for local composition. This probe checks DWM enabled status; it does not claim DWM thumbnails are a transport/readback API.
- [Desktop Duplication](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api) provides desktop/output frames. It was not used: cropping a whole-display capture would not establish single-window isolation or preserve covered window content.
- [PrintWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow) asks the owning app to render and is synchronous. Its successful GDI fixture rendering does not prove WGC, arbitrary GPU-app capture, active-desktop visibility, or low latency.
- [OpenInputDesktop](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-openinputdesktop) has desktop access/window-station requirements. Microsoft notes it can return a handle even in a disconnected session, so it must not substitute for the separate session-state check.
- [GetDpiForWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getdpiforwindow) depends on awareness mode. One 192-DPI observation is not a DPI-transition test.
- [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput) inserts OS input and is subject to UIPI. Capture authority is not input authority. No OS input is derived from received frames.

Validation performed: native `/W4` build without warnings; final readiness exit 3 with valid JSON; received viewer played 90 frames and saved per-frame measurements; first/last canvas visual inspection; reverse command transfer, explicit stale-ack detection, and later visible-ack verification; JavaScript syntax and PowerShell parsing. No product app build, full repository test suite, lab operation, merge, or release was run. Repository Oxlint globs do not cover these `.mjs`, `.ps1`, and `.cpp` prototype files.
