#!/usr/bin/swift

import Cocoa
import Foundation

// Usage: swift scrollAtCoordinates.swift <x> <y> <deltaX> <deltaY>
// Positive deltaY scrolls up, negative scrolls down (typical)

func scrollAt(x: Int, y: Int, deltaX: Int32, deltaY: Int32) {
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

  guard let scrollEvent = CGEvent(scrollWheelEvent2Source: nil,
                                  units: .pixel,
                                  wheelCount: 2,
                                  wheel1: Int32(-deltaY), // wheel1 is vertical; invert to match natural scrolling
                                  wheel2: Int32(deltaX),
                                  wheel3: 0) else {
    fputs("Failed to create scroll event\n", stderr)
    exit(1)
  }

  scrollEvent.location = targetPoint
  scrollEvent.post(tap: .cghidEventTap)

  print("{\"scrolled\":true,\"x\":\(clampedXPt),\"y\":\(clampedYPtTopLeft),\"dx\":\(deltaX),\"dy\":\(deltaY)}")
}

guard CommandLine.arguments.count == 5 else {
  print("Usage: swift scrollAtCoordinates.swift <x> <y> <deltaX> <deltaY>")
  exit(1)
}

guard let x = Int(CommandLine.arguments[1]),
      let y = Int(CommandLine.arguments[2]),
      let dx = Int32(CommandLine.arguments[3]),
      let dy = Int32(CommandLine.arguments[4]) else {
  print("Invalid arguments. Provide integers for x y deltaX deltaY.")
  exit(1)
}

scrollAt(x: x, y: y, deltaX: dx, deltaY: dy) 