#!/usr/bin/env swift

import Foundation
import CoreGraphics
import AppKit

struct Point { 
    let x: CGFloat
    let y: CGFloat 
}

class AgentMouse {
    // Human-like mouse movement with Bezier curves
    static func humanMove(from: Point, to: Point, duration: TimeInterval = 0.6) {
        let steps = max(12, Int(240 * duration)) // more steps = smoother
        
        // Create control points for Bezier curve with randomness
        let ctrl1 = Point(
            x: from.x + (to.x - from.x) * 0.3 + CGFloat.random(in: -40...40),
            y: from.y + (to.y - from.y) * 0.1 + CGFloat.random(in: -40...40)
        )
        let ctrl2 = Point(
            x: from.x + (to.x - from.x) * 0.7 + CGFloat.random(in: -40...40),
            y: from.y + (to.y - from.y) * 0.9 + CGFloat.random(in: -40...40)
        )

        // Cubic Bezier curve calculation
        func bezier(_ t: CGFloat) -> Point {
            let u = 1 - t
            let x = u*u*u*from.x + 3*u*u*t*ctrl1.x + 3*u*t*t*ctrl2.x + t*t*t*to.x
            let y = u*u*u*from.y + 3*u*u*t*ctrl1.y + 3*u*t*t*ctrl2.y + t*t*t*to.y
            return Point(x: x, y: y)
        }

        let start = Date()
        for i in 0...steps {
            let t = CGFloat(i) / CGFloat(steps)
            var p = bezier(t)
            
            // Add tiny hand jitter for realism
            p = Point(
                x: p.x + CGFloat.random(in: -0.6...0.6),
                y: p.y + CGFloat.random(in: -0.6...0.6)
            )

            // Move the actual mouse cursor
            let move = CGEvent(
                mouseEventSource: nil,
                mouseType: .mouseMoved,
                mouseCursorPosition: CGPoint(x: p.x, y: p.y),
                mouseButton: .left
            )!
            move.post(tap: .cghidEventTap)

            // Human pacing with slight randomness
            let target = start.addingTimeInterval(duration * Double(t))
            let sleep = max(0, target.timeIntervalSinceNow) + Double.random(in: 0.000...0.002)
            if sleep > 0 { 
                usleep(useconds_t(sleep * 1_000_000))
            }
        }
    }

    // Natural click with variable delay
    static func click(downUpDelay: TimeInterval = 0.035) {
        let loc = CGEvent(source: nil)!.location
        
        // Mouse down
        let down = CGEvent(
            mouseEventSource: nil,
            mouseType: .leftMouseDown,
            mouseCursorPosition: loc,
            mouseButton: .left
        )!
        down.post(tap: .cghidEventTap)
        
        // Human-like delay between down and up
        usleep(useconds_t(downUpDelay * 1_000_000 + Double.random(in: 0...10_000)))
        
        // Mouse up
        let up = CGEvent(
            mouseEventSource: nil,
            mouseType: .leftMouseUp,
            mouseCursorPosition: loc,
            mouseButton: .left
        )!
        up.post(tap: .cghidEventTap)
    }
    
    // Right click
    static func rightClick(downUpDelay: TimeInterval = 0.035) {
        let loc = CGEvent(source: nil)!.location
        
        let down = CGEvent(
            mouseEventSource: nil,
            mouseType: .rightMouseDown,
            mouseCursorPosition: loc,
            mouseButton: .right
        )!
        down.post(tap: .cghidEventTap)
        
        usleep(useconds_t(downUpDelay * 1_000_000))
        
        let up = CGEvent(
            mouseEventSource: nil,
            mouseType: .rightMouseUp,
            mouseCursorPosition: loc,
            mouseButton: .right
        )!
        up.post(tap: .cghidEventTap)
    }
    
    // Double click
    static func doubleClick() {
        click(downUpDelay: 0.03)
        usleep(50_000) // 50ms between clicks
        click(downUpDelay: 0.03)
    }
    
    // Get current cursor position
    static func getPosition() -> Point {
        let loc = CGEvent(source: nil)!.location
        return Point(x: loc.x, y: loc.y)
    }
    
    // Scroll
    static func scroll(x: Int32 = 0, y: Int32 = 0) {
        let scrollEvent = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .pixel,
            wheelCount: 2,
            wheel1: y,
            wheel2: x,
            wheel3: 0
        )!
        scrollEvent.post(tap: .cghidEventTap)
    }
    
    // Type text with natural timing
    static func typeText(_ text: String, wpm: Int = 60) {
        let charDelay = 60.0 / (Double(wpm) * 5.0) // Average 5 chars per word
        
        for char in text {
            if let keyCode = keyCodeForChar(char) {
                // Key down
                let keyDown = CGEvent(
                    keyboardEventSource: nil,
                    virtualKey: CGKeyCode(keyCode),
                    keyDown: true
                )!
                keyDown.post(tap: .cghidEventTap)
                
                // Human-like key press duration
                usleep(useconds_t(20_000 + arc4random_uniform(30_000)))
                
                // Key up
                let keyUp = CGEvent(
                    keyboardEventSource: nil,
                    virtualKey: CGKeyCode(keyCode),
                    keyDown: false
                )!
                keyUp.post(tap: .cghidEventTap)
                
                // Delay between characters with variation
                let delay = charDelay + Double.random(in: -0.02...0.05)
                usleep(useconds_t(delay * 1_000_000))
            }
        }
    }
    
    // Helper function to map characters to key codes (simplified)
    static func keyCodeForChar(_ char: Character) -> UInt16? {
        let keyMap: [Character: UInt16] = [
            "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
            "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
            "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
            "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
            "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47,
            " ": 49, "`": 50, "\n": 36, "\t": 48
        ]
        return keyMap[char]
    }
}

// CLI interface
func main() {
    let args = CommandLine.arguments
    
    guard args.count > 1 else {
        print("Usage: AgentMouse <command> [args...]")
        print("Commands:")
        print("  move <x> <y> [duration]  - Move to position")
        print("  click                     - Left click")
        print("  rightclick                - Right click") 
        print("  doubleclick               - Double click")
        print("  position                  - Get current position")
        print("  scroll <x> <y>           - Scroll")
        print("  type <text>              - Type text")
        exit(1)
    }
    
    let command = args[1].lowercased()
    
    switch command {
    case "move":
        guard args.count >= 4 else {
            print("Error: move requires x and y coordinates")
            exit(1)
        }
        let x = CGFloat(Double(args[2]) ?? 0)
        let y = CGFloat(Double(args[3]) ?? 0)
        let duration = args.count > 4 ? Double(args[4]) ?? 0.6 : 0.6
        
        let current = AgentMouse.getPosition()
        AgentMouse.humanMove(from: current, to: Point(x: x, y: y), duration: duration)
        print("Moved to \(x), \(y)")
        
    case "click":
        AgentMouse.click()
        print("Clicked")
        
    case "rightclick":
        AgentMouse.rightClick()
        print("Right clicked")
        
    case "doubleclick":
        AgentMouse.doubleClick()
        print("Double clicked")
        
    case "position":
        let pos = AgentMouse.getPosition()
        print("\(pos.x),\(pos.y)")
        
    case "scroll":
        guard args.count >= 4 else {
            print("Error: scroll requires x and y values")
            exit(1)
        }
        let x = Int32(args[2]) ?? 0
        let y = Int32(args[3]) ?? 0
        AgentMouse.scroll(x: x, y: y)
        print("Scrolled \(x), \(y)")
        
    case "type":
        guard args.count >= 3 else {
            print("Error: type requires text")
            exit(1)
        }
        let text = args[2...].joined(separator: " ")
        AgentMouse.typeText(text)
        print("Typed: \(text)")
        
    default:
        print("Unknown command: \(command)")
        exit(1)
    }
}

main() 