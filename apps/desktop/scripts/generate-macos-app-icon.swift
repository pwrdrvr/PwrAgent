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
// No .icns is written — AGENTS.md "macOS app icon" says why.
//
// The mark is DRAWN, not lifted off the raster. The master is a 4x
// rasterization of docs/design/pwragent-v2/project/assets/logo-pwragnt.svg —
// four rounded bars of one accent color at four opacities — so the layer is
// rendered from that geometry, antialiased, at 1024px. The master is measured
// against the same geometry before anything is written: a re-exported
// icon.png that no longer matches it fails here instead of shipping two
// different marks.

let scriptsDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let desktopDir = scriptsDir.deletingLastPathComponent()
let buildDir = desktopDir.appendingPathComponent("build", isDirectory: true)
let sourceURL = buildDir.appendingPathComponent("icon.png")
let macOSDockIconURL = buildDir.appendingPathComponent("icon-macos.png")
let packageURL = buildDir.appendingPathComponent("icon.icon", isDirectory: true)
let assetsURL = packageURL.appendingPathComponent("Assets", isDirectory: true)
let glyphURL = assetsURL.appendingPathComponent("glyph.png")
let manifestURL = packageURL.appendingPathComponent("icon.json")

typealias RGB = (r: Double, g: Double, b: Double)

/// #e8743a, the app-icon orange.
let accent: RGB = (232, 116, 58)
/// The tile gradient, top to bottom, as the master paints it. Read back from
/// the master below so the package fill and the raster cannot drift apart.
let tileTop: RGB = (30, 25, 20)
let tileBottom: RGB = (10, 9, 8)
/// The master paints a 2px highlight just inside the tile edge.
let rimInset = 2
/// Icon Composer's canvas.
let packageSize = 1024

/// The mark: the `<rect>`s of logo-pwragnt.svg, in its 128-unit viewBox,
/// top-down like SVG. Keep in step with that file.
struct Bar {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
  let opacity: Double
}
let markViewBox = 128.0
let markCornerRadius = 2.0
let markBars = [
  Bar(x: 28, y: 32, width: 60, height: 10, opacity: 1.00),
  Bar(x: 28, y: 50, width: 72, height: 10, opacity: 0.65),
  Bar(x: 28, y: 68, width: 44, height: 10, opacity: 0.40),
  Bar(x: 28, y: 86, width: 56, height: 10, opacity: 0.25),
]

// MARK: - The master

guard let sourceData = try? Data(contentsOf: sourceURL),
      let source = NSBitmapImageRep(data: sourceData)
else {
  fatalError("Unable to read \(sourceURL.path)")
}
let sourceSize = source.pixelsWide
precondition(source.pixelsHigh == sourceSize, "icon.png must be square")
/// Master pixels per SVG unit (4 for the 512px master).
let masterScale = Double(sourceSize) / markViewBox

func channels(_ x: Int, _ y: Int) -> (r: Double, g: Double, b: Double, a: Double) {
  guard let color = source.colorAt(x: x, y: y) else { fatalError("No pixel at \(x),\(y)") }
  return (color.redComponent * 255, color.greenComponent * 255, color.blueComponent * 255, color.alphaComponent)
}

func expectClose(_ actual: Double, _ expected: Double, within tolerance: Double, _ what: String) {
  precondition(
    abs(actual - expected) <= tolerance,
    "\(what): expected \(expected), the master has \(actual) — build/icon.png no longer matches this script's geometry"
  )
}

// The tile gradient, sampled at the center column just inside the rim.
let sampledTop = channels(sourceSize / 2, rimInset)
let sampledBottom = channels(sourceSize / 2, sourceSize - 1 - rimInset)
precondition(sampledTop.a == 1 && sampledBottom.a == 1, "gradient samples must be inside the tile")
for (sampled, expected, edge) in [(sampledTop, tileTop, "top"), (sampledBottom, tileBottom, "bottom")] {
  expectClose(sampled.r, expected.r, within: 2, "tile gradient \(edge) red")
  expectClose(sampled.g, expected.g, within: 2, "tile gradient \(edge) green")
  expectClose(sampled.b, expected.b, within: 2, "tile gradient \(edge) blue")
}

/// Opacity of the accent at a master pixel, solved from the red channel
/// against the tile gradient on that row (the bars are accent-over-gradient,
/// and red is the channel with the most separation).
let backgroundSampleX = 40  // inside the tile and left of the mark on every bar row
func markOpacity(_ x: Int, _ y: Int) -> Double {
  let background = channels(backgroundSampleX, y)
  precondition(background.a == 1, "background sample at \(backgroundSampleX),\(y) is outside the tile")
  let pixel = channels(x, y)
  return min(max((pixel.r - background.r) / (accent.r - background.r), 0), 1)
}

// Every bar sits where the geometry says, at its authored opacity: the center
// and a pixel just inside each edge read as the bar, three pixels outside
// read as tile. (The master's rasterizer rounds edges by up to one pixel.)
for (index, bar) in markBars.enumerated() {
  let x0 = Int((bar.x * masterScale).rounded())
  let x1 = Int(((bar.x + bar.width) * masterScale).rounded())  // exclusive
  let y0 = Int((bar.y * masterScale).rounded())
  let y1 = Int(((bar.y + bar.height) * masterScale).rounded())  // exclusive
  let cx = (x0 + x1) / 2
  let cy = (y0 + y1) / 2
  let probes: [(x: Int, y: Int, expected: Double, what: String)] = [
    (cx, cy, bar.opacity, "center"),
    (x0 + 1, cy, bar.opacity, "left edge"), (x0 - 3, cy, 0, "left of the bar"),
    (x1 - 2, cy, bar.opacity, "right edge"), (x1 + 2, cy, 0, "right of the bar"),
    (cx, y0 + 1, bar.opacity, "top edge"), (cx, y0 - 3, 0, "above the bar"),
    (cx, y1 - 2, bar.opacity, "bottom edge"), (cx, y1 + 2, 0, "below the bar"),
  ]
  for probe in probes {
    expectClose(markOpacity(probe.x, probe.y), probe.expected, within: 0.03, "bar \(index) \(probe.what)")
  }
}

// MARK: - Helpers

func makeCanvas(_ size: Int) -> NSBitmapImageRep {
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
  return bitmap
}

/// Runs `draw` with a graphics context on `bitmap`, cleared to transparent.
func paint(_ bitmap: NSBitmapImageRep, _ draw: (NSGraphicsContext) -> Void) {
  NSGraphicsContext.saveGraphicsState()
  guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fatalError("Unable to create graphics context")
  }
  NSGraphicsContext.current = context
  NSColor.clear.setFill()
  NSRect(x: 0, y: 0, width: bitmap.pixelsWide, height: bitmap.pixelsHigh).fill()
  draw(context)
  NSGraphicsContext.restoreGraphicsState()
}

func writePNG(_ bitmap: NSBitmapImageRep, to url: URL, label: String) throws {
  guard let data = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Unable to encode \(label)")
  }
  try data.write(to: url, options: .atomic)
  print("  \(label) (\(bitmap.pixelsWide)x\(bitmap.pixelsHigh))")
}

func gradientStop(_ c: RGB) -> String {
  String(format: "srgb:%.5f,%.5f,%.5f,1.00000", c.r / 255, c.g / 255, c.b / 255)
}

// MARK: - build/icon.icon/Assets/glyph.png

let glyph = makeCanvas(packageSize)
let layerScale = Double(packageSize) / markViewBox
paint(glyph) { context in
  context.shouldAntialias = true
  let accentColor = NSColor(deviceRed: accent.r / 255, green: accent.g / 255, blue: accent.b / 255, alpha: 1)
  for bar in markBars {
    // AppKit bitmaps are y-up; SVG is y-down.
    let rect = NSRect(
      x: bar.x * layerScale,
      y: (markViewBox - bar.y - bar.height) * layerScale,
      width: bar.width * layerScale,
      height: bar.height * layerScale
    )
    let radius = markCornerRadius * layerScale
    accentColor.withAlphaComponent(bar.opacity).setFill()
    NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
  }
}
try FileManager.default.createDirectory(at: assetsURL, withIntermediateDirectories: true)
try writePNG(glyph, to: glyphURL, label: "icon.icon/Assets/glyph.png")

// MARK: - build/icon.icon/icon.json

let manifest = """
{
  "fill" : {
    "linear-gradient" : [
      "\(gradientStop(tileTop))",
      "\(gradientStop(tileBottom))"
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
print("  icon.icon/icon.json (fill \(gradientStop(tileTop)) -> \(gradientStop(tileBottom)))")

// MARK: - build/icon-macos.png

// The development Dock icon: app.dock.setIcon() paints a PNG literally, and
// macOS 15 draws an unpadded tile edge-to-edge, so this one carries Apple's
// legacy 824/1024 tile with the 100px transparent margin.
let masterImage = NSImage(size: NSSize(width: sourceSize, height: sourceSize))
masterImage.addRepresentation(source)
let dockIcon = makeCanvas(packageSize)
paint(dockIcon) { context in
  context.imageInterpolation = .high
  masterImage.draw(
    in: NSRect(x: 100, y: 100, width: 824, height: 824),
    from: NSRect(origin: .zero, size: masterImage.size),
    operation: .copy,
    fraction: 1
  )
}
try writePNG(dockIcon, to: macOSDockIconURL, label: "icon-macos.png")
