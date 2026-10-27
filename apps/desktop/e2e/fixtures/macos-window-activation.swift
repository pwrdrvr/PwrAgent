// Native activation for the isolated E2E Electron PID, never a generic bundle.
import AppKit
import ApplicationServices
import Carbon
import CoreGraphics

let mode = CommandLine.arguments[1]
if mode == "finder" {
  guard let target = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first else { exit(2) }
  print(target.processIdentifier)
} else if mode == "frontmost" {
  // The app that owns activation, for traces when a focus is not granted.
  let app = NSWorkspace.shared.frontmostApplication
  let row: [String: Any] = [
    "pid": app?.processIdentifier ?? -1,
    "bundle": app?.bundleIdentifier ?? NSNull(),
  ]
  print(String(data: try JSONSerialization.data(withJSONObject: row), encoding: .utf8)!)
} else if mode == "holder" {
  // Describe the app that holds activation: its on-screen windows and, when
  // this process is already trusted for Accessibility, the text they show.
  // Never prompts: a permission prompt is itself an alert that holds
  // activation.
  let app = NSWorkspace.shared.frontmostApplication
  let pid = app?.processIdentifier ?? -1
  let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  let windows: [[String: Any]] = rows.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }.map {
    [
      "layer": $0[kCGWindowLayer as String] ?? NSNull(),
      "name": $0[kCGWindowName as String] ?? NSNull(),
      "bounds": $0[kCGWindowBounds as String] ?? NSNull(),
    ]
  }
  var text: [String] = []
  let trusted = AXIsProcessTrusted()
  if trusted && pid > 0 {
    func collect(_ element: AXUIElement, _ depth: Int) {
      if depth > 8 || text.count >= 40 { return }
      for attribute in [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute] {
        var value: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
           let string = value as? String, !string.isEmpty {
          text.append(String(string.prefix(300)))
        }
      }
      var children: CFTypeRef?
      if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &children) == .success,
         let list = children as? [AXUIElement] {
        for child in list { collect(child, depth + 1) }
      }
    }
    collect(AXUIElementCreateApplication(pid), 0)
  }
  // An on-demand agent such as UserNotificationCenter starts to show its
  // alert, so its start time dates the alert.
  var info = kinfo_proc()
  var size = MemoryLayout<kinfo_proc>.stride
  var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
  let started: Any = sysctl(&mib, 4, &info, &size, nil, 0) == 0 && size > 0
    ? Double(info.kp_proc.p_un.__p_starttime.tv_sec) : NSNull()
  let row: [String: Any] = [
    "pid": pid,
    "startedAt": started,
    "bundle": app?.bundleIdentifier ?? NSNull(),
    "name": app?.localizedName ?? NSNull(),
    "windows": windows,
    "accessibilityTrusted": trusted,
    "text": text,
  ]
  print(String(data: try JSONSerialization.data(withJSONObject: row), encoding: .utf8)!)
} else {
  let pid = Int32(CommandLine.arguments[2])!
  if mode == "order" {
    let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let ids = rows.filter {
      ($0[kCGWindowOwnerPID as String] as? Int32) == pid
        && ($0[kCGWindowLayer as String] as? Int) == 0
    }.compactMap { $0[kCGWindowNumber as String] as? Int }
    print(String(data: try JSONSerialization.data(withJSONObject: ids), encoding: .utf8)!)
  } else {
    guard let target = NSRunningApplication(processIdentifier: pid) else { exit(3) }
    guard target.activate(options: [.activateIgnoringOtherApps]) else { exit(4) }
    if mode == "reopen" {
      let event = NSAppleEventDescriptor(
        eventClass: AEEventClass(kCoreEventClass),
        eventID: AEEventID(kAEReopenApplication),
        targetDescriptor: NSAppleEventDescriptor(processIdentifier: pid),
        returnID: AEReturnID(kAutoGenerateReturnID),
        transactionID: AETransactionID(kAnyTransactionID)
      )
      _ = try event.sendEvent(options: [.waitForReply], timeout: 5)
    }
  }
}
