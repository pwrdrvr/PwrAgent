#!/usr/bin/env swift

import AppKit
import Foundation

// capture-window.swift
//
// Captures a native macOS screenshot of a specific on-screen window —
// including the OS window chrome (stoplights, title bar, rounded corners,
// and drop shadow) — by CGWindowID. We can't use Playwright's
// `Page.screenshot()` for README-quality shots because it only captures
// the rendered DOM inside the BrowserWindow; everything that makes the
// app look like a real macOS app is outside that.
//
// Usage:
//   capture-window.swift <owner-name-substring> <output-path>
//   capture-window.swift <owner-name-substring> <output-path> --title=<title-substring>
//   capture-window.swift <owner-name-substring> <output-path> --allow-low-dpi
//
// The owner-name substring is matched against `kCGWindowOwnerName`
// case-insensitively. For an Electron-based app this is typically
// "Electron" during dev or the productName from electron-builder for
// signed builds. We pick the first on-screen, normal-layer window that
// matches.
//
// When `--title=<substring>` is provided, the window's title
// (`kCGWindowName`) must also contain that substring (case-insensitive)
// — useful when an app has multiple windows open (e.g. main app + a
// settings/activity window) and you need to disambiguate.
//
// Implementation notes:
//   * `CGWindowListCopyWindowInfo` still works on macOS 15+ — only the
//     image-capture API `CGWindowListCreateImage` was removed. We
//     resolve the CGWindowID with the still-supported lookup, then shell
//     out to `/usr/sbin/screencapture -l <wid>` which Apple keeps
//     updated and routes through ScreenCaptureKit internally.
//   * `screencapture` includes the window shadow by default. Pass `-o`
//     to drop it; we omit `-o` here so the README shots get the polished
//     macOS framing.
//   * `screencapture -l` renders at the backing scale of the display the
//     window is on, with no way to ask for 2x. So the capture lands in a
//     temp file, gets its scale verified, and only then replaces the
//     destination — see the `minimumBackingScale` check below. The
//     verification fails closed: a staged file that cannot be decoded is
//     refused, not waved through. The replace itself goes through
//     `replaceItemAt`, so a failure there cannot leave the destination
//     missing.
//   * Screen Recording permission is required for `screencapture -l`.
//     The first invocation triggers the system prompt; subsequent runs
//     are silent. CI environments will need this granted to whichever
//     terminal/IDE runs the spec.
//
// Exits with:
//   0 — success
//   2 — usage error, or an unrecognized argument
//   3 — no matching window
//   4 — screencapture failed
//   5 — output file not produced, or could not be moved into place
//   6 — capture came out below Retina scale, or could not be decoded to
//       check (see --allow-low-dpi)

let args = CommandLine.arguments

let usage =
  "usage: capture-window.swift <owner-name-substring> <output-path> "
  + "[--title=<title-substring>] [--allow-low-dpi]\n"

guard args.count >= 3 else {
  FileHandle.standardError.write(Data(usage.utf8))
  exit(2)
}

let ownerSubstring = args[1]
let outputPath = args[2]

var titleSubstring: String? = nil
var allowLowResolution = false
for raw in args.dropFirst(3) {
  if raw.hasPrefix("--title=") {
    titleSubstring = String(raw.dropFirst("--title=".count))
  } else if raw == "--allow-low-dpi" {
    allowLowResolution = true
  } else {
    // Reject rather than ignore. The exit-6 message tells the operator to
    // "Pass --allow-low-dpi"; silently dropping a near miss like
    // `--allow-low-dpi=1` sends them round that loop believing they did.
    FileHandle.standardError.write(
      Data("unrecognized argument '\(raw)'\n\(usage)".utf8)
    )
    exit(2)
  }
}

let infoList =
  CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements],
    kCGNullWindowID
  ) as? [[String: Any]] ?? []

func windowMatches(_ info: [String: Any]) -> Bool {
  guard let owner = info[kCGWindowOwnerName as String] as? String,
    owner.localizedCaseInsensitiveContains(ownerSubstring)
  else { return false }
  // Only normal-layer windows; layer 0 is the standard application window.
  // Skip menus, popovers, sheets, drag images.
  guard let layer = info[kCGWindowLayer as String] as? Int, layer == 0 else { return false }
  // Skip windows with zero area (some apps keep hidden helper windows).
  guard let bounds = info[kCGWindowBounds as String] as? [String: CGFloat],
    let width = bounds["Width"], width > 1,
    let height = bounds["Height"], height > 1
  else { return false }
  // Optional title-substring filter to disambiguate when an app has
  // multiple on-screen windows. `kCGWindowName` requires Screen
  // Recording permission to be populated; without it the title comes
  // back nil and the filter is treated as a no-match. The CLI surfaces
  // this distinction in the error message so the caller can grant the
  // permission and retry.
  if let needle = titleSubstring {
    guard let title = info[kCGWindowName as String] as? String,
      title.localizedCaseInsensitiveContains(needle)
    else { return false }
  }
  return true
}

guard let target = infoList.first(where: windowMatches),
  let windowNumber = target[kCGWindowNumber as String] as? CGWindowID
else {
  let candidates = infoList.compactMap { info -> String? in
    guard let owner = info[kCGWindowOwnerName as String] as? String else { return nil }
    let title = info[kCGWindowName as String] as? String ?? ""
    return title.isEmpty ? owner : "\(owner): \(title)"
  }
  .joined(separator: ", ")
  let titleClause = titleSubstring.map { " with title containing '\($0)'" } ?? ""
  FileHandle.standardError.write(
    Data(
      "no on-screen window for owner matching '\(ownerSubstring)'\(titleClause) (on-screen windows: \(candidates))\n"
        .utf8
    )
  )
  exit(3)
}

// Logical (point) width of the window, used below to derive the backing
// scale the capture actually came out at.
let targetBounds = target[kCGWindowBounds as String] as? [String: CGFloat]
let logicalWidth = targetBounds?["Width"] ?? 0

// Capture to a temp file first, verify the backing scale, and only then
// move it into place. `screencapture` writes wherever it is pointed, so
// capturing straight to `outputPath` would clobber a committed Retina
// asset with a 1x one before anything could object — which is exactly
// what happened to all 21 docs-site PNGs on 2026-09-01.
let stagingPath = FileManager.default.temporaryDirectory
  .appendingPathComponent("capture-window-\(UUID().uuidString).png")
  .path

let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
// `-l <wid>`: capture the window with the given CGWindowID.
// `-x`: silence the camera-shutter sound (we run this in tests).
// No `-o`: keep the window shadow.
// `-t png`: be explicit about the format even though .png is default.
process.arguments = [
  "-l", String(windowNumber),
  "-x",
  "-t", "png",
  stagingPath,
]

let stderrPipe = Pipe()
process.standardError = stderrPipe

do {
  try process.run()
} catch {
  FileHandle.standardError.write(Data("failed to launch screencapture: \(error)\n".utf8))
  exit(4)
}
process.waitUntilExit()

if process.terminationStatus != 0 {
  // `screencapture` can fail after creating a partial file. Nothing else
  // reclaims it — every name carries a fresh UUID — and `defer` does not
  // run on `exit()` in a top-level script, so clean up explicitly here.
  try? FileManager.default.removeItem(atPath: stagingPath)
  let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
  FileHandle.standardError.write(
    Data("screencapture exited with status \(process.terminationStatus)\n".utf8)
  )
  if !stderrData.isEmpty {
    FileHandle.standardError.write(stderrData)
  }
  exit(4)
}

guard FileManager.default.fileExists(atPath: stagingPath) else {
  FileHandle.standardError.write(
    Data("screencapture reported success but \(stagingPath) does not exist\n".utf8)
  )
  exit(5)
}

// `screencapture -l` renders at the backing scale of whichever display the
// window happens to sit on. On a 1x display it silently produces a
// half-resolution PNG that looks fine in isolation and only reveals itself
// once it is next to the Retina asset it replaced. Refuse rather than
// degrade the committed screenshots.
//
// This check fails *closed*. A staged file we cannot decode is not a
// reason to proceed — it is the strongest evidence yet that the capture
// went wrong, and proceeding would move it over a good committed PNG.
// (`logicalWidth` needs no guard: `windowMatches` already proved
// `Width > 1` on this same dictionary.)
if !allowLowResolution {
  guard
    let stagedData = FileManager.default.contents(atPath: stagingPath),
    let staged = NSBitmapImageRep(data: stagedData)
  else {
    try? FileManager.default.removeItem(atPath: stagingPath)
    FileHandle.standardError.write(
      Data(
        """
        screencapture produced a file that could not be decoded as an image, so \
        its resolution cannot be verified. \(outputPath) was left untouched.

        """.utf8
      )
    )
    exit(6)
  }

  // Ratio, not exact multiple: the shadow adds ~56pt on each side, so a
  // 1440pt-wide window lands near 1.08 at 1x and near 2.16 at 2x. 1.5
  // separates them with room to spare on either side.
  let minimumBackingScale: CGFloat = 1.5
  let observedScale = CGFloat(staged.pixelsWide) / logicalWidth
  if observedScale < minimumBackingScale {
    try? FileManager.default.removeItem(atPath: stagingPath)
    FileHandle.standardError.write(
      Data(
        """
        refusing to write a low-resolution capture: window is \(Int(logicalWidth))pt wide \
        but the capture is only \(staged.pixelsWide)px (~\(String(format: "%.2f", observedScale))x).
        The window is on a non-Retina display, so screencapture rendered it at 1x. \
        Move the app window to the built-in Retina display (or a 2x external) and re-run. \
        \(outputPath) was left untouched. Pass --allow-low-dpi to override.

        """.utf8
      )
    )
    exit(6)
  }
}

// Verified — now replace the destination, atomically.
//
// `replaceItemAt` is the point of the staging file. The obvious
// alternative — remove the destination, then move — has a window in
// which the committed Retina PNG is already gone: if the move then
// fails (a `PWRAGENT_DOCS_SITE_REPO` checkout on another volume makes
// this a cross-device copy that can hit ENOSPC), the asset is destroyed
// and the replacement discarded. `replaceItemAt` leaves the original in
// place on failure, and works whether or not the destination exists.
do {
  _ = try FileManager.default.replaceItemAt(
    URL(fileURLWithPath: outputPath),
    withItemAt: URL(fileURLWithPath: stagingPath)
  )
} catch {
  try? FileManager.default.removeItem(atPath: stagingPath)
  FileHandle.standardError.write(
    Data("failed to move capture into \(outputPath): \(error)\n".utf8)
  )
  exit(5)
}

let titleSuffix = titleSubstring.map { " title~\($0)" } ?? ""
print("captured window \(windowNumber) (\(ownerSubstring)\(titleSuffix)) -> \(outputPath)")
