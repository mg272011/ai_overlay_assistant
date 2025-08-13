#!/usr/bin/swift

import Foundation
import AppKit
import Vision
import CoreGraphics

// Usage: swift ocr.swift "Target Text"
// Outputs JSON: {"found":true, "x": <points>, "y": <points>} or {"found":false}

func captureMainDisplayCGImage() -> CGImage? {
    let displayId = CGMainDisplayID()
    return CGDisplayCreateImage(displayId)
}

func pointsFromPixel(xPx: CGFloat, yPxBottomLeft: CGFloat, screenWidthPts: CGFloat, screenHeightPts: CGFloat, widthPx: CGFloat, heightPx: CGFloat) -> (x: CGFloat, yTopLeft: CGFloat) {
    let scaleX = widthPx / screenWidthPts
    let scaleY = heightPx / screenHeightPts
    let xPts = xPx / scaleX
    let yPtsBottomLeft = yPxBottomLeft / scaleY
    // Convert to top-left origin in points
    let yPtsTopLeft = screenHeightPts - yPtsBottomLeft
    return (xPts, yPtsTopLeft)
}

func main() {
    guard CommandLine.arguments.count >= 2 else {
        print("{}")
        return
    }
    let target = CommandLine.arguments[1].trimmingCharacters(in: .whitespacesAndNewlines)
    guard !target.isEmpty else { print("{}"); return }

    guard let cgImage = captureMainDisplayCGImage() else {
        print("{\"found\":false}")
        return
    }
    let widthPx = CGFloat(cgImage.width)
    let heightPx = CGFloat(cgImage.height)

    let screenPts = NSScreen.main?.frame.size ?? CGSize(width: CGFloat(CGDisplayPixelsWide(CGMainDisplayID()))/2.0, height: CGFloat(CGDisplayPixelsHigh(CGMainDisplayID()))/2.0)
    let screenWidthPts = screenPts.width
    let screenHeightPts = screenPts.height

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .fast
    request.usesLanguageCorrection = false
    request.minimumTextHeight = 0.015 // heuristic

    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
        guard let observations = request.results as? [VNRecognizedTextObservation] else {
            print("{\"found\":false}")
            return
        }
        var best: (rect: CGRect, score: Float)? = nil
        let targetLower = target.lowercased()
        for obs in observations {
            guard let cand = obs.topCandidates(1).first else { continue }
            let textLower = cand.string.lowercased()
            if textLower.contains(targetLower) {
                let bbox = obs.boundingBox // normalized (0-1), origin bottom-left
                let rectPx = CGRect(
                    x: bbox.origin.x * widthPx,
                    y: bbox.origin.y * heightPx,
                    width: bbox.size.width * widthPx,
                    height: bbox.size.height * heightPx
                )
                let score = cand.confidence
                if best == nil || score > best!.score {
                    best = (rectPx, score)
                }
            }
        }
        if let b = best {
            // Click center
            let centerPx = CGPoint(x: b.rect.midX, y: b.rect.midY)
            let pts = pointsFromPixel(xPx: centerPx.x, yPxBottomLeft: centerPx.y, screenWidthPts: screenWidthPts, screenHeightPts: screenHeightPts, widthPx: widthPx, heightPx: heightPx)
            let json = String(format: "{\"found\":true,\"x\":%.0f,\"y\":%.0f}", pts.x, pts.yTopLeft)
            print(json)
            return
        } else {
            print("{\"found\":false}")
            return
        }
    } catch {
        print("{\"found\":false}")
        return
    }
}

main() 