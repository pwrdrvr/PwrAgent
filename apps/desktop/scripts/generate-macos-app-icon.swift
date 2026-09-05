#!/usr/bin/env swift

import AppKit
import Foundation

// Derives the macOS icon inputs from build/icon.png — the authored 512px
// full-bleed master with the tile gradient, a 2px rim highlight, and the
// four-bar mark baked together. That PNG stays the artwork of record: it is
// also the Windows/Linux source and ships as the pwragent-app-icon.png
// resource. Nothing here changes it.
//
//   build/icon.icon/           Icon Composer package. The tile gradient is the
//     icon.json                package `fill`; Assets/glyph.png is the mark
//     Assets/glyph.png         ALONE on transparency at 1024px. electron-builder
//                              compiles it with Xcode 26's actool into
//                              Assets.car + CFBundleIconName (what macOS 26
//                              draws) and derives the legacy icon.icns
//                              (macOS 15 and earlier) from the same source.
//   build/icon-macos.png       The master on Apple's 824-in-1024 legacy tile:
//                              the development Dock icon, which
//                              app.dock.setIcon() paints literally.
//
// No .icns is written. macOS 26 auto-normalizes a legacy .icns it is handed
// without a .icon, and how it does so changed between 26.6.1 and 26.6.2 (a
// light plate around the padded tile). With the .icon present the .icns is
// never opened there. See AGENTS.md "macOS app icon".
//
// Lifting the mark off the tile: the mark is one accent color at four
// opacities composited over a vertical gradient, so for every interior pixel
//
//   alpha = (R - backgroundR) / (accentR - backgroundR)
//
// with the background read from the same row of the master at a column left
// of the mark. Pixels that are only gradient resolve to alpha 0 exactly; the
// rim highlight belongs to the tile and stays outside the extraction window. The layer is an
// exact 2x of the recovered pixels (no resampling), so nothing is invented.

let scriptsDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let desktopDir = scriptsDir.deletingLastPathComponent()
let buildDir = desktopDir.appendingPathComponent("build", isDirectory: true)
let sourceURL = buildDir.appendingPathComponent("icon.png")
let macOSDockIconURL = buildDir.appendingPathComponent("icon-macos.png")
let packageURL = buildDir.appendingPathComponent("icon.icon", isDirectory: true)
let assetsURL = packageURL.appendingPathComponent("Assets", isDirectory: true)
let glyphURL = assetsURL.appendingPathComponent("glyph.png")
let manifestURL = packageURL.appendingPathComponent("icon.json")

/// #e8743a, the app-icon orange. The mark is this color at 100/65/40/25%.
let accent: (r: UInt8, g: UInt8, b: UInt8) = (232, 116, 58)
/// The master paints a 2px highlight just inside the tile edge.
let rimInset = 2
/// A column that is inside the tile and left of the mark on every row.
let backgroundSampleX = 40
/// Icon Composer's canvas.
let packageSize = 1024

guard let sourceData = try? Data(contentsOf: sourceURL),
      let source = NSBitmapImageRep(data: sourceData)
else {
  fatalError("Unable to read \(sourceURL.path)")
}
let sourceSize = source.pixelsWide
precondition(source.pixelsHigh == sourceSize, "icon.png must be square")
precondition(packageSize % sourceSize == 0, "icon.png must divide the \(packageSize)px package canvas")
let scale = packageSize / sourceSize
/// The mark sits well inside the tile. The rim highlight follows the tile's
/// rounded corners, so it is kept out by a window, not a straight inset.
let markInset = sourceSize / 8

func channels(_ x: Int, _ y: Int) -> (r: Double, g: Double, b: Double, a: Double) {
  guard let color = source.colorAt(x: x, y: y) else { fatalError("No pixel at \(x),\(y)") }
  return (color.redComponent * 255, color.greenComponent * 255, color.blueComponent * 255, color.alphaComponent)
}

func gradientStop(_ c: (r: Double, g: Double, b: Double, a: Double)) -> String {
  String(format: "srgb:%.5f,%.5f,%.5f,1.00000", c.r / 255, c.g / 255, c.b / 255)
}

// MARK: - build/icon.icon/Assets/glyph.png

// Straight (non-premultiplied) alpha so the accent color survives the low
// opacities byte-exact; a premultiplied 8-bit rep would round it.
guard let glyph = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: packageSize,
  pixelsHigh: packageSize,
  bitsPerSample: 8,
  samplesPerPixel: 4,
  hasAlpha: true,
  isPlanar: false,
  colorSpaceName: .deviceRGB,
  bitmapFormat: .alphaNonpremultiplied,
  bytesPerRow: packageSize * 4,
  bitsPerPixel: 32
), let glyphBytes = glyph.bitmapData else {
  fatalError("Unable to create \(packageSize)x\(packageSize) bitmap")
}
memset(glyphBytes, 0, packageSize * 4 * packageSize)

var markMinX = sourceSize, markMinY = sourceSize, markMaxX = -1, markMaxY = -1
for y in markInset..<(sourceSize - markInset) {
  let background = channels(backgroundSampleX, y)
  precondition(background.a == 1, "background sample at \(backgroundSampleX),\(y) is outside the tile")
  let range = Double(accent.r) - background.r
  precondition(range > 64, "accent and background are too close at row \(y) to separate the mark")
  for x in markInset..<(sourceSize - markInset) {
    let pixel = channels(x, y)
    let alpha = min(max((pixel.r - background.r) / range, 0), 1)
    let alpha8 = UInt8((alpha * 255).rounded())
    if alpha8 == 0 { continue }
    markMinX = min(markMinX, x); markMaxX = max(markMaxX, x)
    markMinY = min(markMinY, y); markMaxY = max(markMaxY, y)
    for dy in 0..<scale {
      for dx in 0..<scale {
        let offset = ((y * scale + dy) * packageSize + (x * scale + dx)) * 4
        glyphBytes[offset] = accent.r
        glyphBytes[offset + 1] = accent.g
        glyphBytes[offset + 2] = accent.b
        glyphBytes[offset + 3] = alpha8
      }
    }
  }
}
precondition(markMaxX >= 0, "no mark found in \(sourceURL.path)")
precondition(
  markMinX > markInset && markMinY > markInset
    && markMaxX < sourceSize - markInset - 1 && markMaxY < sourceSize - markInset - 1,
  "the mark touches the extraction window at (\(markMinX),\(markMinY))-(\(markMaxX),\(markMaxY)): it was clipped, or the rim leaked in"
)

try FileManager.default.createDirectory(at: assetsURL, withIntermediateDirectories: true)
guard let glyphPNG = glyph.representation(using: .png, properties: [:]) else {
  fatalError("Unable to encode glyph.png")
}
try glyphPNG.write(to: glyphURL, options: .atomic)
print("  icon.icon/Assets/glyph.png (\(packageSize)x\(packageSize); mark at \(markMinX * scale),\(markMinY * scale) \((markMaxX - markMinX + 1) * scale)x\((markMaxY - markMinY + 1) * scale))")

// MARK: - build/icon.icon/icon.json

// The tile gradient, read off the master at its center column just inside
// the rim (the mark never touches the top or bottom rows).
let fillTop = channels(sourceSize / 2, rimInset)
let fillBottom = channels(sourceSize / 2, sourceSize - 1 - rimInset)
precondition(fillTop.a == 1 && fillBottom.a == 1, "fill samples must be inside the tile")
let manifest = """
{
  "fill" : {
    "linear-gradient" : [
      "\(gradientStop(fillTop))",
      "\(gradientStop(fillBottom))"
    ]
  },
  "groups" : [
    {
      "name" : "Mark",
      "layers" : [
        {
          "name" : "glyph",
          "image-name" : "glyph.png",
          "fill" : "automatic",
          "glass" : false,
          "hidden" : false,
          "blend-mode" : "normal"
        }
      ],
      "lighting" : "individual",
      "shadow" : {
        "kind" : "neutral",
        "opacity" : 0.5
      },
      "translucency" : {
        "enabled" : false,
        "value" : 0.5
      }
    }
  ],
  "supported-platforms" : {
    "circles" : [
      "watchOS"
    ],
    "squares" : "shared"
  }
}

"""
try manifest.data(using: .utf8)!.write(to: manifestURL, options: .atomic)
print("  icon.icon/icon.json (fill \(gradientStop(fillTop)) -> \(gradientStop(fillBottom)))")

// MARK: - build/icon-macos.png

// The development Dock icon: app.dock.setIcon() paints a PNG literally, and
// macOS 15 draws an unpadded tile edge-to-edge, so this one carries Apple's
// legacy 824/1024 tile with the 100px transparent margin.
guard let sourceImage = NSImage(contentsOf: sourceURL) else {
  fatalError("Unable to read \(sourceURL.path)")
}
guard let dockIcon = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: packageSize,
  pixelsHigh: packageSize,
  bitsPerSample: 8,
  samplesPerPixel: 4,
  hasAlpha: true,
  isPlanar: false,
  colorSpaceName: .deviceRGB,
  bytesPerRow: 0,
  bitsPerPixel: 0
) else { fatalError("Unable to create \(packageSize)x\(packageSize) bitmap") }
dockIcon.size = NSSize(width: packageSize, height: packageSize)

NSGraphicsContext.saveGraphicsState()
guard let context = NSGraphicsContext(bitmapImageRep: dockIcon) else {
  fatalError("Unable to create graphics context")
}
NSGraphicsContext.current = context
context.imageInterpolation = .high
NSColor.clear.setFill()
NSRect(x: 0, y: 0, width: packageSize, height: packageSize).fill()
sourceImage.draw(
  in: NSRect(x: 100, y: 100, width: 824, height: 824),
  from: NSRect(origin: .zero, size: sourceImage.size),
  operation: .copy,
  fraction: 1
)
NSGraphicsContext.restoreGraphicsState()

guard let dockIconPNG = dockIcon.representation(using: .png, properties: [:]) else {
  fatalError("Unable to encode icon-macos.png")
}
try dockIconPNG.write(to: macOSDockIconURL, options: .atomic)
print("  icon-macos.png (\(packageSize)x\(packageSize))")
