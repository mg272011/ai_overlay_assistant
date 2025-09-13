#!/usr/bin/swift

import Cocoa
import ApplicationServices
import Foundation

// Usage: swift getWebAreaFrame.swift <bundleId>
// Prints JSON: {"x":number, "y":number, "width":number, "height":number}

struct StandardError: TextOutputStream {
  static let handle = FileHandle.standardError
  mutating func write(_ string: String) { Self.handle.write(Data(string.utf8)) }
}
var stderr = StandardError()

func getAttribute<T>(_ element: AXUIElement, _ attr: CFString, as type: AXValueType) -> T? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attr, &value) == .success, let v = value as? AXValue, AXValueGetType(v) == type else {
    return nil
  }
  var result: T? = nil
  switch type {
  case .cgRect:
    var rect = CGRect.zero
    if AXValueGetValue(v, .cgRect, &rect) { result = rect as? T }
  case .cgPoint:
    var pt = CGPoint.zero
    if AXValueGetValue(v, .cgPoint, &pt) { result = pt as? T }
  case .cgSize:
    var sz = CGSize.zero
    if AXValueGetValue(v, .cgSize, &sz) { result = sz as? T }
  default:
    break
  }
  return result
}

func role(of element: AXUIElement) -> String {
  var v: CFTypeRef?; AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &v)
  return (v as? String) ?? ""
}

func children(of element: AXUIElement) -> [AXUIElement] {
  var v: CFTypeRef?; AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &v)
  return (v as? [AXUIElement]) ?? []
}

func findAXWebArea(in element: AXUIElement) -> AXUIElement? {
  if role(of: element) == (kAXWebAreaRole as String) { return element }
  for c in children(of: element) { if let w = findAXWebArea(in: c) { return w } }
  return nil
}

guard CommandLine.arguments.count >= 2 else {
  print("Usage: swift swift/getWebAreaFrame.swift <bundleId>", to: &stderr)
  exit(1)
}
let bundleId = CommandLine.arguments[1]

guard AXIsProcessTrusted() else {
  print("{" + "\"error\":\"Accessibility not trusted\"}" )", to: &stderr)
  exit(2)
}

guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else {
  print("{" + "\"error\":\"App not running\"}" )", to: &stderr)
  exit(3)
}

let axApp = AXUIElementCreateApplication(app.processIdentifier)
var focusedWinRef: CFTypeRef?
if AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &focusedWinRef) != .success {
  print("{" + "\"error\":\"No focused window\"}" )", to: &stderr)
  exit(4)
}

guard let axWin = focusedWinRef as? AXUIElement else {
  print("{" + "\"error\":\"Focused window not found\"}" )", to: &stderr)
  exit(5)
}

guard let webArea = findAXWebArea(in: axWin) else {
  print("{" + "\"error\":\"AXWebArea not found\"}" )", to: &stderr)
  exit(6)
}

guard let frame: CGRect = getAttribute(webArea, kAXFrameAttribute as CFString, as: .cgRect) else {
  print("{" + "\"error\":\"AXFrame not available\"}" )", to: &stderr)
  exit(7)
}

let json: [String: Any] = [
  "x": Int(round(frame.origin.x)),
  "y": Int(round(frame.origin.y)),
  "width": Int(round(frame.size.width)),
  "height": Int(round(frame.size.height))
]
if let data = try? JSONSerialization.data(withJSONObject: json, options: []), let s = String(data: data, encoding: .utf8) {
  print(s)
} else {
  print("{" + "\"error\":\"Failed to encode JSON\"}" )", to: &stderr)
  exit(8)
} 