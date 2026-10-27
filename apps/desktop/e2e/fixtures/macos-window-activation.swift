// Native activation for the isolated E2E Electron PID, never a generic bundle.
import AppKit
import Carbon
import CoreGraphics

let mode = CommandLine.arguments[1]
if mode == "finder" {
  guard let target = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first else { exit(2) }
  print(target.processIdentifier)
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
