#!/usr/bin/swift

import Cocoa
import Foundation

// Usage: swift hoverMove.swift <x> <y> [durationSeconds]

func toQuartzPoint(x: Int, yTopLeft: Int) -> CGPoint {
  let mainDisplayId = CGMainDisplayID()
  let screenWidthPx: CGFloat = CGFloat(CGDisplayPixelsWide(mainDisplayId))
  let screenHeightPx: CGFloat = CGFloat(CGDisplayPixelsHigh(mainDisplayId))
  let screenPts = NSScreen.main?.frame.size ?? CGSize(width: screenWidthPx / 2.0, height: screenHeightPx / 2.0)
  let scaleX = screenWidthPx / screenPts.width
  let scaleY = screenHeightPx / screenPts.height
  let clampedXPt = max(0, min(Int(screenPts.width) - 1, x))
  let clampedYPtTopLeft = max(0, min(Int(screenPts.height) - 1, yTopLeft))
  let targetXPx = CGFloat(clampedXPt) * scaleX
  let targetYPx = (screenPts.height - CGFloat(clampedYPtTopLeft)) * scaleY
  return CGPoint(x: Int(round(targetXPx)), y: Int(round(targetYPx)))
}

func getCurrentMousePosition() -> CGPoint {
  return NSEvent.mouseLocation
}

func moveMouse(to targetTopLeft: CGPoint, duration: Double) {
  let screenHeight = NSScreen.main?.frame.size.height ?? 1080
  let startTopLeft = getCurrentMousePosition()
  let steps = max(1, Int(duration * 60.0))

  for i in 1...steps {
    let t = Double(i) / Double(steps)
    let x = startTopLeft.x + (targetTopLeft.x - startTopLeft.x) * CGFloat(t)
    let y = startTopLeft.y + (targetTopLeft.y - startTopLeft.y) * CGFloat(t)
    let quartz = CGPoint(x: x, y: screenHeight - y)
    if let ev = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: quartz, mouseButton: .left) {
      ev.post(tap: .cghidEventTap)
    }
    if i < steps { Thread.sleep(forTimeInterval: 1.0 / 60.0) }
  }
}

guard CommandLine.arguments.count >= 3 else {
  print("Usage: swift hoverMove.swift <x> <y> [durationSeconds]")
  exit(1)
}

guard let x = Int(CommandLine.arguments[1]), let y = Int(CommandLine.arguments[2]) else {
  print("Invalid coordinates. Provide integers for x y.")
  exit(1)
}

let duration = CommandLine.arguments.count > 3 ? (Double(CommandLine.arguments[3]) ?? 0.2) : 0.2

let targetTopLeft = CGPoint(x: x, y: y)
moveMouse(to: targetTopLeft, duration: duration) 