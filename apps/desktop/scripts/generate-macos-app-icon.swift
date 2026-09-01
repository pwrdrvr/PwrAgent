#!/usr/bin/env swift

import AppKit
import Foundation

// PwrAgent's cross-platform master is intentionally unpadded. Legacy macOS
// displays an ICNS canvas literally, so render a separate macOS family using
// Apple's 824/1024 tile and 100px transparent margin. macOS 26 normalizes
// legacy icons automatically; Sequoia and earlier need the margin in the asset.

let scriptsDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let desktopDir = scriptsDir.deletingLastPathComponent()
let buildDir = desktopDir.appendingPathComponent("build", isDirectory: true)
let sourceURL = buildDir.appendingPathComponent("icon.png")
let macOSDockIconURL = buildDir.appendingPathComponent("icon-macos.png")
let icnsURL = buildDir.appendingPathComponent("icon.icns")

guard let source = NSImage(contentsOf: sourceURL) else {
  fatalError("Unable to read \(sourceURL.path)")
}

func renderIcon(size: Int) -> Data {
  guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: size,
    pixelsHigh: size,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ) else { fatalError("Unable to create \(size)x\(size) bitmap") }
  bitmap.size = NSSize(width: size, height: size)

  NSGraphicsContext.saveGraphicsState()
  guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fatalError("Unable to create graphics context")
  }
  NSGraphicsContext.current = context
  context.imageInterpolation = .high

  NSColor.clear.setFill()
  NSRect(x: 0, y: 0, width: size, height: size).fill()
  let canvasScale = CGFloat(size) / 1024
  let inset = 100 * canvasScale
  let tileSize = 824 * canvasScale
  source.draw(
    in: NSRect(x: inset, y: inset, width: tileSize, height: tileSize),
    from: NSRect(origin: .zero, size: source.size),
    operation: .copy,
    fraction: 1
  )
  NSGraphicsContext.restoreGraphicsState()

  guard let data = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Unable to encode \(size)x\(size) PNG")
  }
  return data
}

let sizes: [(Int, String)] = [
  (16, "icon_16x16.png"),
  (32, "icon_16x16@2x.png"),
  (32, "icon_32x32.png"),
  (64, "icon_32x32@2x.png"),
  (128, "icon_128x128.png"),
  (256, "icon_128x128@2x.png"),
  (256, "icon_256x256.png"),
  (512, "icon_256x256@2x.png"),
  (512, "icon_512x512.png"),
  (1024, "icon_512x512@2x.png"),
]

let temporaryRoot = FileManager.default.temporaryDirectory
  .appendingPathComponent("pwragent-app-icon-\(UUID().uuidString)", isDirectory: true)
let iconsetURL = temporaryRoot.appendingPathComponent("icon.iconset", isDirectory: true)
let temporaryIcnsURL = temporaryRoot.appendingPathComponent("icon.icns")
try FileManager.default.createDirectory(at: iconsetURL, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: temporaryRoot) }

for (size, filename) in sizes {
  try renderIcon(size: size).write(
    to: iconsetURL.appendingPathComponent(filename),
    options: .atomic
  )
  print("  \(filename) (\(size)x\(size))")
}

let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconsetURL.path, "-o", temporaryIcnsURL.path]
try iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else {
  fatalError("iconutil failed with status \(iconutil.terminationStatus)")
}

try renderIcon(size: 1024).write(to: macOSDockIconURL, options: .atomic)
try Data(contentsOf: temporaryIcnsURL).write(to: icnsURL, options: .atomic)
print("  icon-macos.png (1024x1024)")
print("  icon.icns")
