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

struct Color {
  static let background = NSColor(calibratedRed: 0.965, green: 0.965, blue: 0.965, alpha: 1)
  static let pillBackground = NSColor(calibratedRed: 0.12, green: 0.12, blue: 0.12, alpha: 1)
  static let text = NSColor(calibratedRed: 0.969, green: 0.953, blue: 0.922, alpha: 1)
  static let muted = NSColor(calibratedRed: 0.549, green: 0.522, blue: 0.478, alpha: 1)
  // Brand orange — design system: #E85A3A (rgb 232, 90, 58).
  static let accent = NSColor(calibratedRed: 0.910, green: 0.353, blue: 0.227, alpha: 1)
  static let arrowShaft = NSColor(calibratedRed: 0.910, green: 0.353, blue: 0.227, alpha: 1)
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
  let instrColor = NSColor(calibratedRed: 0.45, green: 0.45, blue: 0.45, alpha: 1)
  let instrAttrs: [NSAttributedString.Key: Any] = [.font: instructionFont, .foregroundColor: instrColor]
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
