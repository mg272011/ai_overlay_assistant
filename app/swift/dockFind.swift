#!/usr/bin/swift

import Cocoa
import ApplicationServices

struct DockItemInfo: Codable {
    let found: Bool
    let name: String?
    let x: Int?
    let y: Int?
    let w: Int?
    let h: Int?
    let error: String?
}

func jsonPrint(_ info: DockItemInfo) {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(info), let str = String(data: data, encoding: .utf8) {
        print(str)
    } else {
        print("{\"found\":false,\"error\":\"EncodingError\"}")
    }
}

func getAttribute<T>(_ element: AXUIElement, _ attribute: String, _ type: AXValueType) -> T? {
    var ref: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &ref)
    guard result == .success, let v = ref else { return nil }
    if CFGetTypeID(v) == AXValueGetTypeID() {
        var value = (T.self == CGPoint.self) ? CGPoint.zero as! T : (T.self == CGSize.self ? CGSize.zero as! T : CGRect.zero as! T)
        if AXValueGetType(v as! AXValue) == type {
            AXValueGetValue(v as! AXValue, type, &value)
            return value
        }
    }
    return nil
}

func findDockItem(root: AXUIElement, appName: String) -> (AXUIElement, String)? {
    // DFS over children to find AXDockItem with matching title
    var childrenRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(root, kAXChildrenAttribute as CFString, &childrenRef) != .success {
        return nil
    }
    guard let children = childrenRef as? [AXUIElement] else { return nil }

    for child in children {
        var roleRef: CFTypeRef?
        AXUIElementCopyAttributeValue(child, kAXRoleAttribute as CFString, &roleRef)
        let role = roleRef as? String ?? ""

        var titleRef: CFTypeRef?
        AXUIElementCopyAttributeValue(child, kAXTitleAttribute as CFString, &titleRef)
        let title = titleRef as? String ?? ""

        if role == "AXDockItem" {
            if !title.isEmpty {
                let lower = title.lowercased()
                let target = appName.lowercased()
                if lower == target || lower.contains(target) || target.contains(lower) {
                    return (child, title)
                }
            }
        }
        // Recurse
        if let found = findDockItem(root: child, appName: appName) {
            return found
        }
    }
    return nil
}

let args = CommandLine.arguments
if args.count < 2 {
    jsonPrint(DockItemInfo(found: false, name: nil, x: nil, y: nil, w: nil, h: nil, error: "Usage: dockFind.swift <AppName>"))
    exit(1)
}
let appName = args[1]

guard AXIsProcessTrusted() else {
    jsonPrint(DockItemInfo(found: false, name: nil, x: nil, y: nil, w: nil, h: nil, error: "AccessibilityNotTrusted"))
    exit(1)
}

guard let dockApp = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first else {
    jsonPrint(DockItemInfo(found: false, name: nil, x: nil, y: nil, w: nil, h: nil, error: "DockNotRunning"))
    exit(1)
}

let dockAX = AXUIElementCreateApplication(dockApp.processIdentifier)
if let (item, title) = findDockItem(root: dockAX, appName: appName) {
    if let pos: CGPoint = getAttribute(item, kAXPositionAttribute as String, .cgPoint),
       let size: CGSize = getAttribute(item, kAXSizeAttribute as String, .cgSize) {
        jsonPrint(DockItemInfo(found: true, name: title, x: Int(pos.x), y: Int(pos.y), w: Int(size.width), h: Int(size.height), error: nil))
        exit(0)
    } else {
        jsonPrint(DockItemInfo(found: true, name: title, x: nil, y: nil, w: nil, h: nil, error: "NoFrame"))
        exit(0)
    }
} else {
    jsonPrint(DockItemInfo(found: false, name: nil, x: nil, y: nil, w: nil, h: nil, error: "NotFound"))
    exit(0)
} 