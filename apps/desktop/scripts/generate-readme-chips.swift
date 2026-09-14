#!/usr/bin/env swift

import AppKit
import CoreText
import Foundation

// Regenerates the repository README's download and link chips. Run from
// apps/desktop, as the sibling asset generators here are:
//
//   swift scripts/generate-readme-chips.swift
//
// It is the one generator in this directory that writes OUTSIDE
// apps/desktop/build — its output is repository documentation, at
// docs/assets/buttons/. It lives here because this is where the brand raster
// generators and the vendored Geist face already are.
//
// The design is specified in docs/design/pwragent-v2/project/README Header.dc.html.
// That artboard and this file are the same design twice: the artboard is what a
// person reads, this is what produces the pixels. Change both together.
//
// Chips are deliberately theme-independent. GitHub serves README images
// unchanged in light and dark, and <picture> + prefers-color-scheme would
// double the asset count for no gain — so every chip carries its own opaque
// fill and clears contrast on white and on #0d1117 alike. That also keeps them
// correct in the renderers that ignore <picture>: npm, VS Code, GitHub mobile.
//
// Ported from PwrGit, where this generator originated
// (pwrdrvr/PwrGit#259). Only `brand` and `chips` below differ; everything
// after them is byte-identical, so a fix to the renderer can be moved between
// the two repositories without a merge.

// MARK: - Brand

/// Everything a sibling repository has to change, in one place.
struct Brand {
  let accent: NSColor
  let accentTop: NSColor
  let onAccent: NSColor
  let surface: NSColor
  let surfaceBorder: NSColor
  let text: NSColor
  let muted: NSColor
  /// Geist Bold, relative to apps/desktop. Falls back to the system bold face
  /// when absent, which shifts metrics — keep the file present.
  let boldFontPath: String
}

// Every value is a docs/UI-THEME.md dark-theme token. PwrAgent and PwrGit
// share the PwrDrvr tangerine, so the accent pair is identical by inheritance
// rather than by copying.
let brand = Brand(
  // deviceRGB, not calibratedRGB: the design-system tangerine is #ff8a1f and
  // calibrated drifts it to #ee894a. Same pin as generate-dmg-background.swift.
  accent: NSColor(deviceRed: 255 / 255.0, green: 138 / 255.0, blue: 31 / 255.0, alpha: 1),
  // --accent-strong #ffa33d.
  accentTop: NSColor(deviceRed: 255 / 255.0, green: 163 / 255.0, blue: 61 / 255.0, alpha: 1),
  // --terminal-cursor-accent #160a00, the app's ink-on-tangerine.
  onAccent: NSColor(deviceRed: 22 / 255.0, green: 10 / 255.0, blue: 0 / 255.0, alpha: 1),
  // --bg-panel #0a0a0a, the same pill fill generate-dmg-background.swift uses.
  surface: NSColor(deviceRed: 10 / 255.0, green: 10 / 255.0, blue: 10 / 255.0, alpha: 1),
  // Between --border-subtle (.1) and --border-strong (.2). On GitHub's dark
  // #0d1117 this hairline is the only thing separating a secondary chip from
  // the page, so it is deliberately stronger than the in-app subtle border.
  surfaceBorder: NSColor(deviceRed: 247 / 255.0, green: 243 / 255.0, blue: 235 / 255.0, alpha: 0.16),
  // --text-primary #f7f3eb.
  text: NSColor(deviceRed: 247 / 255.0, green: 243 / 255.0, blue: 235 / 255.0, alpha: 1),
  // --text-secondary #b8b0a5, not --text-muted #8c857a: the subtitle is the
  // line that names the artifact, and 11px muted on #0a0a0a lands near 4:1.
  muted: NSColor(deviceRed: 184 / 255.0, green: 176 / 255.0, blue: 165 / 255.0, alpha: 1),
  boldFontPath: "build/fonts/Geist-Bold.ttf"
)

// MARK: - Chip inventory

enum Style {
  /// Tangerine fill, dark ink. Exactly one chip per README wears this.
  case primary
  /// Near-black fill, hairline border, light ink.
  case secondary
}

enum Family {
  /// Two-line download chip: 276x64.
  case download
  /// One-line link chip: 200x44.
  case link
}

struct Chip {
  let file: String
  let family: Family
  let style: Style
  let title: String
  /// Second line. Empty on link chips.
  let subtitle: String
}

// Three download chips, not four. PwrAgent ships a fourth platform, and at the
// 250px display width that keeps a download label readable, four chips need
// 1000px against GitHub's ~836px content column — they would wrap. Debian and
// Ubuntu are a link chip instead, and the reason is editorial before it is
// geometric: Linux ships TWO architectures (PwrAgent-linux-x64.deb and
// PwrAgent-linux-arm64.deb) and a `.deb` wants install instructions, neither
// of which one chip can say. docs.pwragent.ai/linux/ says both.
//
// Universal is the primary rather than Apple Silicon, which is where PwrGit
// puts it. No release carries an arm64 macOS DMG yet — #2074 built the stage,
// and v1.0.6 was cut from the 1.0 line before it — so the loudest chip on the
// page would point at a page with no matching asset. Universal runs natively
// on Apple Silicon, so it is the correct answer for every Mac today.
// When an arm64 DMG ships, one commit swaps these two styles, moves Apple
// Silicon to the first slot, repoints its href, and drops the README's
// hedge sentence.
let chips: [Chip] = [
  Chip(
    file: "download-mac-universal.png", family: .download, style: .primary,
    title: "Download for Mac", subtitle: "Universal · Intel + Apple Silicon"
  ),
  Chip(
    file: "download-mac-apple-silicon.png", family: .download, style: .secondary,
    title: "Download for Mac", subtitle: "Apple Silicon"
  ),
  Chip(
    file: "download-windows.png", family: .download, style: .secondary,
    title: "Download for Windows", subtitle: "x64 installer"
  ),
  Chip(file: "link-linux.png", family: .link, style: .secondary, title: "Debian / Ubuntu", subtitle: ""),
  Chip(file: "link-docs.png", family: .link, style: .secondary, title: "Documentation", subtitle: ""),
  Chip(file: "link-website.png", family: .link, style: .secondary, title: "pwragent.ai", subtitle: ""),
  Chip(file: "link-about.png", family: .link, style: .secondary, title: "About PwrDrvr", subtitle: ""),
]

let outputDirectory = CommandLine.arguments.dropFirst().first ?? "../../docs/assets/buttons"

// MARK: - Geometry

extension Family {
  /// Logical size. PNGs are written at 2x these numbers. README.md displays
  /// them slightly smaller — 250 and 180 — so three download chips still sit on
  /// one row in GitHub's ~836px content column once the repo sidebar is there.
  /// Rendering above 1x is what keeps them crisp at that display width.
  var size: NSSize {
    switch self {
    case .download: return NSSize(width: 276, height: 64)
    case .link: return NSSize(width: 200, height: 44)
    }
  }

  var cornerRadius: CGFloat {
    switch self {
    case .download: return 12
    case .link: return 10
    }
  }
}

let scale: CGFloat = 2

// MARK: - Font loading

/// Register a font file from disk so its PostScript name resolves through
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

let geistBoldName = registerFont(at: brand.boldFontPath)
if geistBoldName == nil {
  FileHandle.standardError.write(
    Data("warning: \(brand.boldFontPath) not found — falling back to the system bold face.\n".utf8)
  )
}

func boldFont(_ size: CGFloat) -> NSFont {
  if let name = geistBoldName, let font = NSFont(name: name, size: size) { return font }
  return NSFont.systemFont(ofSize: size, weight: .bold)
}

/// Subtitles use the system medium face, as the DMG background's subtitle does.
/// Only Geist Bold is vendored, and Bold at 11px reads as a second heading
/// rather than as supporting text.
func subtitleFont(_ size: CGFloat) -> NSFont { NSFont.systemFont(ofSize: size, weight: .medium) }

// MARK: - Lucide icons

/// A Lucide glyph as polylines on Lucide's own 24x24 grid, y-down.
/// Coordinates are copied from the published SVG, never redrawn by hand.
struct Icon {
  let polylines: [[CGPoint]]

  /// lucide `arrow-down-to-line`
  static let arrowDownToLine = Icon(polylines: [
    [CGPoint(x: 12, y: 17), CGPoint(x: 12, y: 3)],
    [CGPoint(x: 18, y: 11), CGPoint(x: 12, y: 17), CGPoint(x: 6, y: 11)],
    [CGPoint(x: 19, y: 21), CGPoint(x: 5, y: 21)],
  ])

  /// lucide `arrow-up-right`
  static let arrowUpRight = Icon(polylines: [
    [CGPoint(x: 7, y: 7), CGPoint(x: 17, y: 7), CGPoint(x: 17, y: 17)],
    [CGPoint(x: 7, y: 17), CGPoint(x: 17, y: 7)],
  ])
}

/// Stroke a Lucide glyph into `rect`, flipping y for AppKit's bottom-left origin.
func draw(icon: Icon, in rect: NSRect, color: NSColor) {
  let unit = rect.width / 24
  color.setStroke()
  for polyline in icon.polylines {
    let path = NSBezierPath()
    for (index, point) in polyline.enumerated() {
      let mapped = NSPoint(
        x: rect.minX + point.x * unit,
        y: rect.maxY - point.y * unit
      )
      if index == 0 { path.move(to: mapped) } else { path.line(to: mapped) }
    }
    path.lineWidth = 2 * unit
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    path.stroke()
  }
}

// MARK: - Rendering

var failures: [String] = []

func render(_ chip: Chip) -> NSBitmapImageRep {
  let size = chip.family.size
  guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: Int(size.width * scale),
    pixelsHigh: Int(size.height * scale),
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ) else {
    fatalError("Unable to create bitmap for \(chip.file)")
  }
  // Logical size smaller than the pixel count gives the context a 2x CTM, so
  // everything below is written in logical units and lands at retina density.
  bitmap.size = size

  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)

  let bounds = NSRect(origin: .zero, size: size)
  let radius = chip.family.cornerRadius

  switch chip.style {
  case .primary:
    let body = NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius)
    body.setClip()
    // A two-stop vertical wash, not a decorative gradient: it is the same
    // lift the app's primary button carries, and it survives grayscale.
    NSGradient(starting: brand.accentTop, ending: brand.accent)?
      .draw(in: bounds, angle: -90)
  case .secondary:
    let body = NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius)
    brand.surface.setFill()
    body.fill()
    // Inset by half the line width so the hairline lands inside the bitmap
    // instead of straddling the edge and rendering at half opacity.
    let border = NSBezierPath(
      roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5),
      xRadius: radius - 0.5,
      yRadius: radius - 0.5
    )
    border.lineWidth = 1
    brand.surfaceBorder.setStroke()
    border.stroke()
  }

  let ink = chip.style == .primary ? brand.onAccent : brand.text
  let subtleInk = chip.style == .primary
    ? brand.onAccent.withAlphaComponent(0.68)
    : brand.muted
  let iconInk = chip.style == .primary ? brand.onAccent : brand.accent

  switch chip.family {
  case .download:
    let padding: CGFloat = 18
    let iconSize: CGFloat = 20
    let gutter: CGFloat = 14

    draw(
      icon: .arrowDownToLine,
      in: NSRect(
        x: padding,
        y: (size.height - iconSize) / 2,
        width: iconSize,
        height: iconSize
      ),
      color: iconInk
    )

    let titleAttrs: [NSAttributedString.Key: Any] = [
      .font: boldFont(15), .foregroundColor: ink,
    ]
    let subtitleAttrs: [NSAttributedString.Key: Any] = [
      .font: subtitleFont(11), .foregroundColor: subtleInk,
    ]
    let titleSize = chip.title.size(withAttributes: titleAttrs)
    let subtitleSize = chip.subtitle.size(withAttributes: subtitleAttrs)

    let lineGap: CGFloat = 1
    let blockHeight = titleSize.height + lineGap + subtitleSize.height
    let blockBottom = ((size.height - blockHeight) / 2).rounded()
    let textX = padding + iconSize + gutter

    chip.subtitle.draw(at: NSPoint(x: textX, y: blockBottom), withAttributes: subtitleAttrs)
    chip.title.draw(
      at: NSPoint(x: textX, y: blockBottom + subtitleSize.height + lineGap),
      withAttributes: titleAttrs
    )

    let available = size.width - textX - padding
    let widest = max(titleSize.width, subtitleSize.width)
    if widest > available {
      failures.append(
        "\(chip.file): text needs \(Int(widest.rounded()))pt but the chip offers "
          + "\(Int(available.rounded()))pt — widen Family.download or shorten the label"
      )
    }

  case .link:
    let iconSize: CGFloat = 14
    let gutter: CGFloat = 8
    let titleAttrs: [NSAttributedString.Key: Any] = [
      .font: boldFont(13), .foregroundColor: ink,
    ]
    let titleSize = chip.title.size(withAttributes: titleAttrs)
    let groupWidth = titleSize.width + gutter + iconSize
    let groupX = ((size.width - groupWidth) / 2).rounded()

    chip.title.draw(
      at: NSPoint(x: groupX, y: ((size.height - titleSize.height) / 2).rounded()),
      withAttributes: titleAttrs
    )
    draw(
      icon: .arrowUpRight,
      in: NSRect(
        x: groupX + titleSize.width + gutter,
        y: (size.height - iconSize) / 2,
        width: iconSize,
        height: iconSize
      ),
      color: iconInk
    )

    let padding: CGFloat = 14
    if groupWidth > size.width - padding * 2 {
      failures.append(
        "\(chip.file): label needs \(Int(groupWidth.rounded()))pt but the chip offers "
          + "\(Int((size.width - padding * 2).rounded()))pt — widen Family.link or shorten the label"
      )
    }
  }

  NSGraphicsContext.restoreGraphicsState()
  return bitmap
}

// MARK: - Write

let directory = URL(fileURLWithPath: outputDirectory)
try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

for chip in chips {
  let bitmap = render(chip)
  guard let data = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Unable to encode \(chip.file)")
  }
  let url = directory.appendingPathComponent(chip.file)
  do {
    try data.write(to: url)
  } catch {
    fatalError("Unable to write \(url.path): \(error)")
  }
  print("\(url.path) — \(bitmap.pixelsWide)x\(bitmap.pixelsHigh)")
}

if !failures.isEmpty {
  // Clipped text is silent in a PNG. Fail loudly instead of shipping one.
  FileHandle.standardError.write(Data((failures.joined(separator: "\n") + "\n").utf8))
  exit(1)
}
