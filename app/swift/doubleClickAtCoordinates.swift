#!/usr/bin/swift

import Cocoa
import Foundation

// Usage: swift doubleClickAtCoordinates.swift <x> <y>
// Performs a double left-click at the specified top-left origin screen coordinates

func doubleClickAt(x: Int, y: Int) {
  let mainDisplayId = CGMainDisplayID()
  let screenWidthPx: CGFloat = CGFloat(CGDisplayPixelsWide(mainDisplayId))
  let screenHeightPx: CGFloat = CGFloat(CGDisplayPixelsHigh(mainDisplayId))

  let screenPts = NSScreen.main?.frame.size ?? CGSize(width: screenWidthPx / 2.0, height: screenHeightPx / 2.0)
  let screenWidthPts = screenPts.width
  let screenHeightPts = screenPts.height

  let clampedXPt = max(0, min(Int(screenWidthPts) - 1, x))
  let clampedYPtTopLeft = max(0, min(Int(screenHeightPts) - 1, y))

  let scaleX = screenWidthPx / screenWidthPts
  let scaleY = screenHeightPx / screenHeightPts
  let targetXPx = CGFloat(clampedXPt) * scaleX
  let targetYPx = (screenHeightPts - CGFloat(clampedYPtTopLeft)) * scaleY

  let targetPoint = CGPoint(x: Int(round(targetXPx)), y: Int(round(targetYPx)))

  let events: [(CGEventType, CGMouseButton)] = [
    (.leftMouseDown, .left),
    (.leftMouseUp, .left),
    (.leftMouseDown, .left),
    (.leftMouseUp, .left)
  ]

  for (idx, pair) in events.enumerated() {
    guard let ev = CGEvent(
      mouseEventSource: nil,
      mouseType: pair.0,
      mouseCursorPosition: targetPoint,
      mouseButton: pair.1
    ) else {
      fputs("Failed to create mouse event at step \(idx)\n", stderr)
      exit(1)
    }
    if pair.0 == .leftMouseDown || pair.0 == .leftMouseUp {
      ev.setIntegerValueField(.mouseEventClickState, value: idx < 2 ? 1 : 2) // set click count
    }
    ev.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.04)
  }

  print("{\"doubleClicked\":true,\"x\":\(clampedXPt),\"y\":\(clampedYPtTopLeft)}")
}

guard CommandLine.arguments.count == 3 else {
  print("Usage: swift doubleClickAtCoordinates.swift <x> <y>")
  exit(1)
}

guard let x = Int(CommandLine.arguments[1]), let y = Int(CommandLine.arguments[2]) else {
  print("Invalid coordinates. Please provide integers.")
  exit(1)
}

doubleClickAt(x: x, y: y) 