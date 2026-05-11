#!/usr/bin/env swift

import AppKit
import CoreGraphics
import CoreText
import Foundation
import UniformTypeIdentifiers

// render-indicator-overlay.swift
//
// Paints a numbered step-indicator pill onto a PNG, then writes the
// result as a new PNG. Used by `stitch-demo-gif.ts` to annotate
// frames of a multi-step demo so the looping GIF reads as "step 1 of
// 3 → step 2 of 3 → step 3 of 3" without the viewer having to count.
//
// We use Swift + Core Graphics + Core Text rather than ffmpeg's
// `drawtext` filter because the Homebrew ffmpeg bottle doesn't link
// libfreetype, so `-vf drawtext=…` fails with "No such filter:
// 'drawtext'". Swift gives us system SF Pro for free, real rounded
// corners, and antialiased text — no extra dependencies.
//
// Usage:
//   render-indicator-overlay.swift \
//     <input-png> <output-png> <frame-index-0-based> <total-frames> \
//     [--position=top|bottom]
//
// Layout:
//
//   ┌──────────────────────┐
//   │   1  ·  2  ·  3      │   ← pill backdrop, top-center by default
//   └──────────────────────┘
//
// Colors:
//   - Active step:  PwrAgent tangerine (#ff8a1f), larger + bold
//   - Past steps:   White, medium
//   - Pending:      Dim gray, medium
//
// Exits with:
//   0 — success
//   2 — usage error
//   3 — input not loadable
//   4 — render failed

let args = CommandLine.arguments
guard args.count >= 5 else {
  FileHandle.standardError.write(
    Data(
      "usage: render-indicator-overlay.swift <input> <output> <frame-index> <total-frames> [--position=top|bottom]\n"
        .utf8
    )
  )
  exit(2)
}

let inputPath = args[1]
let outputPath = args[2]
guard let frameIndex = Int(args[3]), frameIndex >= 0 else {
  FileHandle.standardError.write(Data("frame-index must be a non-negative integer\n".utf8))
  exit(2)
}
guard let totalFrames = Int(args[4]), totalFrames >= 1, frameIndex < totalFrames else {
  FileHandle.standardError.write(
    Data("total-frames must be >= 1 and frame-index must be < total-frames\n".utf8)
  )
  exit(2)
}

enum Position {
  case top
  case bottom
}

var position: Position = .top
for raw in args.dropFirst(5) {
  if raw == "--position=top" {
    position = .top
  } else if raw == "--position=bottom" {
    position = .bottom
  } else {
    FileHandle.standardError.write(Data("unknown flag: \(raw)\n".utf8))
    exit(2)
  }
}

// Load the input PNG via NSImage / CGImage. We need the raw pixel
// dimensions, not the size-in-points, because the captured frames are
// retina (typically 3104×2024) and we want the overlay to sit at the
// same scale.
guard let inputImage = NSImage(contentsOfFile: inputPath),
  let cgInput = inputImage.cgImage(forProposedRect: nil, context: nil, hints: nil)
else {
  FileHandle.standardError.write(Data("could not load input PNG: \(inputPath)\n".utf8))
  exit(3)
}

let width = cgInput.width
let height = cgInput.height

// Indicator geometry. Tuned for retina captures (~3104×2024). The
// pill backdrop is sized to comfortably hold up to ~6 numbers — past
// that the layout would need to wrap, but README demos rarely go
// beyond 4–5 frames.
let numberGap: CGFloat = 110
let backdropPaddingX: CGFloat = 50
let backdropPaddingY: CGFloat = 24
let backdropHeight: CGFloat = 110
let backdropCornerRadius: CGFloat = 28
let topMargin: CGFloat = 30
let activeFontSize: CGFloat = 78
let inactiveFontSize: CGFloat = 56

let indicatorWidth = numberGap * CGFloat(totalFrames - 1)
let backdropWidth = indicatorWidth + backdropPaddingX * 2
// Core Graphics origin is bottom-left, so flip Y here for "top".
let backdropX: CGFloat = (CGFloat(width) - backdropWidth) / 2
let backdropY: CGFloat = {
  switch position {
  case .top:
    return CGFloat(height) - topMargin - backdropHeight
  case .bottom:
    return topMargin
  }
}()

// Brand tangerine + neutral track colors.
let activeColor = CGColor(red: 1.0, green: 138.0 / 255.0, blue: 31.0 / 255.0, alpha: 1.0)
let pastColor = CGColor(red: 1.0, green: 1.0, blue: 1.0, alpha: 1.0)
let pendingColor = CGColor(red: 102.0 / 255.0, green: 102.0 / 255.0, blue: 102.0 / 255.0, alpha: 1.0)
let backdropColor = CGColor(red: 0, green: 0, blue: 0, alpha: 0.55)

// Resolve the SF font face. SF Pro Display ships on macOS as a
// variable font; ctFontDescriptor gives us the Bold and Regular
// variants by trait.
func makeCTFont(size: CGFloat, bold: Bool) -> CTFont {
  let descriptor = CTFontDescriptorCreateWithAttributes(
    [
      kCTFontFamilyNameAttribute as String: "SF Pro Display",
      kCTFontTraitsAttribute as String: [
        kCTFontSymbolicTrait as String: bold ? CTFontSymbolicTraits.boldTrait.rawValue : 0
      ],
    ] as CFDictionary
  )
  return CTFontCreateWithFontDescriptor(descriptor, size, nil)
}

// Render into an RGBA bitmap context the same size as the input.
guard
  let context = CGContext(
    data: nil,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: width * 4,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  )
else {
  FileHandle.standardError.write(Data("failed to create render context\n".utf8))
  exit(4)
}

// Lay the input down first.
context.draw(cgInput, in: CGRect(x: 0, y: 0, width: width, height: height))

// Draw the pill backdrop.
let backdropRect = CGRect(
  x: backdropX,
  y: backdropY,
  width: backdropWidth,
  height: backdropHeight
)
let backdropPath = CGPath(
  roundedRect: backdropRect,
  cornerWidth: backdropCornerRadius,
  cornerHeight: backdropCornerRadius,
  transform: nil
)
context.addPath(backdropPath)
context.setFillColor(backdropColor)
context.fillPath()

// Draw each numeral. Iterate left-to-right.
for i in 0..<totalFrames {
  let isActive = i == frameIndex
  let isPast = i < frameIndex
  let color = isActive ? activeColor : (isPast ? pastColor : pendingColor)
  let fontSize = isActive ? activeFontSize : inactiveFontSize
  let font = makeCTFont(size: fontSize, bold: isActive)

  // Center-x for this numeral. The "first number" sits one
  // backdropPaddingX in from the backdrop's left edge.
  let xCenter = backdropX + backdropPaddingX + CGFloat(i) * numberGap

  let attrs: [NSAttributedString.Key: Any] = [
    .font: font,
    .foregroundColor: color,
  ]
  let attributed = NSAttributedString(string: "\(i + 1)", attributes: attrs)
  let line = CTLineCreateWithAttributedString(attributed)
  let textBounds = CTLineGetBoundsWithOptions(line, .useOpticalBounds)
  let textX = xCenter - textBounds.width / 2 - textBounds.origin.x
  // Vertical center inside the pill, accounting for font baseline.
  let textY = backdropY + (backdropHeight - textBounds.height) / 2 - textBounds.origin.y

  context.textPosition = CGPoint(x: textX, y: textY)
  CTLineDraw(line, context)
}

// Encode the composite as PNG.
guard let outImage = context.makeImage() else {
  FileHandle.standardError.write(Data("failed to make output CGImage\n".utf8))
  exit(4)
}

let outURL = URL(fileURLWithPath: outputPath)
guard
  let dest = CGImageDestinationCreateWithURL(
    outURL as CFURL,
    UTType.png.identifier as CFString,
    1,
    nil
  )
else {
  FileHandle.standardError.write(Data("failed to create PNG destination\n".utf8))
  exit(4)
}
CGImageDestinationAddImage(dest, outImage, nil)
guard CGImageDestinationFinalize(dest) else {
  FileHandle.standardError.write(Data("failed to write PNG\n".utf8))
  exit(4)
}

print("rendered frame \(frameIndex + 1)/\(totalFrames) -> \(outputPath)")
