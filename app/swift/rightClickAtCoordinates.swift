#!/usr/bin/swift

import Cocoa
import Foundation

// Usage: swift rightClickAtCoordinates.swift <x> <y>
// Performs a right-click at the specified top-left origin screen coordinates

func rightClickAt(x: Int, y: Int) {
  let mainDisplayId = CGMainDisplayID()
  let screenWidthPx: CGFloat = CGFloat(CGDisplayPixelsWide(mainDisplayId))
  let screenHeightPx: CGFloat = CGFloat(CGDisplayPixelsHigh(mainDisplayId))

  let screenPts = NSScreen.main?.frame.size ?? CGSize(width: screenWidthPx / 2.0, height: screenHeightPx / 2.0)
  let screenWidthPts = screenPts.width
  let screenHeightPts = screenPts.height

  // Clamp inputs
  let clampedXPt = max(0, min(Int(screenWidthPts) - 1, x))
  let clampedYPtTopLeft = max(0, min(Int(screenHeightPts) - 1, y))

  // Convert top-left origin points to bottom-left origin pixels
  let scaleX = screenWidthPx / screenWidthPts
  let scaleY = screenHeightPx / screenHeightPts
  let targetXPx = CGFloat(clampedXPt) * scaleX
  let targetYPx = (screenHeightPts - CGFloat(clampedYPtTopLeft)) * scaleY

  let targetPoint = CGPoint(x: Int(round(targetXPx)), y: Int(round(targetYPx)))

  guard let mouseDown = CGEvent(
    mouseEventSource: nil,
    mouseType: .rightMouseDown,
    mouseCursorPosition: targetPoint,
    mouseButton: .right
  ) else {
    fputs("Failed to create right mouse down event\n", stderr)
    exit(1)
  }

  guard let mouseUp = CGEvent(
    mouseEventSource: nil,
    mouseType: .rightMouseUp,
    mouseCursorPosition: targetPoint,
    mouseButton: .right
  ) else {
    fputs("Failed to create right mouse up event\n", stderr)
    exit(1)
  }

  mouseDown.post(tap: .cghidEventTap)
  Thread.sleep(forTimeInterval: 0.05)
  mouseUp.post(tap: .cghidEventTap)

  print("{\"rightClicked\":true,\"x\":\(clampedXPt),\"y\":\(clampedYPtTopLeft)}")
}

guard CommandLine.arguments.count == 3 else {
  print("Usage: swift rightClickAtCoordinates.swift <x> <y>")
  exit(1)
}

guard let x = Int(CommandLine.arguments[1]), let y = Int(CommandLine.arguments[2]) else {
  print("Invalid coordinates. Please provide integers.")
  exit(1)
}

rightClickAt(x: x, y: y) 