#!/usr/bin/swift

import Cocoa
import Foundation

// Usage: swift clickAtCoordinates.swift <x> <y>
// This script clicks at the specified coordinates
// Input coordinates are assumed to be in top-left origin (like screenshots/UI),
// while CGEvent expects bottom-left origin. We convert accordingly.

func clickAt(x: Int, y: Int) {
    // Determine main screen size in points and pixels
    let mainDisplayId = CGMainDisplayID()

    var screenWidthPts: CGFloat = 0
    var screenHeightPts: CGFloat = 0
    let screenWidthPx: CGFloat = CGFloat(CGDisplayPixelsWide(mainDisplayId))
    let screenHeightPx: CGFloat = CGFloat(CGDisplayPixelsHigh(mainDisplayId))

    if let mainScreen = NSScreen.main {
        screenWidthPts = mainScreen.frame.width
        screenHeightPts = mainScreen.frame.height
    } else {
        // Fallback using CoreGraphics if NSScreen.main is unavailable
        let bounds = CGDisplayBounds(mainDisplayId)
        screenWidthPts = bounds.width
        screenHeightPts = bounds.height
    }

    // Guard against invalid values
    if screenWidthPts <= 0 || screenHeightPts <= 0 {
        fputs("Invalid screen size.\n", stderr)
        exit(1)
    }

    // Compute scale factors (pixels per point)
    let scaleX = screenWidthPx / screenWidthPts
    let scaleY = screenHeightPx / screenHeightPts

    // Clamp input to screen bounds (points)
    let clampedXPt = max(0, min(Int(screenWidthPts) - 1, x))
    let clampedYPtTopLeft = max(0, min(Int(screenHeightPts) - 1, y))

    // Convert from top-left origin (UI/screenshot in points) to bottom-left origin (Quartz in pixels)
    let targetXPx = CGFloat(clampedXPt) * scaleX
    let convertedYPx = (screenHeightPts - CGFloat(clampedYPtTopLeft)) * scaleY

    // Clamp in pixels
    let clampedXPx = max(0, min(Int(screenWidthPx) - 1, Int(round(targetXPx))))
    let clampedYPx = max(0, min(Int(screenHeightPx) - 1, Int(round(convertedYPx))))

    let targetPoint = CGPoint(x: clampedXPx, y: clampedYPx)

    // Create mouse down event
    guard let mouseDown = CGEvent(
        mouseEventSource: nil,
        mouseType: .leftMouseDown,
        mouseCursorPosition: targetPoint,
        mouseButton: .left
    ) else {
        fputs("Failed to create mouse down event\n", stderr)
        exit(1)
    }

    // Create mouse up event
    guard let mouseUp = CGEvent(
        mouseEventSource: nil,
        mouseType: .leftMouseUp,
        mouseCursorPosition: targetPoint,
        mouseButton: .left
    ) else {
        fputs("Failed to create mouse up event\n", stderr)
        exit(1)
    }

    // Post the events with a small delay
    mouseDown.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.05) // 50ms delay
    mouseUp.post(tap: .cghidEventTap)

    print("Clicked top-left pts (\(clampedXPt), \(clampedYPtTopLeft)) -> Quartz px (\(clampedXPx), \(clampedYPx)) on screen pts \(Int(screenWidthPts))x\(Int(screenHeightPts)), px \(Int(screenWidthPx))x\(Int(screenHeightPx))")
}

// Parse command line arguments
guard CommandLine.arguments.count == 3 else {
    print("Usage: swift clickAtCoordinates.swift <x> <y>")
    exit(1)
}

guard let x = Int(CommandLine.arguments[1]),
      let y = Int(CommandLine.arguments[2]) else {
    print("Invalid coordinates. Please provide integers.")
    exit(1)
}

// Perform the click
clickAt(x: x, y: y) 