#!/usr/bin/env swift

import AppKit
import Foundation

// Derives the themed Dock icons. A running instance whose dark theme is not
// Tangerine shows its theme's icon (src/main/themed-dock-icon.ts), so two
// profiles in two themes are told apart in the Dock. app.dock.setIcon()
// paints a bitmap literally, so each set is the finished tile for the macOS
// it is shown on:
//
//   build/dock-icons/<theme>.png        1024px, Apple's 824-in-1024 legacy
//                                       tile, flat. macOS 15 and earlier.
//   build/dock-icons/glass/<theme>.png  The same tile with macOS 26's Liquid
//                                       Glass baked in. macOS 26 and later.
//
// Flat: derived from build/icon-macos.png, the padded development Dock icon
// generate-macos-app-icon.swift writes. The tile keeps the shipped icon's
// exact outline: its alpha is the mask, filled with the theme's canvas
// gradient. The mark is drawn from the same geometry as the shipped glyph
// (logo-pwragnt.svg's four bars) in the theme's accent.
//
// Glass: macOS 26 draws the glass rim and the mark's shadow from an Icon
// Composer package, never from an image set at runtime, and has no API to
// switch a running app to another one. So the glass is rendered here, by the
// system: build/icon.icon is copied with the theme's gradient as the package
// fill and its accent as the glyph layer's fill, compiled with actool, put in
// a throwaway app bundle, and drawn through NSWorkspace.icon(forFile:). That
// renders in the icon style this Mac is set to, so the script refuses to run
// unless the shipped icon renders as the Default style.
//
// The colors are each palette's own, not the contrast-tuned UI tokens: an
// icon has no text to clear AA against.

let scriptsDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let desktopDir = scriptsDir.deletingLastPathComponent()
let buildDir = desktopDir.appendingPathComponent("build", isDirectory: true)
let tileURL = buildDir.appendingPathComponent("icon-macos.png")
let packageURL = buildDir.appendingPathComponent("icon.icon", isDirectory: true)
let outputDir = buildDir.appendingPathComponent("dock-icons", isDirectory: true)
let glassOutputDir = outputDir.appendingPathComponent("glass", isDirectory: true)

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
  // Phosphor's raised surface -> its sidebar, its phosphor green.
  ThemedIcon(theme: "phosphor-dark", tileTop: (12, 22, 14), tileBottom: (3, 7, 4), accent: (0, 255, 65)),
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

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("generate-themed-dock-icons: \(message)\n".data(using: .utf8)!)
  exit(1)
}

// MARK: - Preconditions, checked before anything is written

// The glass set is only right when this Mac draws it the way a user's Mac
// draws the shipped icon by default. Both sets regenerate together, so a
// machine that cannot make the glass one does not touch the flat one.
let os = ProcessInfo.processInfo.operatingSystemVersion
guard os.majorVersion >= 26 else {
  fail("the glass set is rendered by macOS 26 or later; this is macOS \(os.majorVersion).\(os.minorVersion)")
}
if NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
  || NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast {
  fail("turn off Reduce Transparency and Increase Contrast (Accessibility > Display) first: icons render with them")
}

func run(_ arguments: [String]) -> (status: Int32, output: Data) {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
  process.arguments = arguments
  let pipe = Pipe()
  process.standardOutput = pipe
  process.standardError = pipe
  do { try process.run() } catch { fail("unable to run xcrun \(arguments.joined(separator: " ")): \(error)") }
  let output = pipe.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()
  return (process.terminationStatus, output)
}

// electron-builder refuses actool below 26 for the same package.
let actoolVersion = run(["actool", "--version"])
guard actoolVersion.status == 0,
      let versionPlist = try? PropertyListSerialization.propertyList(from: actoolVersion.output, format: nil) as? [String: Any],
      let versionInfo = versionPlist["com.apple.actool.version"] as? [String: Any],
      let shortVersion = versionInfo["short-bundle-version"] as? String,
      let actoolMajor = Int(shortVersion.split(separator: ".").first ?? ""),
      actoolMajor >= 26
else {
  fail("needs Xcode 26's actool; select it with xcode-select or DEVELOPER_DIR")
}

guard let tileData = try? Data(contentsOf: tileURL),
      let tileRep = NSBitmapImageRep(data: tileData),
      tileRep.pixelsWide == canvasSize,
      tileRep.pixelsHigh == canvasSize
else {
  fail("unable to read a \(canvasSize)px \(tileURL.path); run generate:macos-app-icon first")
}
let tileImage = NSImage(size: NSSize(width: canvasSize, height: canvasSize))
tileImage.addRepresentation(tileRep)

guard let manifestData = try? Data(contentsOf: packageURL.appendingPathComponent("icon.json")),
      let shippedManifest = try? JSONSerialization.jsonObject(with: manifestData) as? [String: Any]
else {
  fail("unable to read \(packageURL.path)/icon.json; run generate:macos-app-icon first")
}

// MARK: - Helpers

func color(_ c: RGB, alpha: Double = 1) -> NSColor {
  NSColor(deviceRed: c.r / 255, green: c.g / 255, blue: c.b / 255, alpha: alpha)
}

/// An Icon Composer color, in the form generate-macos-app-icon.swift writes.
func srgb(_ c: RGB) -> String {
  String(format: "srgb:%.5f,%.5f,%.5f,1.00000", c.r / 255, c.g / 255, c.b / 255)
}

func newCanvas() -> NSBitmapImageRep {
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
  ) else { fail("unable to create bitmap") }
  bitmap.size = NSSize(width: canvasSize, height: canvasSize)
  return bitmap
}

func draw(into bitmap: NSBitmapImageRep, _ body: (NSGraphicsContext, NSRect) -> Void) {
  NSGraphicsContext.saveGraphicsState()
  guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fail("unable to create graphics context")
  }
  NSGraphicsContext.current = context
  context.shouldAntialias = true
  let canvas = NSRect(x: 0, y: 0, width: canvasSize, height: canvasSize)
  NSColor.clear.setFill()
  canvas.fill()
  body(context, canvas)
  NSGraphicsContext.restoreGraphicsState()
}

func write(_ bitmap: NSBitmapImageRep, to url: URL, label: String) {
  guard let data = bitmap.representation(using: .png, properties: [:]) else {
    fail("unable to encode \(label)")
  }
  do { try data.write(to: url, options: .atomic) } catch { fail("unable to write \(url.path): \(error)") }
  print("  \(label)")
}

/// The opaque bounds, top-down, as (minX, minY, maxX, maxY).
func opaqueBounds(_ bitmap: NSBitmapImageRep) -> (Int, Int, Int, Int) {
  var minX = canvasSize, minY = canvasSize, maxX = -1, maxY = -1
  for y in 0..<canvasSize {
    for x in 0..<canvasSize where (bitmap.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.5 {
      minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
    }
  }
  return (minX, minY, maxX, maxY)
}

func srgbComponents(_ bitmap: NSBitmapImageRep, x: Int, y: Int) -> [Double] {
  guard let c = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { return [] }
  return [c.redComponent, c.greenComponent, c.blueComponent, c.alphaComponent].map { $0 * 255 }
}

// MARK: - Glass rendering

let workDir = FileManager.default.temporaryDirectory
  .appendingPathComponent("pwragent-dock-icons-\(UUID().uuidString)", isDirectory: true)
defer { try? FileManager.default.removeItem(at: workDir) }

/// Compiles an Icon Composer manifest (with build/icon.icon's assets) and
/// returns what macOS draws for an app carrying it.
///
/// The bundle path and identifier are new for every call: icon services
/// caches by path, and a reused path returns whatever it drew there before.
/// The bundle gets a real executable because one without it is drawn with
/// the "cannot open" badge.
func renderGlass(manifest: [String: Any], name: String) -> NSBitmapImageRep {
  let fileManager = FileManager.default
  let unique = "\(name)-\(UUID().uuidString)"
  let compileDir = workDir.appendingPathComponent("\(unique)-compiled", isDirectory: true)
  // actool resolves `--app-icon Icon` by the package's basename: fed any
  // other name it exits 0 and writes no icon.
  let iconPackage = workDir.appendingPathComponent("\(unique)/Icon.icon", isDirectory: true)
  let bundle = workDir.appendingPathComponent("\(unique).app", isDirectory: true)
  let contents = bundle.appendingPathComponent("Contents", isDirectory: true)
  let resources = contents.appendingPathComponent("Resources", isDirectory: true)
  let executables = contents.appendingPathComponent("MacOS", isDirectory: true)
  do {
    try fileManager.createDirectory(at: iconPackage.deletingLastPathComponent(), withIntermediateDirectories: true)
    try fileManager.copyItem(at: packageURL, to: iconPackage)
    let json = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
    try json.write(to: iconPackage.appendingPathComponent("icon.json"))
    for directory in [compileDir, resources, executables] {
      try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    }
  } catch {
    fail("unable to stage \(name): \(error)")
  }

  // electron-builder's invocation (app-builder-lib macosIconComposer), so the
  // catalog matches the one the packaged app ships.
  let compile = run([
    "actool", iconPackage.path,
    "--compile", compileDir.path,
    "--output-format", "human-readable-text",
    "--notices", "--warnings",
    "--output-partial-info-plist", compileDir.appendingPathComponent("assetcatalog_generated_info.plist").path,
    "--app-icon", "Icon",
    "--include-all-app-icons",
    "--accent-color", "AccentColor",
    "--enable-on-demand-resources", "NO",
    "--development-region", "en",
    "--target-device", "mac",
    "--minimum-deployment-target", "26.0",
    "--platform", "macosx",
  ])
  let catalog = compileDir.appendingPathComponent("Assets.car")
  guard compile.status == 0, fileManager.fileExists(atPath: catalog.path) else {
    fail("actool did not compile \(name):\n\(String(decoding: compile.output, as: UTF8.self))")
  }

  let info: [String: Any] = [
    "CFBundleExecutable": "stub",
    "CFBundleIconName": "Icon",
    "CFBundleIdentifier": "com.pwrdrvr.pwragent.dock-icon-render.\(UUID().uuidString)",
    "CFBundleName": name,
    "CFBundlePackageType": "APPL",
  ]
  do {
    try fileManager.copyItem(at: catalog, to: resources.appendingPathComponent("Assets.car"))
    try fileManager.copyItem(
      at: URL(fileURLWithPath: "/usr/bin/true"),
      to: executables.appendingPathComponent("stub")
    )
    let plist = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
    try plist.write(to: contents.appendingPathComponent("Info.plist"))
  } catch {
    fail("unable to assemble the \(name) bundle: \(error)")
  }

  let icon = NSWorkspace.shared.icon(forFile: bundle.path)
  let bitmap = newCanvas()
  draw(into: bitmap) { context, canvas in
    context.imageInterpolation = .high
    icon.draw(in: canvas, from: .zero, operation: .sourceOver, fraction: 1)
  }
  return bitmap
}

/// build/icon.icon recolored: the theme's gradient as the package fill, its
/// accent as every layer's fill. A solid layer fill keeps the glyph's alpha,
/// so the bars keep their authored opacities.
func themedManifest(_ icon: ThemedIcon) -> [String: Any] {
  var manifest = shippedManifest
  manifest["fill"] = ["linear-gradient": [srgb(icon.tileTop), srgb(icon.tileBottom)]]
  guard let groups = manifest["groups"] as? [[String: Any]] else {
    fail("icon.json has no groups")
  }
  manifest["groups"] = groups.map { group -> [String: Any] in
    var group = group
    let layers = group["layers"] as? [[String: Any]] ?? []
    group["layers"] = layers.map { layer -> [String: Any] in
      var layer = layer
      layer["fill"] = ["solid": srgb(icon.accent)]
      return layer
    }
    return group
  }
  return manifest
}

/// The tile outline icon-macos.png pads to, top-down.
let expectedBounds = (Int(tileOrigin), Int(tileOrigin), Int(tileOrigin + tileSize) - 1, Int(tileOrigin + tileSize) - 1)

func checkBounds(_ bitmap: NSBitmapImageRep, _ name: String) {
  let bounds = opaqueBounds(bitmap)
  let drift = [bounds.0 - expectedBounds.0, bounds.1 - expectedBounds.1, bounds.2 - expectedBounds.2, bounds.3 - expectedBounds.3]
  guard drift.allSatisfy({ abs($0) <= 1 }) else {
    fail("\(name) renders at \(bounds), not the \(expectedBounds) tile the flat set and the Dock expect")
  }
}

// The shipped package first. Rendered in the Default icon style it is the
// flat development tile plus lighting: on macOS 26.6 the tile pixel lands
// within 6 levels of icon-macos.png and the top bar within 21. The Clear and
// Tinted styles replace the bar's orange with a grey, so this is the check
// that the glass set is the Default style's. (The Dark style keeps a dark
// tile and a colored mark, which is the icon this set already is.)
let shippedGlass = renderGlass(manifest: shippedManifest, name: "tangerine")
checkBounds(shippedGlass, "the shipped icon")
let styleProbes = [(x: 200, y: 512, label: "tile"), (x: 400, y: 338, label: "top bar")]
for probe in styleProbes {
  let rendered = srgbComponents(shippedGlass, x: probe.x, y: probe.y)
  let authored = srgbComponents(tileRep, x: probe.x, y: probe.y)
  guard rendered.count == 4, authored.count == 4,
        zip(rendered, authored).allSatisfy({ abs($0 - $1) <= 32 })
  else {
    fail(
      "the shipped icon's \(probe.label) renders \(rendered.map { Int($0.rounded()) }), not "
        + "\(authored.map { Int($0.rounded()) }): set System Settings > Appearance > Icon & widget style to Default"
    )
  }
}

// MARK: - Render both sets, then write them

// Every theme is rendered and checked before any file is written, so a
// failure partway through leaves the committed sets as they were.
let rendered = icons.map { icon -> (theme: String, flat: NSBitmapImageRep, glass: NSBitmapImageRep) in
  let flat = newCanvas()
  draw(into: flat) { context, canvas in
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
  }
  let glass = renderGlass(manifest: themedManifest(icon), name: icon.theme)
  checkBounds(glass, icon.theme)
  return (icon.theme, flat, glass)
}

do {
  try FileManager.default.createDirectory(at: glassOutputDir, withIntermediateDirectories: true)
} catch {
  fail("unable to create \(glassOutputDir.path): \(error)")
}
for icon in rendered {
  write(icon.flat, to: outputDir.appendingPathComponent("\(icon.theme).png"), label: "dock-icons/\(icon.theme).png")
  write(icon.glass, to: glassOutputDir.appendingPathComponent("\(icon.theme).png"), label: "dock-icons/glass/\(icon.theme).png")
}
