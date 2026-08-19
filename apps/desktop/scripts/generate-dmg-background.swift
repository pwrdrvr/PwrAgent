#!/usr/bin/env swift

import AppKit
import CoreText
import Foundation

/// Register a font file from disk so its PostScript name becomes resolvable via
/// NSFont(name:size:). Returns the resolved PostScript name on success.
func registerFont(at path: String) -> String? {
  let url = URL(fileURLWithPath: path)
  guard FileManager.default.fileExists(atPath: url.path) else { return nil }
  var error: Unmanaged<CFError>?
  guard CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) else {
    if let err = error?.takeRetainedValue() {
      FileHandle.standardError.write(Data("Font register failed: \(err)\n".utf8))
    }
    return nil
  }
  guard
    let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor],
    let descriptor = descriptors.first,
    let psName = CTFontDescriptorCopyAttribute(descriptor, kCTFontNameAttribute) as? String
  else { return nil }
  return psName
}

// DMG window and icon layout — keep in sync with electron-builder.yml dmg section.
let width = 660
let height = 400
let iconSize = 112
let appIconX = 170
let applicationsX = 500
let iconY = 230

let output = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "build/dmg-background.png")

// Register the vendored Geist Bold so the wordmark renders in the brand face on
// any build machine, regardless of system fonts. Path is relative to the
// desktop package root (the script's expected working directory).
let geistBoldPath = "build/fonts/Geist-Bold.ttf"
let geistBoldName = registerFont(at: geistBoldPath)

// COLOR SPACE DISCIPLINE — read before editing any value below.
//
// The bitmap rep this script draws into is .deviceRGB (see renderBackground).
// NSColor(calibratedRed:...) declares a color in Apple's generic calibrated RGB
// space, so every calibrated color gets converted on the way into the bitmap and
// lands on a LIGHTER, more saturated value than the numbers say. That drift is
// what produced the shipped #ef714a wordmark from a #E85A3A source, and the
// earlier #ee894a bug before it.
//
// Every color here is therefore declared with `deviceRed:` and written as
// n / 255.0 so the literal in the source IS the hex that lands in the PNG.
// Do not reintroduce `calibratedRed:` in this file.
struct Color {
  /// #f6f6f6 — light page. Kept light on purpose: the "PwrAgent" and
  /// "Applications" icon labels are drawn by Finder and colored by the user's
  /// appearance setting (near-black in Light Mode). A dark page would render
  /// them black-on-black. Keep dark areas behind the wordmark only.
  static let background = NSColor(deviceRed: 246 / 255.0, green: 246 / 255.0, blue: 246 / 255.0, alpha: 1)
  /// #0a0a0a — near-black pill, matching the app titlebar surround. The same
  /// accent orange on a lighter pill reads flatter (simultaneous contrast).
  static let pillBackground = NSColor(deviceRed: 10 / 255.0, green: 10 / 255.0, blue: 10 / 255.0, alpha: 1)
  /// #f7f3eb — warm wordmark white.
  static let text = NSColor(deviceRed: 247 / 255.0, green: 243 / 255.0, blue: 235 / 255.0, alpha: 1)
  /// #8c857a — subtitle grey, matches the app's --text-muted.
  static let muted = NSColor(deviceRed: 140 / 255.0, green: 133 / 255.0, blue: 122 / 255.0, alpha: 1)
  /// #ff8a1f — brand orange, matches the app's --accent. This is the single
  /// source of truth for the wordmark and arrow; the installer and the app
  /// titlebar must measure identical.
  static let accent = NSColor(deviceRed: 255 / 255.0, green: 138 / 255.0, blue: 31 / 255.0, alpha: 1)
  static let arrowShaft = NSColor(deviceRed: 255 / 255.0, green: 138 / 255.0, blue: 31 / 255.0, alpha: 1)
  /// #737373 — "Drag to Applications" hint.
  static let instruction = NSColor(deviceRed: 115 / 255.0, green: 115 / 255.0, blue: 115 / 255.0, alpha: 1)
}

func renderBackground() -> NSBitmapImageRep {
  guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: width,
    pixelsHigh: height,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ) else {
    fatalError("Unable to create bitmap")
  }
  bitmap.size = NSSize(width: CGFloat(width), height: CGFloat(height))

  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)

  let h = CGFloat(height)
  let w = CGFloat(width)

  // Light background
  Color.background.setFill()
  NSRect(x: 0, y: 0, width: w, height: h).fill()

  // Dark rounded pill behind logo and subtitle
  let pillWidth: CGFloat = 340
  let pillHeight: CGFloat = 100
  let pillX = (w - pillWidth) / 2
  let pillY = h - 120
  let pill = NSBezierPath(
    roundedRect: NSRect(x: pillX, y: pillY, width: pillWidth, height: pillHeight),
    xRadius: 16, yRadius: 16
  )
  Color.pillBackground.setFill()
  pill.fill()

  // Logo: "Pwr" + "Agent" — Geist Bold (brand display), falling back to system bold
  // if the vendored font failed to register.
  let logoFont: NSFont = {
    if let name = geistBoldName, let f = NSFont(name: name, size: 40) { return f }
    return NSFont.systemFont(ofSize: 40, weight: .bold)
  }()
  let logoY = pillY + pillHeight - 60
  let pwrSize = "Pwr".size(withAttributes: [.font: logoFont])
  let agentSize = "Agent".size(withAttributes: [.font: logoFont])
  let logoX = (w - pwrSize.width - agentSize.width) / 2

  let textAttrs: [NSAttributedString.Key: Any] = [.font: logoFont, .foregroundColor: Color.text]
  let accentAttrs: [NSAttributedString.Key: Any] = [.font: logoFont, .foregroundColor: Color.accent]
  "Pwr".draw(at: NSPoint(x: logoX, y: logoY), withAttributes: textAttrs)
  "Agent".draw(at: NSPoint(x: logoX + pwrSize.width, y: logoY), withAttributes: accentAttrs)

  // Subtitle
  let subtitleFont = NSFont.systemFont(ofSize: 11, weight: .medium)
  let subtitle = "threads / transcripts"
  let subtitleAttrs: [NSAttributedString.Key: Any] = [.font: subtitleFont, .foregroundColor: Color.muted]
  let subtitleSize = subtitle.size(withAttributes: subtitleAttrs)
  subtitle.draw(
    at: NSPoint(x: (w - subtitleSize.width) / 2, y: pillY + 14),
    withAttributes: subtitleAttrs
  )

  // Arrow — thick orange bar with chunky arrowhead
  let arrowStartX = CGFloat(appIconX + iconSize / 2 + 20)
  let arrowEndX = CGFloat(applicationsX - iconSize / 2 - 20)
  let arrowY = h - CGFloat(iconY)
  let shaftThickness: CGFloat = 18

  // Shaft — rounded rectangle
  let shaft = NSBezierPath(
    roundedRect: NSRect(
      x: arrowStartX,
      y: arrowY - shaftThickness / 2,
      width: arrowEndX - arrowStartX - 20,
      height: shaftThickness
    ),
    xRadius: shaftThickness / 2,
    yRadius: shaftThickness / 2
  )
  Color.arrowShaft.setFill()
  shaft.fill()

  // Arrowhead — solid orange triangle
  Color.accent.setFill()
  let headHeight: CGFloat = 48
  let headWidth: CGFloat = 32
  let arrowHead = NSBezierPath()
  arrowHead.move(to: NSPoint(x: arrowEndX, y: arrowY))
  arrowHead.line(to: NSPoint(x: arrowEndX - headWidth, y: arrowY + headHeight / 2))
  arrowHead.line(to: NSPoint(x: arrowEndX - headWidth, y: arrowY - headHeight / 2))
  arrowHead.close()
  arrowHead.fill()

  // "Drag to Applications" hint
  let instructionFont = NSFont.systemFont(ofSize: 12, weight: .medium)
  let instruction = "Drag to Applications"
  let instrAttrs: [NSAttributedString.Key: Any] = [.font: instructionFont, .foregroundColor: Color.instruction]
  let instrSize = instruction.size(withAttributes: instrAttrs)
  instruction.draw(
    at: NSPoint(x: (w - instrSize.width) / 2, y: h - 366),
    withAttributes: instrAttrs
  )

  NSGraphicsContext.restoreGraphicsState()
  return bitmap
}

// Single 1x PNG — no multi-resolution TIFF.
let rep = renderBackground()

guard let pngData = rep.representation(using: .png, properties: [:]) else {
  fatalError("Unable to create PNG data")
}

try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
try pngData.write(to: output)
print("Generated DMG background PNG (\(pngData.count / 1024) KB): \(output.path)")
