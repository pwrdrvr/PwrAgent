# Push WebP measurements

Measured 2026-10-22T21:33:59.460Z. Single M2 Max, 32 GiB RAM, macOS 27.0.1; two isolated headless Chrome 152 instances; libwebp 1.6.0. Capture 800×548, viewer DPR 1. No physical network impairment.

Faults below are seeded drops and delay of **complete WebRTC application messages after delivery**, with bounded random reordering. They do not emulate SCTP congestion or network packet loss. Selected ICE transport was UDP in every run.

| Message loss / delay | Phase | Duration ms | Media bytes | Previews drawn | Tiles drawn | Decode+draw p95 ms |
|---|---|---:|---:|---:|---:|---:|
| 0% / 0–0 ms | idle | 2004 | 0 | 0 | 0 | — |
| 0% / 0–0 ms | typing | 1040 | 219,248 | 9 | 57 | 1.40 |
| 0% / 0–0 ms | typing-settle | 448 | 115,434 | 0 | 60 | 1.20 |
| 0% / 0–0 ms | scroll | 1044 | 195,780 | 19 | 9 | 1.70 |
| 0% / 0–0 ms | scroll-settle | 122 | 27,782 | 0 | 10 | 0.90 |
| 0% / 0–0 ms | motion | 3002 | 795,028 | 85 | 11 | 1.70 |
| 0% / 0–0 ms | motion-settle | 218 | 79,648 | 2 | 27 | 1.10 |
| 0% / 0–0 ms | interrupted-refinement | 2431 | 611,786 | 44 | 87 | 1.60 |
| 0% / 0–0 ms | final-settle | 0 | 0 | 0 | 0 | — |
| 3% / 50–70 ms | idle | 2002 | 295,276 | 0 | 117 | 1.60 |
| 3% / 50–70 ms | typing | 1040 | 231,950 | 7 | 55 | 1.70 |
| 3% / 50–70 ms | typing-settle | 581 | 132,584 | 1 | 62 | 1.40 |
| 3% / 50–70 ms | scroll | 1059 | 197,938 | 12 | 0 | 3.20 |
| 3% / 50–70 ms | scroll-settle | 199 | 55,036 | 1 | 10 | 2.20 |
| 3% / 50–70 ms | motion | 3004 | 812,550 | 64 | 2 | 2.00 |
| 3% / 50–70 ms | motion-settle | 449 | 117,932 | 2 | 26 | 2.00 |
| 3% / 50–70 ms | interrupted-refinement | 2439 | 638,090 | 32 | 34 | 2.30 |
| 3% / 50–70 ms | final-settle | 99 | 27,236 | 0 | 14 | 1.90 |
| 10% / 100–130 ms | idle | 2000 | 409,790 | 0 | 117 | 1.50 |
| 10% / 100–130 ms | typing | 1040 | 262,018 | 3 | 47 | 1.00 |
| 10% / 100–130 ms | typing-settle | 1796 | 638,054 | 0 | 173 | 1.40 |
| 10% / 100–130 ms | scroll | 1055 | 181,396 | 5 | 0 | 2.60 |
| 10% / 100–130 ms | scroll-settle | 920 | 480,952 | 0 | 117 | 1.30 |
| 10% / 100–130 ms | motion | 3005 | 809,922 | 34 | 2 | 2.10 |
| 10% / 100–130 ms | motion-settle | 350 | 124,738 | 3 | 26 | 1.60 |
| 10% / 100–130 ms | interrupted-refinement | 2433 | 669,774 | 14 | 18 | 2.20 |
| 10% / 100–130 ms | final-settle | 200 | 38,308 | 0 | 10 | 1.40 |

Media bytes include the 28-byte experimental fragment header and WebP/preview-version payload. They exclude SCTP/DTLS/UDP/IP, reliable feedback, local bridges, and Federation signaling. Counts are received before injected loss. Decode+draw starts immediately before createImageBitmap and ends after synchronous canvas drawing; no rAF, display scanout, or photon claim. A preview is one coarse image with at least one region drawn; a tile is one independent refinement, not a whole frame.

| Loss | Motion previews/s | Motion media bytes/s | Stop-to-full-refinement ms | Opaque pixel checks | Cancelled preview/refinement work (cumulative) |
|---|---:|---:|---:|---:|---:|
| 0% | 28.32 | 264859 | 218 | 117/117 | 0/60 |
| 3% | 21.31 | 270525 | 449 | 117/117 | 0/126 |
| 10% | 11.32 | 269543 | 350 | 117/117 | 0/200 |

Settling begins after the local synthetic fixture acknowledges stopping motion. It ends when that revision is visible in actual canvas beacon pixels and every currently announced tile has its lossless version. This is a browser-monotonic fixture-to-canvas completion measurement, not remote OS input or input-to-photon latency. Pixel checks compare independent native pre-encode and browser post-draw FNV-1a checksums of opaque RGB pixels, plus tile versions; alpha-edge rounding and display color management are excluded.

- Native previewEncodeMs: n=486, p50 3.082 ms, p95 3.895 ms.
- Native tileEncodeMs: n=1655, p50 0.207 ms, p95 0.495 ms.
- Native whole-run resources: 47.10 s wall, 4.366 s user CPU, 0.661 s system CPU, 129.59 MiB peak RSS.
- Node helper whole-run resources: 49.60 s wall, 1.043 s CPU, 112.94 MiB peak RSS.
- Observed receive-assembly peak: 98,300 bytes; queued encoded-image peak awaiting decode: 40,858 bytes. Neither includes browser internals.
- Nominal idle intervals: 0%: 0 media bytes / 0 feedback bytes; 3%: 295276 media bytes / 2080 feedback bytes; 10%: 409790 media bytes / 3726 feedback bytes. ICE/DTLS keepalive traffic is excluded.
- The baseline idle interval was unchanged and sent zero application bytes. The later nominal idle intervals received fresh native versions covering all 117 tiles despite no fixture command. Their traffic is retained above; they are NOT evidence of zero-byte idle. The trigger of these whole-window invalidations was not isolated (window activation/capture-indicator changes are hypotheses). Investigate before production; do not attribute the bytes to injected loss alone.
- Logical Stop/Start: new epoch True; 117/117 opaque pixel checks match. No physical link outage/reconnect was tested.
- Native/helper resources include setup, idle, screenshots, and logical reconnect. Chromium CPU/RSS, GPU utilization, energy, physical wire bytes, cross-host latency, and 2× capture were not measured in this experiment.

These are single sequential trials with accumulating fixture state, not repeated statistical comparisons. In particular, the stop-to-refinement values are individual observations, not latency percentiles.

Raw generated JSON stays in the ignored run directory. Use the [reproduction instructions](../../scripts/remote-window-prototype/datagrams/README.md); this report contains no frame-by-frame dump. SHA-256 provenance:

- `benchmark.json` (131,903 bytes): `34174d651eee74f73b5eb27bf039ec829b4a678d9053127affbeff420a10ab26`
- `result.json` (165,504 bytes): `c61ab9f9dbbfac2aa3136a423f922cbb8256c3b5dcbf2b17695549d700a3f144`
- `logical-reconnect.json` (77 bytes): `cee30e04e2a55088b8fa2971ebc1f0055f280cec88c1220f5ef37197d08fec08`
- `loss-0.1-canvas.png` (434,576 bytes): `bf90aea322d4c35eb15ce0bdba62062a667cd71c725740380c1a65b11ee5a872`
