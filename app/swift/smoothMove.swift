#!/usr/bin/swift

import Cocoa
import Foundation

// Usage: swift smoothMove.swift <targetX> <targetY> [duration] [tweening]
// Tweening options: linear, easeIn, easeOut, easeInOut (default: easeInOut)

enum Tweening {
    case linear
    case easeIn
    case easeOut
    case easeInOut
    
    func calculate(_ t: Double) -> Double {
        switch self {
        case .linear:
            return t
        case .easeIn:
            return t * t
        case .easeOut:
            return t * (2 - t)
        case .easeInOut:
            if t < 0.5 {
                return 2 * t * t
            } else {
                return -1 + (4 - 2 * t) * t
            }
        }
    }
}

func getScreenInfo() -> (widthPts: CGFloat, heightPts: CGFloat, widthPx: CGFloat, heightPx: CGFloat) {
    let mainDisplayId = CGMainDisplayID()
    let screenWidthPx = CGFloat(CGDisplayPixelsWide(mainDisplayId))
    let screenHeightPx = CGFloat(CGDisplayPixelsHigh(mainDisplayId))
    
    var screenWidthPts: CGFloat = 0
    var screenHeightPts: CGFloat = 0
    
    if let mainScreen = NSScreen.main {
        screenWidthPts = mainScreen.frame.width
        screenHeightPts = mainScreen.frame.height
    } else {
        // Fallback
        let bounds = CGDisplayBounds(mainDisplayId)
        screenWidthPts = bounds.width
        screenHeightPts = bounds.height
    }
    
    return (screenWidthPts, screenHeightPts, screenWidthPx, screenHeightPx)
}

func getCurrentMousePosition() -> CGPoint {
    return NSEvent.mouseLocation
}

func convertToQuartzCoordinates(point: CGPoint, screenHeight: CGFloat) -> CGPoint {
    // Convert from top-left origin to bottom-left origin for Quartz
    return CGPoint(x: point.x, y: screenHeight - point.y)
}

func smoothMoveTo(targetX: CGFloat, targetY: CGFloat, duration: Double, tweening: Tweening) {
    let screenInfo = getScreenInfo()
    
    // Get current position
    let currentPos = getCurrentMousePosition()
    let startX = currentPos.x
    let startY = currentPos.y
    
    // Target is in top-left coordinates, convert for movement
    let targetQuartz = convertToQuartzCoordinates(
        point: CGPoint(x: targetX, y: targetY),
        screenHeight: screenInfo.heightPts
    )
    
    // Calculate scale factors for pixel-perfect movement
    let scaleX = screenInfo.widthPx / screenInfo.widthPts
    let scaleY = screenInfo.heightPx / screenInfo.heightPts
    
    // Number of steps based on duration
    let fps = 60.0
    let steps = Int(duration * fps)
    let stepDuration = 1.0 / fps
    
    if steps <= 1 {
        // Instant movement
        let event = CGEvent(
            mouseEventSource: nil,
            mouseType: .mouseMoved,
            mouseCursorPosition: CGPoint(x: targetX * scaleX, y: targetQuartz.y * scaleY),
            mouseButton: .left
        )
        event?.post(tap: .cghidEventTap)
        print("{\"moved\": true, \"x\": \(targetX), \"y\": \(targetY), \"duration\": 0}")
        return
    }
    
    // Smooth movement with tweening
    for i in 0...steps {
        let progress = Double(i) / Double(steps)
        let easedProgress = tweening.calculate(progress)
        
        let currentX = startX + (targetX - startX) * easedProgress
        let currentY = startY + (targetQuartz.y - startY) * easedProgress
        
        let event = CGEvent(
            mouseEventSource: nil,
            mouseType: .mouseMoved,
            mouseCursorPosition: CGPoint(x: currentX * scaleX, y: currentY * scaleY),
            mouseButton: .left
        )
        event?.post(tap: .cghidEventTap)
        
        if i < steps {
            Thread.sleep(forTimeInterval: stepDuration)
        }
    }
    
    // Ensure we end exactly at target
    let finalEvent = CGEvent(
        mouseEventSource: nil,
        mouseType: .mouseMoved,
        mouseCursorPosition: CGPoint(x: targetX * scaleX, y: targetQuartz.y * scaleY),
        mouseButton: .left
    )
    finalEvent?.post(tap: .cghidEventTap)
    
    print("{\"moved\": true, \"x\": \(targetX), \"y\": \(targetY), \"duration\": \(duration)}")
}

// Parse command line arguments
guard CommandLine.arguments.count >= 3 else {
    print("{\"error\": \"Usage: swift smoothMove.swift <targetX> <targetY> [duration] [tweening]\"}")
    exit(1)
}

guard let targetX = Double(CommandLine.arguments[1]),
      let targetY = Double(CommandLine.arguments[2]) else {
    print("{\"error\": \"Invalid coordinates\"}")
    exit(1)
}

let duration = CommandLine.arguments.count > 3 ? Double(CommandLine.arguments[3]) ?? 0.5 : 0.5

var tweening = Tweening.easeInOut
if CommandLine.arguments.count > 4 {
    switch CommandLine.arguments[4].lowercased() {
    case "linear":
        tweening = .linear
    case "easein":
        tweening = .easeIn
    case "easeout":
        tweening = .easeOut
    default:
        tweening = .easeInOut
    }
}

// Perform the smooth movement
smoothMoveTo(targetX: CGFloat(targetX), targetY: CGFloat(targetY), duration: duration, tweening: tweening) 