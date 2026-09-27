# Clipboard paste blocking boundaries

This contributor audit covers PwrAgent at `5b7a5b289` and the September 27,
2026 macOS incident. It identifies where to collect evidence before changing
paste behavior. It does not establish the cause of that incident or implement
native clipboard hang containment.

## Incident evidence

The operator reported an image paste into PwrAgent followed by Claude, both
applications hanging, and the desktop/remote session appearing frozen while
SSH remained usable. The image did arrive. Restarting the desktop user's
`pboard` immediately restored operation.

The separate M4 diagnostics investigation supplied these observations; this
checkout did not reproduce the incident or inspect the remote desktop:

| Observation | Limit of the evidence |
| --- | --- |
| macOS 26.6.2 (25G83), PwrSnap 1.1.7, PwrAgent 1.1.1 / Electron 41.10.7, Claude 2.9939.2 / Electron 44.4.3, Splashtop 3.8.6.0 | Two Electron majors being affected is consistent with a shared OS clipboard problem, but does not identify its origin. |
| A 2880 × 1920 source-reused PNG was 516,524 bytes; a later composed PNG was 579,354 bytes wide 2880 pixels. | Neither compressed size nor pixel count establishes an overload or malformed-image cause. |
| Replacement `pboard` started at 11:30:51 EDT. Two named-image helper failures were logged at .552 and .673, with Electron fallback successes at .672 and .766. A later helper completed at .800. | These timestamps are completion observations, not the times the stalled operations started. |
| Unified logs show three helpers connecting at 11:06:57.930755, 11:26:18.306119, and 11:26:40.947061, then reconnecting at the reset and disappearing shortly afterward. | Helpers had remained alive for approximately 23m54s, 4m33s, and 4m11s after those connections. Original blocked stacks are unavailable; failed app log messages cannot yet be paired with helper PIDs or exit codes. |
| Launchd logs show Splashtop inactive/spawn cycles at roughly 42-second intervals by 10:52:38, before the 11:06 copy, through 11:30:35; the last process remained after recovery. Earlier logs enabled clipboard sync in both directions; a later setting update omitted its value. | This is consistent with automatic supervision/relaunch, not proof of a user restart or of Splashtop causing the blockage. Incident-time and current active-session clipboard sync settings are unproven. The earlier 09:27 crash was in an audio callback, not clipboard code. |
| Claude logged its main process blocked for 170,358 ms at 11:30:51, heuristically labeled sleep. | This is not a stack-based diagnosis. |
| A controlled synthetic 2880 × 1920 PNG probe on M4 completed: shipped helper 33 ms, native PNG read 12 ms, native TIFF read 49 ms / 16.6 MB; no reset. | Dimensions and one normal helper/reader round trip did not reproduce the incident. This does not cover the original multi-app/clipboard-sync scenario. |
| A second watchdog-protected probe using the incident RGBA PNG (516,524 bytes) completed: installed helper 13 ms, native PNG read 10 ms, native TIFF read 36 ms / 22,123,206 bytes. Neither probe required a `pboard` reset or app restart. | The incident image also passed this isolated round trip. No blocked stacks were collected because neither probe stalled. The clipboard now contains test state, not the original evidence. |

The producer investigation reports that PwrSnap's named-image writer used an
unbounded `execFile`. Its containment change adds a 10-second timeout with
`SIGKILL`, propagates a typed timeout through the setup wrapper, and skips both
the synchronous Electron fallback and the changed-event read cascade on timeout.
That thread reports 7,141 unit tests, lint and build passing. Independent fresh
AppKit consumer E2E remains pending lab stale-lock recovery; those checks were
not run from this checkout.

The producer reports unchanged production formats: eager PNG, file URL and
clip metadata, with no lazy provider or named-to-general pasteboard transfer.
The investigated writer source matches v1.1.7. The timeout contains the
producer's helper wait; it does not fix Chromium's consumer paste path or prove
the original root cause. Remote evidence is retained by the diagnostics thread
in its `.local/clipboard-incident-20260927` directory, outside this checkout.
The completed private report and its 62 hashed artifacts must not be published
unredacted. The observations support shared pasteboard blockage; a strict
deadlock, its owner, conversion failure, or a clipboard-sync trigger remains
unproven.

## PwrAgent paths

| Stage | Ownership and blocking boundary |
| --- | --- |
| Native paste dispatch and clipboard format discovery | Chromium/AppKit can access the clipboard before the React handler runs. `preventDefault()` in that handler cannot undo an earlier native wait. |
| [`Composer.handlePaste`](../apps/desktop/src/renderer/src/features/composer/Composer.tsx) | Reads `text/plain` synchronously for thread references, then extracts image and non-image files. These DOM calls can cross into Chromium clipboard IPC. |
| [`CompactComposer.onPaste`](../apps/desktop/src/renderer/src/features/composer/CompactComposer.tsx) | Extracts files without the initial thread-reference text read. It shares the image intake helpers with the full composer. |
| [`composer-image-files.ts`](../apps/desktop/src/renderer/src/features/composer/composer-image-files.ts) | Both file classifiers enumerate items and call `getAsFile()`. Image fallback enumeration uses `dataTransfer.files`. These are native-facing calls, not just iteration over an already detached JavaScript payload. |
| [`ComposerTiptapInput`](../apps/desktop/src/renderer/src/features/composer/ComposerTiptapInput.tsx) | Calls the parent paste handler first; if prevented, it skips rich-text handling. Otherwise, text/HTML reads and editor parsing may follow. |
| [`normalizeImageFile`](../apps/desktop/src/renderer/src/lib/image-normalization.ts) | After acquiring a `File`, waits for `createImageBitmap` / image-element decode, canvas encoding, and FileReader. Canvas drawing, alpha scanning, and data-URL parsing also contain synchronous renderer work. GIFs instead use FileReader directly. |
| Attachment publication | Both composers use `Promise.all`: a rejected file prevents publishing that batch. A pending file keeps that batch pending; compact composer disables sending while normalizing. This is distinct from a frozen OS or blocked native paste call. |
| [`image-normalization` IPC](../apps/desktop/src/main/ipc/image-normalization.ts) | HEIC/HEIF decode fallback synchronously calls Electron `nativeImage.createFromBuffer` and `toPNG` in main, then can invoke asynchronous `sips` without a deadline. It does not read the clipboard and is not used for the incident PNG. Moving this conversion into a bounded helper would isolate that separate risk, not this paste wait. |
| [`clipboard` IPC](../apps/desktop/src/main/ipc/clipboard.ts) and [`window` context menu](../apps/desktop/src/main/window.ts) | PwrAgent's direct Electron clipboard calls write text/rich text synchronously in main. There is no PwrAgent clipboard-read IPC to move to a helper. An `async` IPC handler does not make its native write interruptible. |

The intake uses in-memory files after acquisition. Sending images later
materializes them through [`image-input-files.ts`](../apps/desktop/src/main/app-server/image-input-files.ts);
this is a separate path from OS clipboard acquisition.

## Exact Chromium boundary

The lockfile resolves Electron 41.10.7. Its
[DEPS](https://github.com/electron/electron/blob/v41.10.7/DEPS)
selects Chromium 146.0.7680.216. The following links pin that version rather
than current Chromium main:

1. [`DataObjectItem::GetAsFile`](https://github.com/chromium/chromium/blob/146.0.7680.216/third_party/blink/renderer/core/clipboard/data_object_item.cc)
   reads clipboard PNG through `SystemClipboard::ReadPng`. String reads also
   dispatch through the system clipboard.
2. [`SystemClipboard::ReadPng`](https://github.com/chromium/chromium/blob/146.0.7680.216/third_party/blink/renderer/core/clipboard/system_clipboard.cc)
   uses a synchronous Mojo result unless a snapshot already contains the PNG.
   Repeated `getAsFile()` calls therefore do not necessarily mean repeated
   OS reads; snapshot caching must be considered before claiming that.
3. [`ClipboardHost` interface](https://github.com/chromium/chromium/blob/146.0.7680.216/third_party/blink/public/mojom/clipboard/clipboard.mojom)
   marks PNG, text, HTML, file and available-type reads synchronous.
4. Browser-side [`ClipboardHostImpl::ReadPng`](https://github.com/chromium/chromium/blob/146.0.7680.216/content/browser/renderer_host/clipboard_host_impl.cc)
   delegates to the platform clipboard implementation.
5. [`ClipboardMac::ReadPngInternal`](https://github.com/chromium/chromium/blob/146.0.7680.216/ui/base/clipboard/clipboard_mac.mm)
   obtains PNG bytes with `NSPasteboard dataForType:` on the calling thread.
   Only later fallback image encoding is posted to the thread pool. A callback
   signature does not isolate the preceding pasteboard read.

A renderer timer cannot fire while its synchronous native call is waiting.
Even an independently scheduled timeout cannot cancel Chromium's pending
native read. `Promise.race`, `try/catch`, delaying `getAsFile()`, or moving
normalization to a worker would not interrupt this boundary. Delaying access
also risks losing access to the event's clipboard data.

An app-owned helper could isolate an explicit clipboard operation that it
owns. Replacing paste with such a helper would additionally need to avoid
Chromium/AppKit's native paste dispatch and format discovery, preserve rich
text and files, and prove browser/main responsiveness under a controlled
stall. Merely wrapping the current handler or switching to the asynchronous
Clipboard API does not establish that isolation.

No production workaround is justified by this audit. It does not reset
`pboard`, clear attachments, or impose a timeout that discards a late image.

## Safe local verification

The image-normalization tests inject a deferred decoder into the real
normalization pipeline. An event-loop timer executes while decoding is
pending, and completing the decoder still returns the image and releases the
decoded resource. A separate injected encoder failure verifies rejection and
resource release. Existing tests cover unreadable input and HEIC fallback.

These tests use synthetic bytes and injected image operations in isolated
Vitest workers. They never access the system clipboard. They verify the
app-owned async pipeline; they do not simulate `pboard` or prove native UI
responsiveness. No consumer hang was reproduced locally.

```sh
pnpm test apps/desktop/src/renderer/src/lib/__tests__/image-normalization.test.ts apps/desktop/src/renderer/src/features/composer/__tests__/composer-image-files.test.ts
```

## Evidence needed for an upstream report

The remote diagnostics owner should capture evidence before recovering a
controlled stall. Avoid a second investigator controlling that desktop.

- Record exact app, Electron, Chromium and macOS build versions; the producer
  operation; PNG dimensions/byte count/hash; and clipboard-sync settings at
  reproduction time. Use a synthetic image suitable for sharing.
- For the next discriminating test, establish a known active remote session
  and document both endpoints' clipboard sync on/off settings. Use synthetic
  content and draft-only app pastes. Allocate a fresh watchdog namespace and
  completion markers for each run; the earlier reproduction artifacts are
  one-shot and must not be reused to infer a new run's completion.
- From the still-responsive SSH session, sample the Electron browser/main
  process, affected renderer, `pboard`, and producer helper concurrently or
  within the same short time window. For each known PID, macOS
  `sample <pid> 5 -file <output>` collects a bounded sample. Record PID start
  times and wall-clock timestamps to correlate helper logs with processes.
- Determine whether main is waiting in `NSPasteboard`/pasteboard IPC, the
  renderer is waiting in synchronous Mojo, or PwrAgent is busy in decode,
  canvas, or parsing. Preserve complete helper errors and exit codes.
- Compare a minimal Electron editable element with PwrAgent under the same
  controlled input. Instrument entry/exit around native paste dispatch,
  handler entry, text read, file acquisition and normalization. Absence of a
  handler-entry marker distinguishes pre-handler work from intake work.
- Keep recovery external to the process being tested. Producer helper
  timeout tests should first use a disposable stub process; any real OS
  clipboard-stall reproduction and recovery belongs to the diagnostics
  owner's separately controlled experiment.

Submit original and controlled stacks with the synthetic reproduction and
the pinned source chain above. Without the original stacks, identify any new
reproduction as a separate observation, not proof of the original blocked
call. Route to Electron/Chromium if browser clipboard dispatch is blocked;
include an Apple report if native pasteboard IPC remains stuck. No upstream
report has been submitted by this audit.
