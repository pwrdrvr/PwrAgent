import AppKit
@preconcurrency import ScreenCaptureKit
import CoreMedia
import CoreImage
import ImageIO
import UniformTypeIdentifiers
import VideoToolbox

// A live, owned-window source. stdin is a private parent pipe, NOT a network API.
// The parent enforces peer/session/epoch/grants before forwarding fixture input.
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let outputLock = NSLock()
func emit(_ value: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
  outputLock.lock(); defer { outputLock.unlock() }
  FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}
final class LiveView: NSView {
  var tick = 0, revision = 0, offset = 0
  var motion = false
  var text = "Click the remote canvas, type here, or scroll the rows"
  let attrs: [NSAttributedString.Key: Any] = [
    .font: NSFont(name: "Menlo", size: 15)!, .foregroundColor: NSColor.white,
  ]
  override var acceptsFirstResponder: Bool { true }
  override func draw(_ dirtyRect: NSRect) {
    NSColor(calibratedRed: 0.06, green: 0.08, blue: 0.12, alpha: 1).setFill(); bounds.fill()
    "LIVE • OWNED FIXTURE • no private content".draw(at: NSPoint(x: 20, y: 480), withAttributes: attrs)
    for row in 0..<15 {
      String(format: "%03d const sample = { text: \"AaBb 0123 := <>\", ok: true };", row + offset)
        .draw(at: NSPoint(x: 20, y: 445 - row * 24), withAttributes: attrs)
    }
    text.draw(at: NSPoint(x: 20, y: 45), withAttributes: attrs)
    "INPUT REVISION \(revision) • FRAME \(tick)".draw(at: NSPoint(x: 20, y: 24), withAttributes: attrs)
    // Big luminance cells survive H264. The viewer verifies these actual pixels,
    // never a capture callback's metadata, before timing a visible input response.
    for bit in 0..<12 {
      (revision & (1 << bit) != 0 ? NSColor.white : NSColor.black).setFill()
      NSRect(x: 20 + bit * 16, y: 2, width: 16, height: 16).fill()
    }
    if motion { NSColor.systemOrange.setFill(); NSRect(x: (tick * 7) % 620, y: 85, width: 80, height: 45).fill() }
  }
  func command(_ c: [String: Any]) {
    guard let action = c["action"] as? String else { return }
    switch action {
    case "text":
      guard let value = c["text"] as? String, value.utf8.count <= 128 else { return }
      text = String((text + value).suffix(72))
    case "key":
      guard c["key"] as? String == "Backspace" else { return }
      if !text.isEmpty { text.removeLast() }
    case "click":
      guard let x = c["x"] as? Double, let y = c["y"] as? Double,
        x.isFinite, y.isFinite, x >= 0, x <= 1, y >= 0, y <= 1 else { return }
      text = String(format: "Fixture point %.3f, %.3f", x, y)
    case "scroll":
      guard let lines = c["lines"] as? Int, abs(lines) <= 20 else { return }
      offset = max(0, min(999, offset + lines))
    case "motion": motion = c["enabled"] as? Bool ?? false
    default: return
    }
    revision = (revision + 1) % 4096
    needsDisplay = true
    emit(["kind": "input", "revision": revision])
  }
}
let window = NSWindow(contentRect: NSRect(x: 100, y: 150, width: 800, height: 520),
  styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
window.title = "PwrAgent LIVE capture fixture — close to revoke"
window.isReleasedWhenClosed = false
let view = LiveView(frame: NSRect(x: 0, y: 0, width: 800, height: 520))
window.contentView = view
window.makeKeyAndOrderFront(nil)
// Never activates another user's app or sends global key events.
final class Stamp {
  let requestId: String
  let seq: Int, captureMs: Double, start = ProcessInfo.processInfo.systemUptime
  init(_ seq: Int, _ captureMs: Double, _ requestId: String) { self.seq = seq; self.captureMs = captureMs; self.requestId = requestId }
}
final class Source: NSObject, SCStreamOutput, SCStreamDelegate {
  var stream: SCStream?, encoder: VTCompressionSession?
  var latest: CVPixelBuffer?, latestMs = 0.0, changedMs = 0.0, version = 0, sentVersion = -1, repairedVersion = -1
  var requestId = ""
  var credit = false, key = true, busy = false, stopped = false, paused = false, seq = 0
  let context = CIContext()
  func startEncoder(_ width: Int, _ height: Int) throws {
    let status = VTCompressionSessionCreate(allocator: nil, width: Int32(width), height: Int32(height),
      codecType: kCMVideoCodecType_H264,
      encoderSpecification: [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true] as CFDictionary,
      imageBufferAttributes: nil, compressedDataAllocator: nil,
      outputCallback: { ref, stampRef, status, _, sample in
        guard let ref, let stampRef else { return }
        let source = Unmanaged<Source>.fromOpaque(ref).takeUnretainedValue()
        let stamp = Unmanaged<Stamp>.fromOpaque(stampRef).takeRetainedValue()
        if status == noErr, let sample, let block = sample.dataBuffer, let format = sample.formatDescription {
          let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
          let key = attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool != true
          var bytes = Data(), codec = ""
          if key {
            for index in 0..<2 {
              var pointer: UnsafePointer<UInt8>?, length = 0, count = 0, nalLength: Int32 = 0
              if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index,
                parameterSetPointerOut: &pointer, parameterSetSizeOut: &length,
                parameterSetCountOut: &count, nalUnitHeaderLengthOut: &nalLength) == noErr, let pointer {
                bytes.append(contentsOf: [0, 0, 0, 1]); bytes.append(pointer, count: length)
                if index == 0 && length >= 4 { codec = String(format: "avc1.%02X%02X%02X", pointer[1], pointer[2], pointer[3]) }
              }
            }
          }
          let avccLength = CMBlockBufferGetDataLength(block)
          var avcc = Data(count: avccLength)
          let copied = avcc.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: avccLength, destination: $0.baseAddress!) }
          if copied == noErr {
            var i = 0
            while i + 4 <= avcc.count {
              let length = avcc[i..<i+4].reduce(0) { ($0 << 8) | Int($1) }; i += 4
              guard length > 0 && i + length <= avcc.count else { break }
              bytes.append(contentsOf: [0, 0, 0, 1]); bytes.append(avcc[i..<i+length]); i += length
            }
            emit(["kind": "frame", "requestId": stamp.requestId, "seq": stamp.seq, "captureMs": stamp.captureMs,
              "encodeMs": (ProcessInfo.processInfo.systemUptime - stamp.start) * 1000,
              "codec": codec, "format": "h264", "key": key, "width": 800, "height": 548,
              "data": bytes.base64EncodedString()])
          }
        } else { emit(["kind": "error", "message": "VT encode failed \(status)"]) }
        DispatchQueue.main.async { source.busy = false; source.produce() }
      }, refcon: Unmanaged.passUnretained(self).toOpaque(), compressionSessionOut: &encoder)
    guard status == noErr, let encoder else { throw NSError(domain: "VT", code: Int(status)) }
    for (key, value) in [
      (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue as CFTypeRef),
      (kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse as CFTypeRef),
      (kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_Baseline_AutoLevel),
      (kVTCompressionPropertyKey_AverageBitRate, 1500000 as CFNumber),
      (kVTCompressionPropertyKey_MaxKeyFrameInterval, 60 as CFNumber),
    ] {
      let result = VTSessionSetProperty(encoder, key: key, value: value)
      guard result == noErr else { throw NSError(domain: "VT property", code: Int(result)) }
    }
    var hardware: Unmanaged<CFTypeRef>?
    VTSessionCopyProperty(encoder, key: kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder, allocator: nil, valueOut: &hardware)
    emit(["kind": "encoder", "hardware": String(describing: hardware?.takeRetainedValue())])
  }
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    stopped = true; emit(["kind": "error", "message": error.localizedDescription])
  }
  func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
    guard !stopped, type == .screen, sample.isValid else { return }
    let info = (CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first
    let status = info?[.status] as? Int ?? -1
    if status == SCFrameStatus.complete.rawValue, let buffer = sample.imageBuffer {
      if paused { paused = false; emit(["kind": "resumed"]) }
      if let previous = latest, !key {
        CVPixelBufferLockBaseAddress(previous, .readOnly); CVPixelBufferLockBaseAddress(buffer, .readOnly)
        var equal = CVPixelBufferGetWidth(previous) == CVPixelBufferGetWidth(buffer)
          && CVPixelBufferGetHeight(previous) == CVPixelBufferGetHeight(buffer)
        if equal, let a = CVPixelBufferGetBaseAddress(previous), let b = CVPixelBufferGetBaseAddress(buffer) {
          for row in 0..<CVPixelBufferGetHeight(buffer) {
            if memcmp(a.advanced(by: row * CVPixelBufferGetBytesPerRow(previous)),
              b.advanced(by: row * CVPixelBufferGetBytesPerRow(buffer)), CVPixelBufferGetWidth(buffer) * 4) != 0 { equal = false; break }
          }
        } else { equal = false }
        CVPixelBufferUnlockBaseAddress(buffer, .readOnly); CVPixelBufferUnlockBaseAddress(previous, .readOnly)
        if equal { latest = buffer; latestMs = Date().timeIntervalSince1970 * 1000; return }
      }
      latest = buffer; latestMs = Date().timeIntervalSince1970 * 1000; changedMs = latestMs; version += 1; produce()
    } else if status == SCFrameStatus.suspended.rawValue { paused = true; emit(["kind": "paused"]) }
  }
  func produce() {
    guard credit, !busy, !stopped, !paused, version != sentVersion, let latest, let encoder else { return }
    credit = false; busy = true; sentVersion = version
    let stamp = Unmanaged.passRetained(Stamp(seq, latestMs, requestId)); seq += 1
    let properties = key ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
    key = false
    let result = VTCompressionSessionEncodeFrame(encoder, imageBuffer: latest,
      presentationTimeStamp: CMTime(value: Int64(seq), timescale: 30), duration: .invalid,
      frameProperties: properties, sourceFrameRefcon: stamp.toOpaque(), infoFlagsOut: nil)
    if result != noErr { stamp.release(); busy = false; emit(["kind": "error", "message": "VT submit \(result)"]) }
  }
  func repairIfSettled() {
    guard credit, !busy, !stopped, !paused, sentVersion == version, repairedVersion != version,
      Date().timeIntervalSince1970 * 1000 - changedMs > 500, let latest else { return }
    let start = ProcessInfo.processInfo.systemUptime
    let data = NSMutableData()
    if let cg = context.createCGImage(CIImage(cvPixelBuffer: latest), from: CGRect(x: 0, y: 0, width: 800, height: 548)),
      let dest = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) {
      CGImageDestinationAddImage(dest, cg, nil)
      guard CGImageDestinationFinalize(dest) else { return }
      credit = false; repairedVersion = version
      emit(["kind": "frame", "requestId": requestId, "seq": seq, "format": "png", "key": false,
        "data": (data as Data).base64EncodedString(), "captureMs": latestMs,
        "encodeMs": (ProcessInfo.processInfo.systemUptime - start) * 1000,
        "width": 800, "height": 548])
      seq += 1
    }
  }
  func request(_ c: [String: Any]) {
    if c["kind"] as? String == "input" { view.command(c); return }
    if c["kind"] as? String == "stop" { stop(); return }
    guard c["kind"] as? String == "next" else { return }
    if c["key"] as? Bool == true { key = true; sentVersion = -1; repairedVersion = -1 }
    requestId = c["requestId"] as? String ?? ""
    credit = true; produce()
  }
  func stop() {
    stopped = true
    Task { @MainActor in
      try? await stream?.stopCapture()
      if let encoder { VTCompressionSessionCompleteFrames(encoder, untilPresentationTimeStamp: .invalid); VTCompressionSessionInvalidate(encoder) }
      emit(["kind": "done"]); app.terminate(nil)
    }
  }
}
let source = Source()
final class WindowDelegate: NSObject, NSWindowDelegate {
  func windowWillClose(_ notification: Notification) { source.stop() }
}
let delegate = WindowDelegate(); window.delegate = delegate
DispatchQueue.global().async {
  while let line = readLine() {
    guard line.utf8.count <= 4096, let data = line.data(using: .utf8),
      let c = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
    DispatchQueue.main.async { source.request(c) }
  }
  DispatchQueue.main.async { source.stop() }
}
var motionTimer: Timer?
Task { @MainActor in
  do {
    guard CGPreflightScreenCaptureAccess() else {
      emit(["kind": "error", "message": "Screen Recording permission required for launching app; approve in macOS Privacy & Security"])
      source.stop(); return
    }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    guard let own = content.windows.first(where: { $0.windowID == CGWindowID(window.windowNumber) && $0.owningApplication?.processID == getpid() }) else {
      throw NSError(domain: "Own fixture unavailable", code: 1)
    }
    let config = SCStreamConfiguration()
    config.width = 800; config.height = 548; config.queueDepth = 3
    config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
    config.pixelFormat = kCVPixelFormatType_32BGRA
    config.showsCursor = false; config.capturesAudio = false; config.ignoreShadowsSingleWindow = true
    try source.startEncoder(800, 548)
    let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: own), configuration: config, delegate: source)
    source.stream = stream; try stream.addStreamOutput(source, type: .screen, sampleHandlerQueue: .main)
    try await stream.startCapture()
    motionTimer = Timer.scheduledTimer(withTimeInterval: 1.0/30, repeats: true) { _ in
      if view.motion { view.tick += 1; view.needsDisplay = true }
      source.repairIfSettled()
    }
    emit(["kind": "ready", "width": 800, "height": 548])
  } catch { emit(["kind": "error", "message": error.localizedDescription]); source.stop() }
}
app.run()
