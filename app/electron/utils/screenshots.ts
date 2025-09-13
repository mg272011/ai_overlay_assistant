import { desktopCapturer, screen } from "electron";
import { execPromise, logWithElapsed } from "./utils";
import { Window } from "../types";

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Shared helper for efficient screen capture
 */
export async function captureScreen(options?: { 
  maxWidth?: number; 
  maxHeight?: number;
  useDisplayScaling?: boolean;
}): Promise<{ image: Electron.NativeImage; base64: string }> {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.bounds;
  const scaleFactor = primaryDisplay.scaleFactor;

  // Use provided dimensions or optimize based on display
  const maxWidth = options?.maxWidth || (options?.useDisplayScaling ? width * scaleFactor : width);
  const maxHeight = options?.maxHeight || (options?.useDisplayScaling ? height * scaleFactor : height);

  const screenSources = await desktopCapturer.getSources({
    types: ["screen"],
    fetchWindowIcons: false,
    thumbnailSize: { width: maxWidth, height: maxHeight },
  });

  const primary = screenSources[0];
  if (!primary || primary.thumbnail.isEmpty()) {
    throw new Error("No screen source available");
  }

  const base64 = primary.thumbnail.toPNG().toString("base64");
  return { image: primary.thumbnail, base64 };
}

/**
 * Optimized screenshot function with fast path for fullscreen captures
 */
export async function takeAndSaveScreenshots(
  appName: string,
  stepFolder: string
) {
  logWithElapsed(
    "takeAndSaveScreenshots",
    `Taking screenshot for app: ${appName}`
  );

  // Fast path for fullscreen captures (most common case)
  if (appName === "Desktop") {
    return await takeFullscreenScreenshot(stepFolder);
  }

  // Specific app window capture (slower path)
  return await takeAppWindowScreenshot(appName, stepFolder);
}

/**
 * Fast fullscreen screenshot without window enumeration
 */
async function takeFullscreenScreenshot(stepFolder: string): Promise<string> {
  logWithElapsed("takeFullscreenScreenshot", "Capturing screen");
  
  const { base64: screenshotBase64 } = await captureScreen({ useDisplayScaling: true });
  
  logWithElapsed("takeFullscreenScreenshot", "Screen captured");

  // Save to disk for logging/debugging purposes
  const screenshotPath = path.join(stepFolder, "screenshot-Desktop.png");
  fs.writeFileSync(screenshotPath, Buffer.from(screenshotBase64, "base64"));
  
  logWithElapsed(
    "takeFullscreenScreenshot",
    `Saved fullscreen screenshot: ${screenshotPath}`
  );

  return screenshotBase64;
}

/**
 * App-specific window screenshot (original logic, but optimized)
 */
async function takeAppWindowScreenshot(appName: string, stepFolder: string): Promise<string> {
  // Get window information from Swift
  logWithElapsed("takeAppWindowScreenshot", "Getting Swift windows");
  const { stdout: swiftWindowsStdout } = await execPromise(
    `swift swift/windows.swift`
  );
  logWithElapsed("takeAppWindowScreenshot", "Got Swift windows");
  
  const swiftWindows = JSON.parse(swiftWindowsStdout).filter(
    (window: Window) => window.app === appName
  );

  if (swiftWindows.length === 0) {
    logWithElapsed("takeAppWindowScreenshot", `No windows found for ${appName}, falling back to fullscreen`);
    return await takeFullscreenScreenshot(stepFolder);
  }

  // Get window sources
  logWithElapsed("takeAppWindowScreenshot", "Getting window sources");
  const sources = await desktopCapturer.getSources({
    types: ["window"],
    fetchWindowIcons: false,
    thumbnailSize: { width: 1920, height: 1080 },
  });
  logWithElapsed("takeAppWindowScreenshot", "Got window sources");

  // Find matching windows
  const matchingPairs: Array<{ window: Window; source: any }> = [];
  for (const window of swiftWindows) {
    const source = sources.find(
      (s) => typeof s.name === "string" && s.name === window.name
    );
    if (source) {
      matchingPairs.push({ window, source });
    }
  }

  if (matchingPairs.length === 0) {
    logWithElapsed("takeAppWindowScreenshot", `No matching sources for ${appName}, falling back to fullscreen`);
    return await takeFullscreenScreenshot(stepFolder);
  }

  // Use the first matching window
  const { window, source } = matchingPairs[0];
  const image = source.thumbnail;
  
  if (image.isEmpty()) {
    logWithElapsed("takeAppWindowScreenshot", `Empty thumbnail for ${appName}, falling back to fullscreen`);
    return await takeFullscreenScreenshot(stepFolder);
  }

  // Convert directly to base64
  const screenshotBase64 = image.toPNG().toString("base64");
  
  // Save to disk for logging
  const screenshotPath = path.join(
    stepFolder,
    `screenshot-${encodeURI(window.name)}.png`
  );
  fs.writeFileSync(screenshotPath, Buffer.from(screenshotBase64, "base64"));
  
  logWithElapsed(
    "takeAppWindowScreenshot",
    `Saved window screenshot: ${screenshotPath}`
  );

  return screenshotBase64;
}
