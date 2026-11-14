import Foundation
import CoreVideo
import Darwin

// One active worker and one replaceable snapshot. Capture/UI never wait for refinement.
final class TileEncoder: @unchecked Sendable {
  struct Work {
    let pixels: Data, versions: [Int], generation: Int, at: Double
    let preview: Bool
  }
  let lock = NSLock()
  let queue = DispatchQueue(label: "pwrwin.fixture.webp")
  var newest: Work?, running = false, stopped = false, generation = 0
  var previous = Data(), versions = Array(repeating: 0, count: 117)
  var encodedVersions = Array(repeating: 0, count: 117)
  var lastChange = 0.0
  let width = 800, height = 548, edge = 64
  let started = ProcessInfo.processInfo.systemUptime

  func submit(_ buffer: CVPixelBuffer) {
    guard CVPixelBufferGetWidth(buffer) == width, CVPixelBufferGetHeight(buffer) == height else { return }
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return }
    var pixels = Data(count: width * height * 4)
    pixels.withUnsafeMutableBytes { target in
      for y in 0..<height {
        memcpy(target.baseAddress!.advanced(by: y * width * 4), base.advanced(by: y * CVPixelBufferGetBytesPerRow(buffer)), width * 4)
      }
    }
    // Canonical straight-alpha BGRA for WebP (SCK buffers are premultiplied).
    pixels.withUnsafeMutableBytes { raw in
      let p = raw.bindMemory(to: UInt8.self)
      for i in stride(from: 0, to: p.count, by: 4) {
        let alpha = Int(p[i+3])
        if alpha < 255 { for c in 0..<3 { p[i+c] = alpha == 0 ? 0 : UInt8(min(255, (Int(p[i+c])*255+alpha/2)/alpha)) } }
      }
    }
    var dirty: [Int] = []
    for id in 0..<117 {
      let x = (id % 13) * edge, y = (id / 13) * edge
      let w = min(edge, width - x), h = min(edge, height - y)
      var equal = previous.count == pixels.count
      if equal {
        pixels.withUnsafeBytes { a in previous.withUnsafeBytes { b in
          for row in y..<y+h {
            let offset = (row * width + x) * 4
            if memcmp(a.baseAddress!.advanced(by: offset), b.baseAddress!.advanced(by: offset), w * 4) != 0 { equal = false; break }
          }
        } }
      }
      if !equal { dirty.append(id) }
    }
    guard !dirty.isEmpty else { return }
    generation += 1
    for id in dirty { versions[id] = generation }
    let now = ProcessInfo.processInfo.systemUptime
    let rapid = now - lastChange < 0.12
    let work = Work(pixels: pixels, versions: versions, generation: generation, at: now,
                    preview: dirty.count > 24 || rapid)
    previous = pixels; lastChange = now
    lock.lock()
    guard !stopped else { lock.unlock(); return }
    newest = work
    let start = !running; running = true
    lock.unlock()
    if start { queue.async { self.drain() } }
  }

  func current(_ work: Work) -> Bool {
    lock.lock(); defer { lock.unlock() }
    return !stopped && newest?.generation == work.generation
  }

  func encode(_ pixels: Data, x: Int, y: Int, w: Int, h: Int, stride: Int, lossless: Bool) -> Data? {
    var output: UnsafeMutablePointer<UInt8>?
    let size = pixels.withUnsafeBytes { data in
      pwrwin_webp(data.baseAddress!.advanced(by: y * stride + x * 4).assumingMemoryBound(to: UInt8.self),
                  Int32(w), Int32(h), Int32(stride), lossless ? 1 : 0, &output)
    }
    guard let output else { return nil }
    defer { pwrwin_webp_free(output) }
    guard size > 0 && size <= (lossless ? 32768 : 131072) else { return nil }
    return Data(bytes: output, count: size)
  }

  // Independent benchmark checksum of opaque RGB pixels BEFORE encoding.
  // Excludes alpha edges where browser canvas premultiplication can round values.
  func opaqueHash(_ pixels: Data, x: Int, y: Int, w: Int, h: Int) -> UInt32 {
    var hash: UInt32 = 2166136261
    pixels.withUnsafeBytes { raw in
      let p = raw.bindMemory(to: UInt8.self)
      for row in y..<y+h { for col in x..<x+w {
        let i = (row * width + col) * 4
        if p[i+3] == 255 { for c in [2, 1, 0] { hash = (hash ^ UInt32(p[i+c])) &* 16777619 } }
      } }
    }
    return hash
  }

  func drain() {
    var previewed = 0
    while true {
      lock.lock()
      guard !stopped, let work = newest else { running = false; lock.unlock(); return }
      lock.unlock()
      if previewed != work.generation {
        emit(["kind": "manifest", "generation": work.generation, "versions": work.versions, "preview": work.preview])
        if work.preview {
          let began = ProcessInfo.processInfo.systemUptime
          // Bounded box downsample: 800x548 -> 200x137, then fast lossy WebP.
          var small = Data(count: 200 * 137 * 4)
          small.withUnsafeMutableBytes { raw in
            let dst = raw.bindMemory(to: UInt8.self)
            work.pixels.withUnsafeBytes { source in
              let src = source.bindMemory(to: UInt8.self)
              for y in 0..<137 { for x in 0..<200 { for c in 0..<4 {
                var sum = 0
                for dy in 0..<4 { for dx in 0..<4 { sum += Int(src[((y*4+dy)*800+x*4+dx)*4+c]) } }
                dst[(y*200+x)*4+c] = UInt8(sum / 16)
              } } }
            }
          }
          if let bytes = encode(small, x: 0, y: 0, w: 200, h: 137, stride: 800, lossless: false), current(work) {
            emit(["kind": "image", "imageKind": 1, "id": 65535, "version": work.generation,
                  "versions": work.versions, "data": bytes.base64EncodedString(),
                  "encodeMs": (ProcessInfo.processInfo.systemUptime - began) * 1000])
          }
        }
        previewed = work.generation
      }
      if !current(work) { continue }
      if work.preview && ProcessInfo.processInfo.systemUptime - work.at < 0.12 { Thread.sleep(forTimeInterval: 0.005); continue }
      for id in 0..<117 {
        if !current(work) { break } // Cancel between bounded 64-pixel tile encodes.
        if encodedVersions[id] >= work.versions[id] { continue }
        let x = (id % 13) * edge, y = (id / 13) * edge
        let began = ProcessInfo.processInfo.systemUptime
        guard let bytes = encode(work.pixels, x: x, y: y, w: min(edge, width-x), h: min(edge, height-y), stride: width*4, lossless: true) else {
          emit(["kind": "error", "message": "WebP tile encoding failed"]); stop(); return
        }
        if !current(work) { break }
        emit(["kind": "image", "imageKind": 2, "id": id, "version": work.versions[id],
              "opaqueHash": opaqueHash(work.pixels, x: x, y: y, w: min(edge, width-x), h: min(edge, height-y)),
              "data": bytes.base64EncodedString(), "encodeMs": (ProcessInfo.processInfo.systemUptime - began) * 1000])
        encodedVersions[id] = work.versions[id]
      }
      lock.lock()
      if newest?.generation == work.generation { newest = nil }
      lock.unlock()
    }
  }
  func stop() {
    lock.lock()
    let first = !stopped
    stopped = true; newest = nil; lock.unlock()
    if first {
      var usage = rusage()
      if getrusage(RUSAGE_SELF, &usage) == 0 {
        emit(["kind": "resources", "wallSeconds": ProcessInfo.processInfo.systemUptime - started,
              "userSeconds": Double(usage.ru_utime.tv_sec) + Double(usage.ru_utime.tv_usec) / 1e6,
              "systemSeconds": Double(usage.ru_stime.tv_sec) + Double(usage.ru_stime.tv_usec) / 1e6,
              "maxRssBytes": usage.ru_maxrss])
      }
    }
  }
}
