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
//   * Screen Recording permission is required for `screencapture -l`.
//     The first invocation triggers the system prompt; subsequent runs
//     are silent. CI environments will need this granted to whichever
//     terminal/IDE runs the spec.
//
// Exits with:
//   0 — success
//   2 — usage error
//   3 — no matching window
//   4 — screencapture failed
//   5 — output file not produced

let args = CommandLine.arguments

guard args.count >= 3 else {
  FileHandle.standardError.write(
    Data(
      "usage: capture-window.swift <owner-name-substring> <output-path> [--title=<title-substring>]\n"
        .utf8
    )
  )
  exit(2)
}

let ownerSubstring = args[1]
let outputPath = args[2]

var titleSubstring: String? = nil
for raw in args.dropFirst(3) {
  if raw.hasPrefix("--title=") {
    titleSubstring = String(raw.dropFirst("--title=".count))
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
  outputPath,
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
  let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
  FileHandle.standardError.write(
    Data("screencapture exited with status \(process.terminationStatus)\n".utf8)
  )
  if !stderrData.isEmpty {
    FileHandle.standardError.write(stderrData)
  }
  exit(4)
}

guard FileManager.default.fileExists(atPath: outputPath) else {
  FileHandle.standardError.write(
    Data("screencapture reported success but \(outputPath) does not exist\n".utf8)
  )
  exit(5)
}

let titleSuffix = titleSubstring.map { " title~\($0)" } ?? ""
print("captured window \(windowNumber) (\(ownerSubstring)\(titleSuffix)) -> \(outputPath)")
