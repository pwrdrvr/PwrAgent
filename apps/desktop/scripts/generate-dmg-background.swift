#!/usr/bin/env swift

import AppKit
import Foundation

let width = 660
let height = 400
let output = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "build/dmg-background.tiff")

struct Color {
  static let black = NSColor(calibratedRed: 0, green: 0, blue: 0, alpha: 1)
  static let panel = NSColor(calibratedRed: 0.039, green: 0.039, blue: 0.039, alpha: 1)
  static let text = NSColor(calibratedRed: 0.969, green: 0.953, blue: 0.922, alpha: 1)
  static let secondary = NSColor(calibratedRed: 0.722, green: 0.690, blue: 0.647, alpha: 1)
  static let muted = NSColor(calibratedRed: 0.549, green: 0.522, blue: 0.478, alpha: 1)
  static let accent = NSColor(calibratedRed: 1.000, green: 0.541, blue: 0.122, alpha: 1)
}

func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> NSRect {
  NSRect(x: x, y: CGFloat(height) - y - h, width: w, height: h)
}

func roundedRect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, radius: CGFloat) -> NSBezierPath {
  NSBezierPath(roundedRect: rect(x, y, w, h), xRadius: radius, yRadius: radius)
}

func drawText(_ text: String, at point: NSPoint, font: NSFont, color: NSColor, centered: Bool = false) -> NSSize {
  let paragraph = NSMutableParagraphStyle()
  paragraph.alignment = centered ? .center : .left
  let attributes: [NSAttributedString.Key: Any] = [
    .font: font,
    .foregroundColor: color,
    .paragraphStyle: paragraph,
  ]
  let size = text.size(withAttributes: attributes)
  let origin = centered ? NSPoint(x: point.x - size.width / 2, y: point.y) : point
  text.draw(at: origin, withAttributes: attributes)
  return size
}

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

Color.black.setFill()
rect(0, 0, CGFloat(width), CGFloat(height)).fill()

Color.panel.setFill()
roundedRect(88, 164, 484, 154, radius: 8).fill()

NSColor(calibratedRed: 0.969, green: 0.953, blue: 0.922, alpha: 0.12).setStroke()
let shelfBorder = roundedRect(88, 164, 484, 154, radius: 8)
shelfBorder.lineWidth = 1
shelfBorder.stroke()

let logoFont = NSFont.systemFont(ofSize: 45, weight: .bold)
let logoY = CGFloat(height) - 78
let pwrSize = "Pwr".size(withAttributes: [.font: logoFont])
let agentSize = "Agent".size(withAttributes: [.font: logoFont])
let logoX = (CGFloat(width) - pwrSize.width - agentSize.width) / 2
_ = drawText("Pwr", at: NSPoint(x: logoX, y: logoY), font: logoFont, color: Color.text)
_ = drawText("Agent", at: NSPoint(x: logoX + pwrSize.width, y: logoY), font: logoFont, color: Color.accent)

let subtitleFont = NSFont.systemFont(ofSize: 12, weight: .medium)
_ = drawText(
  "threads / transcripts",
  at: NSPoint(x: CGFloat(width) / 2, y: CGFloat(height) - 106),
  font: subtitleFont,
  color: Color.muted,
  centered: true
)

NSColor(calibratedRed: 0.722, green: 0.690, blue: 0.647, alpha: 0.60).setStroke()
let arrow = NSBezierPath()
arrow.move(to: NSPoint(x: 284, y: CGFloat(height) - 222))
arrow.line(to: NSPoint(x: 378, y: CGFloat(height) - 222))
arrow.lineWidth = 2
arrow.stroke()

Color.accent.withAlphaComponent(0.82).setFill()
let arrowHead = NSBezierPath()
arrowHead.move(to: NSPoint(x: 392, y: CGFloat(height) - 222))
arrowHead.line(to: NSPoint(x: 377, y: CGFloat(height) - 213))
arrowHead.line(to: NSPoint(x: 377, y: CGFloat(height) - 231))
arrowHead.close()
arrowHead.fill()

NSColor(calibratedRed: 0.722, green: 0.690, blue: 0.647, alpha: 0.22).setStroke()
let folder = NSBezierPath()
folder.move(to: NSPoint(x: 438, y: CGFloat(height) - 188))
folder.line(to: NSPoint(x: 464, y: CGFloat(height) - 188))
folder.line(to: NSPoint(x: 471, y: CGFloat(height) - 196))
folder.line(to: NSPoint(x: 520, y: CGFloat(height) - 196))
folder.line(to: NSPoint(x: 520, y: CGFloat(height) - 250))
folder.line(to: NSPoint(x: 438, y: CGFloat(height) - 250))
folder.close()
folder.lineWidth = 1
folder.stroke()

let itemLabelFont = NSFont.systemFont(ofSize: 12, weight: .semibold)
_ = drawText(
  "PwrAgent",
  at: NSPoint(x: 180, y: CGFloat(height) - 304),
  font: itemLabelFont,
  color: Color.text,
  centered: true
)
_ = drawText(
  "Applications",
  at: NSPoint(x: 480, y: CGFloat(height) - 304),
  font: itemLabelFont,
  color: Color.text,
  centered: true
)

let instructionFont = NSFont.systemFont(ofSize: 12, weight: .medium)
_ = drawText(
  "Drag to Applications",
  at: NSPoint(x: CGFloat(width) / 2, y: CGFloat(height) - 366),
  font: instructionFont,
  color: Color.secondary,
  centered: true
)

NSGraphicsContext.restoreGraphicsState()

guard let tiff = bitmap.representation(
  using: .tiff,
  properties: [.compressionMethod: NSBitmapImageRep.TIFFCompression.lzw.rawValue]
) else {
  fatalError("Unable to create TIFF data")
}

try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
try tiff.write(to: output)
