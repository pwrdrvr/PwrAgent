import AppKit
@preconcurrency import ScreenCaptureKit
import CoreMedia
import CoreImage
import ImageIO
import UniformTypeIdentifiers
import VideoToolbox

// Fixture-only executable. It cannot select or capture another process's window.
// Build: swiftc -O CaptureFixture.swift -o .local/remote-window/capture-fixture
let output = CommandLine.arguments.dropFirst().first ?? ".local/remote-window/capture"
let inputPath = ProcessInfo.processInfo.environment["FIXTURE_INPUT_FILE"]
let inputSession = ProcessInfo.processInfo.environment["FIXTURE_INPUT_SESSION"]
var inputConsumed = false
try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
let app = NSApplication.shared
app.setActivationPolicy(.regular)

let logLock = NSLock()
func log(_ record: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) {
    logLock.lock()
    defer { logLock.unlock() }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
  }
}

final class FixtureView: NSView {
  var tick = 0
  var phase = "idle"
  var inputText = "Type in this fixture only"
  // Keep the attributed-drawing objects alive for the fixture lifetime.
  let textAttributes: [NSAttributedString.Key: Any] = [
    .font: NSFont(name: "Menlo", size: 15) ?? NSFont.systemFont(ofSize: 15),
    .foregroundColor: NSColor.white,
  ]
  override var acceptsFirstResponder: Bool { true }
  override func keyDown(with event: NSEvent) {
    inputText = String((inputText + (event.characters ?? "")).suffix(64))
    needsDisplay = true
    log(["kind": "fixtureKey", "time": Date().timeIntervalSince1970])
  }
  override func mouseDown(with event: NSEvent) {
    inputText = "Fixture clicked"
    needsDisplay = true
    log(["kind": "fixtureClick", "time": Date().timeIntervalSince1970])
  }
  override func draw(_ dirtyRect: NSRect) {
    NSColor(calibratedRed: 0.06, green: 0.08, blue: 0.12, alpha: 1).setFill()
    bounds.fill()
    let attrs = textAttributes
    "PwrAgent • FICTIONAL WINDOW • no user data".draw(at: NSPoint(x: 20, y: bounds.height - 40), withAttributes: attrs)
    let offset = phase == "scroll" ? tick % 40 : 0
    for row in 0..<16 {
      let text = String(format: "%02d  const tile = { text: \"AaBb 0123 := <>\", ok: true };", row + offset)
      text.draw(at: NSPoint(x: 20, y: bounds.height - 75 - CGFloat(row * 23)), withAttributes: attrs)
    }
    let footer = phase == "typing" ? String(repeating: "abc123 ", count: (tick % 9) + 1) : inputText
    footer.draw(at: NSPoint(x: 20, y: 30), withAttributes: attrs)
    if ["motion", "obscured", "offscreen", "minimized", "restored"].contains(phase) {
      NSColor.systemOrange.setFill()
      NSRect(x: CGFloat((tick * 9) % 640), y: 75, width: 80, height: 80).fill()
      "FRAME \(tick)".draw(at: NSPoint(x: 20, y: 10), withAttributes: attrs)
    }
  }
}

let window = NSWindow(contentRect: NSRect(x: 100, y: 150, width: 800, height: 520),
  styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
window.title = "PwrAgent Capture Fixture — synthetic content only"
window.isReleasedWhenClosed = false
let fixture = FixtureView(frame: NSRect(x: 0, y: 0, width: 800, height: 520))
window.contentView = fixture
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(fixture)
app.activate(ignoringOtherApps: true)

final class EncodeStamp {
  let start = ProcessInfo.processInfo.systemUptime
  let phase: String
  let seq: Int
  init(_ phase: String, _ seq: Int) { self.phase = phase; self.seq = seq }
}

final class NativeEncoder {
  var session: VTCompressionSession?
  init(width: Int, height: Int) throws {
    let spec = [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true] as CFDictionary
    let status = VTCompressionSessionCreate(allocator: nil, width: Int32(width), height: Int32(height),
      codecType: kCMVideoCodecType_H264, encoderSpecification: spec, imageBufferAttributes: nil,
      compressedDataAllocator: nil, outputCallback: { _, stampPointer, status, flags, sample in
        guard let pointer = stampPointer else { return }
        let stamp = Unmanaged<EncodeStamp>.fromOpaque(pointer).takeRetainedValue()
        log(["kind": "encoded", "phase": stamp.phase, "seq": stamp.seq, "status": status,
          "dropped": flags.contains(.frameDropped), "bytes": sample.map { CMSampleBufferGetTotalSampleSize($0) } ?? 0,
          "captureCallbackToEncodeMs": (ProcessInfo.processInfo.systemUptime - stamp.start) * 1000])
      }, refcon: nil, compressionSessionOut: &session)
    guard status == noErr, let session = session else {
      throw NSError(domain: "VideoToolbox", code: Int(status))
    }
    for (key, value) in [
      (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue as CFTypeRef),
      (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse as CFTypeRef),
      (kVTCompressionPropertyKey_AverageBitRate, 1500000 as CFNumber),
      (kVTCompressionPropertyKey_MaxKeyFrameInterval, 60 as CFNumber),
    ] {
      let result = VTSessionSetProperty(session, key: key, value: value)
      if result != noErr { throw NSError(domain: "VideoToolboxProperty", code: Int(result)) }
    }
    var hardware: Unmanaged<CFTypeRef>?
    VTSessionCopyProperty(session, key: kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
      allocator: nil, valueOut: &hardware)
    log(["kind": "encoder", "hardware": String(describing: hardware?.takeRetainedValue()), "codec": "H264", "bitrate": 1500000])
  }
  func encode(_ buffer: CVPixelBuffer, pts: CMTime, phase: String, seq: Int) {
    guard let session else { return }
    let stamp = Unmanaged.passRetained(EncodeStamp(phase, seq)).toOpaque()
    let status = VTCompressionSessionEncodeFrame(session, imageBuffer: buffer, presentationTimeStamp: pts,
      duration: .invalid, frameProperties: nil, sourceFrameRefcon: stamp, infoFlagsOut: nil)
    if status != noErr {
      Unmanaged<EncodeStamp>.fromOpaque(stamp).release()
      log(["kind": "encodeError", "status": status])
    }
  }
  func finish() {
    if let session { VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid); VTCompressionSessionInvalidate(session) }
    session = nil
  }
}

final class Sink: NSObject, SCStreamOutput, SCStreamDelegate {
  let context = CIContext()
  var seq = 0
  var phase = "idle"
  var savedPerPhase: [String: Int] = [:]
  var stream: SCStream?
  var encoder: NativeEncoder?
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    log(["kind": "stop", "error": error.localizedDescription])
  }
  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sampleBuffer.isValid else { return }
    let started = ProcessInfo.processInfo.systemUptime
    let info = (CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first ?? [:]
    let status = info[.status] as? Int ?? -1
    var row: [String: Any] = ["kind": "frame", "seq": seq, "phase": phase, "status": status,
      "captureTimeMs": Date().timeIntervalSince1970 * 1000,
      "pts": CMTimeGetSeconds(sampleBuffer.presentationTimeStamp),
      "dirtyRects": String(describing: info[.dirtyRects] ?? []),
      "contentRect": String(describing: info[.contentRect] ?? ""),
      "scaleFactor": info[.scaleFactor] ?? 0]
    // Save complete frames only. Limit disk use; capture callbacks still measured.
    if status == SCFrameStatus.complete.rawValue, let buffer = sampleBuffer.imageBuffer {
      row["width"] = CVPixelBufferGetWidth(buffer)
      row["height"] = CVPixelBufferGetHeight(buffer)
      encoder?.encode(buffer, pts: sampleBuffer.presentationTimeStamp, phase: phase, seq: seq)
      let saved = savedPerPhase[phase, default: 0]
      if encoder == nil && (saved < 90 || (inputConsumed && saved < 100)) {
        let file = String(format: "%@/%@-%05d.png", output, phase, seq)
        let ciImage = CIImage(cvPixelBuffer: buffer)
        if let cg = context.createCGImage(ciImage, from: ciImage.extent),
          let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: file) as CFURL, UTType.png.identifier as CFString, 1, nil) {
          CGImageDestinationAddImage(dest, cg, nil)
          CGImageDestinationFinalize(dest)
          row["file"] = URL(fileURLWithPath: file).lastPathComponent
          savedPerPhase[phase] = saved + 1
        }
      }
    }
    row["callbackMs"] = (ProcessInfo.processInfo.systemUptime - started) * 1000
    seq += 1
    log(row)
  }
}
let sink = Sink()
final class FixtureWindowDelegate: NSObject, NSWindowDelegate {
  func windowWillClose(_ notification: Notification) {
    Task { @MainActor in
      try? await sink.stream?.stopCapture()
      sink.encoder?.finish()
      app.terminate(nil)
    }
  }
}
let fixtureWindowDelegate = FixtureWindowDelegate()
window.delegate = fixtureWindowDelegate
let phases = ["idle", "typing", "scroll", "motion", "obscured", "offscreen", "minimized", "restored", "resized"]
var cover: NSWindow?
var timer: Timer?

Task { @MainActor in
  log(["kind": "permission", "screenCapturePreflight": CGPreflightScreenCaptureAccess(),
    "accessibilityTrusted": AXIsProcessTrusted(), "os": ProcessInfo.processInfo.operatingSystemVersionString])
  do {
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    guard let own = content.windows.first(where: { $0.windowID == CGWindowID(window.windowNumber)
      && $0.owningApplication?.processID == getpid() }) else {
      throw NSError(domain: "Fixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "Own fixture window unavailable"])
    }
    let config = SCStreamConfiguration()
    let scale = Double(ProcessInfo.processInfo.environment["FIXTURE_SCALE"] ?? "1") ?? 1
    config.width = Int(800 * scale)
    config.height = Int(548 * scale)
    config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
    config.queueDepth = 3
    config.pixelFormat = kCVPixelFormatType_32BGRA
    config.showsCursor = false
    config.capturesAudio = false
    config.ignoreShadowsSingleWindow = true
    if ProcessInfo.processInfo.environment["FIXTURE_ENCODER"] == "vt" {
      sink.encoder = try NativeEncoder(width: config.width, height: config.height)
    }
    let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: own), configuration: config, delegate: sink)
    sink.stream = stream
    try stream.addStreamOutput(sink, type: .screen, sampleHandlerQueue: .main)
    try await stream.startCapture()
    log(["kind": "start", "windowID": own.windowID, "pid": getpid(), "scale": scale])
    let start = ProcessInfo.processInfo.systemUptime
    var last = -1
    timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { _ in
      let elapsed = ProcessInfo.processInfo.systemUptime - start
      let index = inputPath == nil ? Int(elapsed / 4) : (elapsed < 180 ? 0 : phases.count)
      if let path = inputPath, let session = inputSession, !inputConsumed,
        let data = try? Data(contentsOf: URL(fileURLWithPath: path)), data.count <= 4096,
        let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
        // Explicitly selected file; one fixed action inside this owned fixture.
        // This is an app-helper experiment, NOT OS input injection/authentication.
        inputConsumed = true
        let valid = command["sessionId"] as? String == session
          && command["sceneId"] as? String == "synthetic-app-window"
          && command["epoch"] as? Int == 1 && command["inputSeq"] as? Int == 0
          && command["action"] as? String == "fixture-toggle"
        if valid {
          fixture.inputText = "REMOTE FIXTURE COMMAND ACCEPTED"
          fixture.needsDisplay = true
        }
        log(["kind": "remoteFixtureInput", "accepted": valid, "timeMs": Date().timeIntervalSince1970 * 1000])
      }
      if index >= phases.count {
        timer?.invalidate()
        Task { @MainActor in
          try? await stream.stopCapture()
          sink.encoder?.finish()
          log(["kind": "done"])
          app.terminate(nil)
        }
        return
      }
      if last != index {
        last = index
        sink.phase = phases[index]
        fixture.phase = phases[index]
        log(["kind": "phase", "phase": phases[index], "time": Date().timeIntervalSince1970])
        if phases[index] == "obscured" {
          cover = NSWindow(contentRect: window.frame.insetBy(dx: -20, dy: -20), styleMask: [.borderless], backing: .buffered, defer: false)
          cover?.backgroundColor = .systemBlue
          cover?.level = .floating
          cover?.orderFront(nil)
        } else { cover?.orderOut(nil) }
        if phases[index] == "offscreen" { window.setFrameOrigin(NSPoint(x: -2000, y: 150)) }
        if phases[index] == "minimized" { window.setFrameOrigin(NSPoint(x: 100, y: 150)); window.miniaturize(nil) }
        if phases[index] == "restored" { window.deminiaturize(nil) }
        if phases[index] == "resized" { window.setContentSize(NSSize(width: 640, height: 400)) }
      }
      fixture.tick += 1
      if fixture.phase != "idle" { fixture.needsDisplay = true }
    }
  } catch {
    log(["kind": "error", "error": error.localizedDescription])
    app.terminate(nil)
  }
}
app.run()
