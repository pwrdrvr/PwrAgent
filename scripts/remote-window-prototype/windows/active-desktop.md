# Active desktop follow-up, 2026-10-11

After the operator restored the existing interactive session, the guarded owned-window probe completed successfully. This supplements the earlier disconnected-session evidence in [README.md](README.md); it does not change that earlier result.

Read-only readiness checks found session 1 active, the Default input desktop accessible, DWM enabled, WGC supported, no interactive-E2E owner file, and the lab task Ready. No session, ownership, network, enrollment, or lab configuration was changed. The probe created its own target and occluder windows and closed them on exit.

Sanitized raw measurements: [windows-active-desktop.json](benchmarks/windows-active-desktop.json). Arrival times are milliseconds from the start of each stage, measured locally. The single saved-frame readback/PNG time includes CPU readback and encoding; it is not capture latency or a percentile.

| WGC stage | Duration (ms) | Frames | Saved pixels | Pool recreations | Saved PNG bytes | Readback + PNG (ms) |
|---|---:|---:|---|---:|---:|---:|
| Visible | 2209.50 | 47 | 698 × 409 | 0 | 14699 | 50.64 |
| Obscured by own fixture | 2224.97 | 44 | 698 × 409 | 0 | 12733 | 13.34 |
| Resized | 2205.64 | 47 | 938 × 529 | 1 | 17582 | 27.52 |
| Minimized | 2205.89 | 2 | None | 0 | 0 | — |
| Restored | 2215.35 | 48 | 938 × 529 | 2 | 17619 | 22.43 |

The obscured WGC frame was visually reviewed: it contains only the synthetic target, including its “No private data” label, with no occluder or unrelated desktop pixels. [Reviewed owned-window PNG](artifacts/wgc-owned-obscured.png).

The two minimized frames arrived within the first 20 ms of the stage. No frame was saved after the 300 ms settling threshold. This is transition delivery, not evidence of sustained minimized capture. Resize changed the captured dimensions and recreated the frame pool. DPI stayed at 192 throughout; cross-monitor DPI changes remain untested.

WGC supplied the frames above. PrintWindow was measured independently and succeeded for visible, obscured, resized, and restored stages; the minimized client was empty. DWM was only queried for enabled status. Desktop Duplication was not used. See the Microsoft primary-source API links in [README.md](README.md#api-distinctions-and-primary-sources).

Input was tested separately, after closing the capture session. The own fixture was foreground; SendInput inserted two key events and the fixture received one F8 keydown. A separate PostMessage click was received once. The 208.557 ms measurement includes the deliberate observation wait and is not injection latency. This proves local owned-fixture input only. It does not prove remote OS input, derive input from received pixels, or expand the live protocol beyond its application-helper commands.

Reproduction uses the existing [run.ps1](run.ps1) readiness guards and [window-probe.cpp](window-probe.cpp), from this isolated worktree. Exit status was 0. The committed JSON preserves the per-frame arrival samples and independent fallback measurements. No capture permission prompt was bypassed.

These are Windows-local capture measurements. Continuous Mac-to-Windows H264 reception remains a separate pending experiment. Its input-to-canvas measurement must use a browser-local monotonic clock and a visible fixture beacon; source and receiver wall clocks must not be subtracted to claim latency or photons.
