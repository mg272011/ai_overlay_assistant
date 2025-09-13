#!/usr/bin/swift

import Cocoa
import Foundation

// Usage: swift dragAndDrop.swift <startX> <startY> <endX> <endY> [durationSeconds]

func toQuartz(_ x: Int, _ yTopLeft: Int) -> CGPoint {
  let mainDisplayId = CGMainDisplayID()
  let screenWidthPx: CGFloat = CGFloat(CGDisplayPixelsWide(mainDisplayId))
  let screenHeightPx: CGFloat = CGFloat(CGDisplayPixelsHigh(mainDisplayId))
  let screenPts = NSScreen.main?.frame.size ?? CGSize(width: screenWidthPx / 2.0, height: screenHeightPx / 2.0)
  let screenWidthPts = screenPts.width
  let screenHeightPts = screenPts.height

  let scaleX = screenWidthPx / screenWidthPts
  let scaleY = screenHeightPx / screenHeightPts

  let clampedXPt = max(0, min(Int(screenWidthPts) - 1, x))
  let clampedYPtTopLeft = max(0, min(Int(screenHeightPts) - 1, yTopLeft))
  let targetXPx = CGFloat(clampedXPt) * scaleX
  let targetYPx = (screenHeightPts - CGFloat(clampedYPtTopLeft)) * scaleY
  return CGPoint(x: Int(round(targetXPx)), y: Int(round(targetYPx)))
}

func dragAndDrop(startX: Int, startY: Int, endX: Int, endY: Int, duration: Double) {
  let start = toQuartz(startX, startY)
  let end = toQuartz(endX, endY)

  guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left) else {
    fputs("Failed to create mouse down event\n", stderr)
    exit(1)
  }
  down.post(tap: .cghidEventTap)

  let steps = max(1, Int(duration * 60.0))
  for i in 1...steps {
    let t = Double(i) / Double(steps)
    let x = CGFloat(Double(start.x) + (Double(end.x - start.x) * t))
    let y = CGFloat(Double(start.y) + (Double(end.y - start.y) * t))
    if let drag = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left) {
      drag.post(tap: .cghidEventTap)
    }
    if i < steps {
      Thread.sleep(forTimeInterval: 1.0 / 60.0)
    }
  }

  if let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left) {
    up.post(tap: .cghidEventTap)
  }

  print("{\"dragged\":true,\"from\":[\(startX),\(startY)],\"to\":[\(endX),\(endY)],\"duration\":\(duration)}")
}

guard CommandLine.arguments.count >= 5 else {
  print("Usage: swift dragAndDrop.swift <startX> <startY> <endX> <endY> [durationSeconds]")
  exit(1)
}

guard let sx = Int(CommandLine.arguments[1]),
      let sy = Int(CommandLine.arguments[2]),
      let ex = Int(CommandLine.arguments[3]),
      let ey = Int(CommandLine.arguments[4]) else {
  print("Invalid coordinates. Provide integers for startX startY endX endY.")
  exit(1)
}

let duration = CommandLine.arguments.count > 5 ? (Double(CommandLine.arguments[5]) ?? 0.2) : 0.2

dragAndDrop(startX: sx, startY: sy, endX: ex, endY: ey, duration: duration) 