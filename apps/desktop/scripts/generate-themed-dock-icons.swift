#!/usr/bin/env swift

import AppKit
import Foundation

// Derives the themed Dock icons from build/icon-macos.png, the padded
// development Dock icon generate-macos-app-icon.swift writes. A running
// instance whose dark theme is not Tangerine shows its theme's icon
// (src/main/themed-dock-icon.ts), so two profiles in two themes are told
// apart in the Dock.
//
//   build/dock-icons/<theme>.png   1024px, Apple's 824-in-1024 legacy tile,
//                                  painted literally by app.dock.setIcon().
//
// The tile keeps the shipped icon's exact outline: its alpha is the mask,
// filled with the theme's canvas gradient. The mark is drawn from the same
// geometry as the shipped glyph (logo-pwragnt.svg's four bars) in the
// theme's accent. The colors are each palette's own, not the contrast-tuned
// UI tokens: an icon has no text to clear AA against.

let scriptsDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let desktopDir = scriptsDir.deletingLastPathComponent()
let buildDir = desktopDir.appendingPathComponent("build", isDirectory: true)
let tileURL = buildDir.appendingPathComponent("icon-macos.png")
let outputDir = buildDir.appendingPathComponent("dock-icons", isDirectory: true)

typealias RGB = (r: Double, g: Double, b: Double)

struct ThemedIcon {
  let theme: String
  let tileTop: RGB
  let tileBottom: RGB
  let accent: RGB
}

/// One per dark theme except Tangerine, which keeps the app's own icon.
let icons = [
  // Catppuccin Mocha base -> crust, peach.
  ThemedIcon(theme: "catppuccin-mocha", tileTop: (30, 30, 46), tileBottom: (17, 17, 27), accent: (250, 179, 135)),
  // Solarized base02 -> base03, yellow.
  ThemedIcon(theme: "solarized-dark", tileTop: (7, 54, 66), tileBottom: (0, 43, 54), accent: (181, 137, 0)),
  // Gray's raised surface -> its button ink, its accent.
  ThemedIcon(theme: "gray-dark", tileTop: (50, 50, 54), tileBottom: (28, 28, 30), accent: (255, 169, 90)),
  // Blue's raised surface -> its sidebar, its accent.
  ThemedIcon(theme: "blue-dark", tileTop: (22, 33, 51), tileBottom: (11, 18, 29), accent: (91, 170, 255)),
  // Matrix's raised surface -> its sidebar, its phosphor code green.
  ThemedIcon(theme: "matrix-dark", tileTop: (12, 22, 14), tileBottom: (3, 7, 4), accent: (0, 255, 65)),
]

/// The mark: the `<rect>`s of logo-pwragnt.svg, in its 128-unit viewBox,
/// top-down like SVG. Keep in step with generate-macos-app-icon.swift.
let markViewBox = 128.0
let markCornerRadius = 2.0
let markBars: [(x: Double, y: Double, width: Double, height: Double, opacity: Double)] = [
  (28, 32, 60, 10, 1.00),
  (28, 50, 72, 10, 0.65),
  (28, 68, 44, 10, 0.40),
  (28, 86, 56, 10, 0.25),
]
/// The tile's place on the 1024 canvas, as icon-macos.png pads it.
let canvasSize = 1024
let tileOrigin = 100.0
let tileSize = 824.0

guard let tileData = try? Data(contentsOf: tileURL),
      let tileRep = NSBitmapImageRep(data: tileData),
      tileRep.pixelsWide == canvasSize,
      tileRep.pixelsHigh == canvasSize
else {
  fatalError("Unable to read a \(canvasSize)px \(tileURL.path); run generate:macos-app-icon first")
}
let tileImage = NSImage(size: NSSize(width: canvasSize, height: canvasSize))
tileImage.addRepresentation(tileRep)

func color(_ c: RGB, alpha: Double = 1) -> NSColor {
  NSColor(deviceRed: c.r / 255, green: c.g / 255, blue: c.b / 255, alpha: alpha)
}

try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
for icon in icons {
  guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: canvasSize,
    pixelsHigh: canvasSize,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ) else { fatalError("Unable to create bitmap") }
  bitmap.size = NSSize(width: canvasSize, height: canvasSize)

  NSGraphicsContext.saveGraphicsState()
  guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fatalError("Unable to create graphics context")
  }
  NSGraphicsContext.current = context
  context.shouldAntialias = true
  let canvas = NSRect(x: 0, y: 0, width: canvasSize, height: canvasSize)
  NSColor.clear.setFill()
  canvas.fill()

  // The shipped tile, then its pixels recolored in place: `sourceIn` keeps
  // each pixel's alpha (the outline and its antialiased edge) and takes the
  // gradient's color.
  tileImage.draw(in: canvas, from: canvas, operation: .copy, fraction: 1)
  context.compositingOperation = .sourceIn
  // AppKit is y-up: the gradient's 90° runs bottom to top.
  NSGradient(starting: color(icon.tileBottom), ending: color(icon.tileTop))!
    .draw(in: NSRect(x: tileOrigin, y: tileOrigin, width: tileSize, height: tileSize), angle: 90)
  context.compositingOperation = .sourceOver

  let scale = tileSize / markViewBox
  for bar in markBars {
    let rect = NSRect(
      x: tileOrigin + bar.x * scale,
      y: tileOrigin + (markViewBox - bar.y - bar.height) * scale,
      width: bar.width * scale,
      height: bar.height * scale
    )
    color(icon.accent, alpha: bar.opacity).setFill()
    NSBezierPath(roundedRect: rect, xRadius: markCornerRadius * scale, yRadius: markCornerRadius * scale).fill()
  }
  NSGraphicsContext.restoreGraphicsState()

  guard let data = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Unable to encode \(icon.theme)")
  }
  let url = outputDir.appendingPathComponent("\(icon.theme).png")
  try data.write(to: url, options: .atomic)
  print("  dock-icons/\(icon.theme).png")
}
