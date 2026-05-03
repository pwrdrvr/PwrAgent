#!/usr/bin/env swift

import AppKit
import Foundation

// DMG window and icon layout — keep in sync with electron-builder.yml dmg section.
let width = 660
let height = 400
let iconSize = 112
let appIconX = 170
let applicationsX = 500
let iconY = 230

let output = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "build/dmg-background.tiff")

struct Color {
  static let black = NSColor(calibratedRed: 0, green: 0, blue: 0, alpha: 1)
  static let text = NSColor(calibratedRed: 0.969, green: 0.953, blue: 0.922, alpha: 1)
  static let secondary = NSColor(calibratedRed: 0.722, green: 0.690, blue: 0.647, alpha: 1)
  static let muted = NSColor(calibratedRed: 0.549, green: 0.522, blue: 0.478, alpha: 1)
  static let accent = NSColor(calibratedRed: 1.000, green: 0.541, blue: 0.122, alpha: 1)
}

/// Render the DMG background at the given pixel scale (1 = standard, 2 = retina).
/// Setting bitmap.size to the logical (1x) dimensions while using scale× pixel
/// dimensions makes NSGraphicsContext apply the correct transform automatically —
/// no manual ctx.scaleBy needed.
func renderBackground(scale: Int) -> NSBitmapImageRep {
  let pw = width * scale
  let ph = height * scale

  guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: pw,
    pixelsHigh: ph,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ) else {
    fatalError("Unable to create bitmap at \(scale)x")
  }
  // Point size = logical (1x) size; the pixel/point ratio gives the implicit scale.
  bitmap.size = NSSize(width: CGFloat(width), height: CGFloat(height))

  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)

  let h = CGFloat(height)

  // Background
  Color.black.setFill()
  NSRect(x: 0, y: 0, width: CGFloat(width), height: h).fill()

  // Logo: "Pwr" + "Agent"
  let logoFont = NSFont.systemFont(ofSize: 45, weight: .bold)
  let logoY = h - 78
  let pwrSize = "Pwr".size(withAttributes: [.font: logoFont])
  let agentSize = "Agent".size(withAttributes: [.font: logoFont])
  let logoX = (CGFloat(width) - pwrSize.width - agentSize.width) / 2

  let textAttrs: [NSAttributedString.Key: Any] = [.font: logoFont, .foregroundColor: Color.text]
  let accentAttrs: [NSAttributedString.Key: Any] = [.font: logoFont, .foregroundColor: Color.accent]
  "Pwr".draw(at: NSPoint(x: logoX, y: logoY), withAttributes: textAttrs)
  "Agent".draw(at: NSPoint(x: logoX + pwrSize.width, y: logoY), withAttributes: accentAttrs)

  // Subtitle
  let subtitleFont = NSFont.systemFont(ofSize: 12, weight: .medium)
  let subtitle = "threads / transcripts"
  let subtitleAttrs: [NSAttributedString.Key: Any] = [.font: subtitleFont, .foregroundColor: Color.muted]
  let subtitleSize = subtitle.size(withAttributes: subtitleAttrs)
  subtitle.draw(
    at: NSPoint(x: (CGFloat(width) - subtitleSize.width) / 2, y: h - 106),
    withAttributes: subtitleAttrs
  )

  // Arrow between icons — positioned between their inner edges.
  let arrowStartX = CGFloat(appIconX + iconSize / 2 + 18)
  let arrowEndX = CGFloat(applicationsX - iconSize / 2 - 18)
  let arrowY = h - CGFloat(iconY)

  NSColor(calibratedRed: 0.722, green: 0.690, blue: 0.647, alpha: 0.60).setStroke()
  let arrow = NSBezierPath()
  arrow.move(to: NSPoint(x: arrowStartX, y: arrowY))
  arrow.line(to: NSPoint(x: arrowEndX - 16, y: arrowY))
  arrow.lineWidth = 2.5
  arrow.stroke()

  Color.accent.withAlphaComponent(0.82).setFill()
  let arrowHead = NSBezierPath()
  arrowHead.move(to: NSPoint(x: arrowEndX, y: arrowY))
  arrowHead.line(to: NSPoint(x: arrowEndX - 18, y: arrowY + 11))
  arrowHead.line(to: NSPoint(x: arrowEndX - 18, y: arrowY - 11))
  arrowHead.close()
  arrowHead.fill()

  // Light zones behind Finder icon labels (Finder draws black text over background).
  for labelX in [CGFloat(appIconX), CGFloat(applicationsX)] {
    let labelZone = NSBezierPath(
      roundedRect: NSRect(x: labelX - 50, y: h - CGFloat(iconY) - 80, width: 100, height: 20),
      xRadius: 4, yRadius: 4
    )
    NSColor.white.withAlphaComponent(0.22).setFill()
    labelZone.fill()
  }

  // Instruction hint
  let instructionFont = NSFont.systemFont(ofSize: 12, weight: .medium)
  let instruction = "Drag to Applications"
  let instrAttrs: [NSAttributedString.Key: Any] = [.font: instructionFont, .foregroundColor: Color.secondary]
  let instrSize = instruction.size(withAttributes: instrAttrs)
  instruction.draw(
    at: NSPoint(x: (CGFloat(width) - instrSize.width) / 2, y: h - 366),
    withAttributes: instrAttrs
  )

  NSGraphicsContext.restoreGraphicsState()
  return bitmap
}

// Generate 1x and 2x representations.
let rep1x = renderBackground(scale: 1)
let rep2x = renderBackground(scale: 2)

// Combine into a multi-resolution TIFF (HiDPI) with LZW compression.
let image = NSImage(size: NSSize(width: CGFloat(width), height: CGFloat(height)))
image.addRepresentation(rep1x)
image.addRepresentation(rep2x)

guard let tiffData = image.tiffRepresentation(using: .lzw, factor: 1.0) else {
  fatalError("Unable to create multi-resolution TIFF")
}

try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
try tiffData.write(to: output)
print("Generated HiDPI DMG background (\(tiffData.count / 1024) KB): \(output.path)")
